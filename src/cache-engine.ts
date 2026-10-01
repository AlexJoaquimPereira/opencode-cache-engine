import type { Plugin } from "@opencode-ai/plugin"
import type { Event, Message, Part } from "@opencode-ai/sdk"
import {
  DEFAULT_CONFIG_PATH,
  DIGEST_TEMPLATE,
  affinityTelemetryFields,
  createRecorder,
  detectReasoningIssues,
  digestDecision,
  ensureMetricsDir,
  glmHitRatio,
  gptCacheKeyFor,
  gptCacheOptionsDelta,
  hitRatePct,
  loadConfig,
  mimoHitRate,
  mimoSessionIdFor,
  nextProcessedCursor,
  observeReasoningEffort,
  policyEnabled,
  prefixChangeReasons,
  providerChangeEvent,
  reasoningEffortFromOptions,
  reasoningIssueReasons,
  relocateVolatileEnvBlock,
  resolveCacheRootSync,
  scanPage,
  shapeDiff,
  shapeFieldDiffs,
  shouldAggregate,
  systemShapeHashes,
  toolFingerprint,
  toolWireFingerprint,
} from "./cache-engine-core.mjs"
import { explainPolicyResolution, resolveRuntimePolicy } from "./cache-policy-core.mjs"

// ---------------------------------------------------------------------------
// cache-engine
//
// Provider-aware prompt-cache observability + conservative cache-shape
// preservation for ONE OpenCode TUI across four model families:
//
//   DeepSeek V4.1 Flash  -> pure passive. >99.66% hit rate is preserved by never
//                         mutating system/options/requests. Observability only.
//   GPT-5.6 Luna       -> ACTIVE cache-control: a stable session-derived
//                         prompt_cache_key + prompt_cache_options (implicit,
//                         ttl 30m) injected via the chat.params hook, which is
//                         the exact point where the runtime's own options are
//                         assembled (request.ts). Never sent to older models.
//   GLM-5.3 Flash      -> input-shape strategy: relocate the volatile env block
//                         (per-day date) to the tail of the system prompt so a
//                         date change only invalidates the suffix, keep tool +
//                         history stable, and INSTRUMENT preserved-thinking
//                         integrity (duplicate/reorder/modified reasoning). No
//                         invented cache key (Z.ai exposes none).
//   MiMo-V2.6          -> prefix stability + provider diagnostics. The safe
//                         env-block relocation is applied (stabilizeSystem).
//                         For actual OpenRouter requests only, chat.headers
//                         adds the deterministic x-session-id unless an
//                         explicit case-insensitive value already exists in
//                         model/plugin headers. No MiMo cache key/breakpoint/
//                         TTL is invented.
//
// The engine remains conservative: it observes, hashes, compares, records,
// appends a compaction continuation template, and (for GPT-5.6 only) injects
// documented cache options. It never rewrites message history, reorders tools,
// or alters user content. DeepSeek and neutral models are byte-untouched.
// MiMo/GLM only relocate the identifiable volatile env block, content-preserving.
//
// IMPORTANT (terminology): local hashes describe the *observed* prefix shape.
// A changed hash means request bytes changed; it is NOT proof the provider's
// cache key changed or that a cache miss occurred. Provider-reported cache
// token counts are authoritative; hashes are diagnostics only. For MiMo, the
// authoritative cache signal is provider-reported cached_tokens.
// ---------------------------------------------------------------------------

const TOOL_FETCH_TTL_MS = 1500
const REASONING_SEEN_CAP = 5000
const ROOT_HOPS_MAX = 16
const ROOT_CACHE_TTL_MS = 30_000
// Upper bound on remembered policy resolutions per session, so alternation
// between models cannot grow the set (or the telemetry file) without limit.
const RESOLUTION_KEYS_CAP = 16

// V1 SDK (OpenCode 1.18.33): client.session.messages takes { path: { id } } and
// returns { data?: Array<{ info: Message; parts: Part[] }> }. There is no
// `before` parameter and no documented cursor header; OpenCode paginates
// internally when no limit is supplied, so a single call returns the history.
type MessagePage = { info: Message; parts: Part[] }
type SessionMessagesResult = { data?: MessagePage[] }

type ToolDef = { id: string; description: string; parameters: unknown }

type Shape = {
  fullSystemHash: string | null
  stableSystemPrefixHash: string | null
  volatileSystemSuffixHash: string | null
  semanticToolsHash: string | null
  wireToolsHash: string | null
  toolCount: number | null
}

// Resolved runtime policy (the registry's runtime descriptor). `policy` is the
// legacy telemetry/state string emitted by the pre-v0.4.0 classifier.
type PolicyRuntime = {
  policy: string
  isNeutral: boolean
  gptCacheMetadata: boolean
  envRelocation: "glm" | "mimo" | null
  thinkingIntegrity: boolean
  cacheRatio: "glm" | "mimo" | null
  providerChange: "glm" | "mimo" | null
  prefixDiagnostics: boolean
  openRouterAffinity: boolean
}

type ModelInfo = { family: string; providerID: string; modelID: string; caps: PolicyRuntime }

type ToolCache = { semanticToolsHash: string | null; wireToolsHash: string | null }

type CacheRoot = { root: string; hops: number; source: string }

type EffortObs = { known: boolean; value: string | null }

type SessionState = {
  shape: Shape | null
  baselineSystem: string | null
  modelInfo: ModelInfo | null
  tools: ToolCache | null
  toolCount: number | null
  lastToolFetchAt: number | null
  lastProcessedMessageID: string | null
  read: number
  write: number
  input: number
  usageSamples: number
  pendingInsert: boolean
  gptInjected: boolean
  cacheRoot: CacheRoot | null
  cacheRootAt: number | null
  reasoningSeen: Map<string, number>
  reasoningLastSeq: string[] | null
  mimoProvider: { providerID: string; modelID: string } | null
  glmProvider: { providerID: string; modelID: string } | null
  resolutionKeys: Set<string>
}

const emptyShape = (): Shape => ({
  fullSystemHash: null,
  stableSystemPrefixHash: null,
  volatileSystemSuffixHash: null,
  semanticToolsHash: null,
  wireToolsHash: null,
  toolCount: null,
})

type ChatParamsModel = {
  providerID: string
  id?: string
  api?: { id?: string; npm?: string }
  headers?: Record<string, string>
  name?: string
}

export const CacheEngine: Plugin = async ({ client, directory }) => {
  const cfg = loadConfig({ configPath: DEFAULT_CONFIG_PATH, env: process.env })
  if (!cfg.enabled) return {}
  ensureMetricsDir(cfg.metricsFile)
  const rec = createRecorder(cfg.metricsFile)

  const sessions = new Map<string, SessionState>()
  const get = (sid: string): SessionState => {
    let s = sessions.get(sid)
    if (!s) {
      s = {
        shape: null,
        baselineSystem: null,
        modelInfo: null,
        tools: null,
        toolCount: null,
        lastToolFetchAt: null,
        lastProcessedMessageID: null,
        read: 0,
        write: 0,
        input: 0,
        usageSamples: 0,
        pendingInsert: true,
        gptInjected: false,
        cacheRoot: null,
        cacheRootAt: null,
        reasoningSeen: new Map(),
        reasoningLastSeq: null,
        mimoProvider: null,
        glmProvider: null,
        resolutionKeys: new Set(),
      }
      sessions.set(sid, s)
    }
    return s
  }

  // session.get client call: the v1 plugin client only accepts { path: { id } }.
  // NOTE: methods are prototype methods using `this._client`, so we must invoke
  // them as members (not detach them) or bind the receiver explicitly.
  const sessionGet = (opts: { path: { id: string } }): Promise<{ data?: { parentID?: string | null } }> =>
    (client.session.get as unknown as (o: { path: { id: string } }) => Promise<{ data?: { parentID?: string | null } }>).call(
      client.session,
      opts,
    )

  // Resolve the cache root for a session by climbing the canonical parentID
  // chain via client.session.get. Memoized per session with a short TTL so the
  // per-request path stays cheap. On any lookup failure we fall back to the
  // session itself as root and surface the reason in telemetry.
  const resolveCacheRoot = async (sid: string): Promise<CacheRoot> => {
    const s = get(sid)
    const now = Date.now()
    if (s.cacheRoot && s.cacheRootAt != null && now - s.cacheRootAt < ROOT_CACHE_TTL_MS) return s.cacheRoot
    try {
      const parentOf = async (id: string): Promise<string | null> => {
        const res = await sessionGet({ path: { id } })
        return res?.data?.parentID && res.data.parentID !== id ? res.data.parentID : null
      }
      // build a synchronous chain resolver fed by async lookups, hop by hop
      const edges = new Map<string, string | null>()
      let cur = sid
      for (let i = 0; i < ROOT_HOPS_MAX; i++) {
        if (edges.has(cur)) break
        const parent = await parentOf(cur)
        edges.set(cur, parent)
        if (parent == null) break
        cur = parent
      }
      const lookup = (id: string): string | null | undefined => {
        // only consult edges we already resolved; unknown -> undefined (stop)
        return edges.has(id) ? edges.get(id) : undefined
      }
      const resolved = resolveCacheRootSync(sid, lookup, { maxHops: ROOT_HOPS_MAX })
      s.cacheRoot = resolved
      s.cacheRootAt = now
      if (resolved.source !== "self") {
        log("info", "cache root resolved", { sid, root: resolved.root, source: resolved.source, hops: resolved.hops })
      }
      return resolved
    } catch (e) {
      rec.record({ kind: "telemetry-error", ts: Date.now(), error: String(e) })
      const fallback: CacheRoot = { root: sid, hops: 0, source: "fallback" }
      s.cacheRoot = fallback
      s.cacheRootAt = now
      return fallback
    }
  }

  // Reasoning-effort diagnostics are per cache root: the value is a property of
  // the request configuration, but forks share the cache root's key namespace.
  const effortByRoot = new Map<string, EffortObs>()
  const observeEffort = (root: string, current: EffortObs) => {
    const prev = effortByRoot.get(root) ?? null
    const step = observeReasoningEffort(prev, current)
    effortByRoot.set(root, step.state)
    return step
  }

  // Best-effort structured log; must never break a request.
  const log = (level: "debug" | "info" | "warn", message: string, extra: Record<string, unknown>): void => {
    void client?.app
      ?.log({ body: { service: "cache-engine", level, message, extra } })
      .catch(() => {})
  }

  // Policy-resolution telemetry (v0.4.6). Records WHY a model resolved to the
  // policy it did, so a newly released or renamed model becomes visible for
  // later review instead of silently inheriting (or silently missing) behavior.
  //
  // It records only registry/resolver facts: match category and kind, the
  // registry match reason, creator/family/policy, whether a model-specific
  // overlay was applied or skipped as unvalidated, and whether the provider
  // identity is known. It never records prompt/system/tool content, credentials,
  // authorization headers, or the raw x-session-id value.
  //
  // Emitted once per distinct resolution per session (not per request), so a new
  // model in an existing session is still reported without flooding the file.
  // A session can legitimately alternate between models (e.g. the main model
  // and a small title/summary model), so every distinct resolution is remembered
  // rather than only the most recent one; the set is bounded and reset past the
  // cap to keep memory and file size predictable.
  const recordPolicyResolution = (sid: string, model: unknown): void => {
    try {
      const r = explainPolicyResolution(model as Parameters<typeof explainPolicyResolution>[0])
      const key = `${r.matchCategory}|${r.matchKind}|${r.family}|${r.matchReason ?? ""}|${r.provider ?? ""}|${r.model ?? ""}`
      const s = get(sid)
      if (s.resolutionKeys.has(key)) return
      if (s.resolutionKeys.size >= RESOLUTION_KEYS_CAP) s.resolutionKeys.clear()
      s.resolutionKeys.add(key)
      rec.record({
        kind: "policy-resolution",
        sid,
        ts: Date.now(),
        matchCategory: r.matchCategory,
        matchKind: r.matchKind,
        matchReason: r.matchReason,
        matchedId: r.matchedId,
        creator: r.creator,
        family: r.family,
        policy: r.policy,
        isNeutral: r.isNeutral,
        baselineId: r.baselineId,
        overlays: r.overlays,
        overlayApplied: r.overlayApplied,
        overlaySkipped: r.overlaySkipped,
        overlaySkippedReason: r.overlaySkippedReason,
        overlaySkippedCandidates: r.overlaySkippedCandidates,
        providerIdentityKnown: r.providerIdentityKnown,
        provider: r.provider,
        model: r.model,
        transport: r.transportKind,
      })
    } catch (e) {
      rec.record({ kind: "telemetry-error", ts: Date.now(), error: String(e) })
    }
  }

  // Latch the first NON-neutral model observed for a session. Title/summary
  // requests may use the small model; we never let that overwrite a real
  // gpt56/glm53/deepseek classification once established.
  const rememberModel = (sid: string, model: ChatParamsModel | undefined): ModelInfo | null => {
    if (!model) return null
    // Single runtime source of policy classification: the registry resolver.
    const caps = resolveRuntimePolicy(model) as PolicyRuntime
    const s = get(sid)
    const info: ModelInfo = {
      family: caps.policy,
      providerID: String(model.providerID ?? ""),
      modelID: String(model.api?.id ?? model.id ?? ""),
      caps,
    }
    if (s.modelInfo == null || (s.modelInfo.caps.isNeutral && !caps.isNeutral)) {
      s.modelInfo = info
      // A title/summary request (neutral small model) may have established the
      // system baseline first. Its "powered by the model named ..." env line
      // differs from the real model's, so re-baseline on upgrade.
      if (s.baselineSystem !== null && !caps.isNeutral) {
        s.baselineSystem = null
        s.shape = null
      }
    }
    return s.modelInfo
  }

  // Fetch tool definitions (registry order, closest deterministic pre-wire
  // representation available to a plugin). Computes BOTH fingerprints.
  const refreshTools = async (sid: string, s: SessionState, model: { providerID: string; id?: string; api?: { id?: string } } | undefined): Promise<void> => {
    const providerID = model?.providerID
    const apiID = model?.api?.id ?? model?.id
    if (!providerID || !apiID) {
      s.tools = { semanticToolsHash: null, wireToolsHash: null }
      return
    }
    const now = Date.now()
    if (s.lastToolFetchAt != null && now - s.lastToolFetchAt < TOOL_FETCH_TTL_MS) return
    try {
      const res = await (client.tool.list as unknown as (opts: {
        query: { directory: string; provider: string; model: string }
      }) => Promise<{ data?: ToolDef[] }>)({
        query: { directory, provider: providerID, model: apiID },
      })
      s.lastToolFetchAt = now
      s.tools = {
        semanticToolsHash: toolFingerprint(res?.data),
        wireToolsHash: toolWireFingerprint(res?.data),
      }
      s.toolCount = Array.isArray(res?.data) ? res.data.length : null
    } catch {
      // Unknown tool shape: leave fingerprints null (no retry TTL) so a
      // transient failure is never misreported as a tool change.
      s.tools = { semanticToolsHash: null, wireToolsHash: null }
      s.toolCount = null
    }
  }

  // Aggregate cache tokens + reasoning-integrity signals from all messages
  // newer than the last-processed boundary. One SDK call returns the history;
  // OpenCode paginates internally when no limit is supplied.
  const collectUsage = async (sid: string): Promise<void> => {
    try {
      // V1.18.33 shape: { path: { id } } -> { data?: MessagePage[] }. Methods use
      // `this._client`, so invoke with .call() to preserve the receiver binding.
      const listMessages = (opts: { path: { id: string } }): Promise<SessionMessagesResult> =>
        (client.session.messages as unknown as (o: { path: { id: string } }) => Promise<SessionMessagesResult>).call(client.session, opts)
      const s = get(sid)
      const startCursor = s.lastProcessedMessageID
      const res = await listMessages({ path: { id: sid } })
      const messages = res?.data ?? []
      const scanned = scanPage(messages, startCursor)
      const read = scanned.read
      const write = scanned.write
      const input = scanned.input
      const count = scanned.count
      const reachedStart = scanned.reachedStart
      const reasoningNewestFirst = scanned.reasoning

      s.lastProcessedMessageID = nextProcessedCursor(messages, startCursor)

      const caps = s.modelInfo?.caps
      const glmIntegrity =
        caps?.thinkingIntegrity === true &&
        policyEnabled(cfg, caps.policy) &&
        cfg.policies?.[caps.policy]?.preserveThinkingIntegrity === true

      if (glmIntegrity && reasoningNewestFirst.length > 0) {
        // messages arrive newest-first; process oldest->newest so `seen` grows
        // naturally and `lastSeq` reflects the previous assistant reasoning.
        const chronological = [...reasoningNewestFirst].reverse()
        for (const { id, hashes } of chronological) {
          // within-message duplicate reasoning (duplicated reasoning blocks)
          const issues = detectReasoningIssues(hashes, s.reasoningLastSeq, s.reasoningSeen)
          // `seen` holds hashes from EARLIER messages; refresh it AFTER the check.
          if (issues.crossDuplicates > 0 || issues.withinDuplicates > 0 || issues.reordered || issues.modified) {
            const rReasons = reasoningIssueReasons(issues)
            rec.record({
              kind: "reasoning-integrity",
              sid,
              ts: Date.now(),
              provider: s.modelInfo?.providerID,
              model: s.modelInfo?.modelID,
              policy: s.modelInfo?.family,
              reason: rReasons[0] ?? "reasoning_changed",
              reasons: rReasons,
              msgId: id,
              withinDuplicates: issues.withinDuplicates,
              crossDuplicates: issues.crossDuplicates,
              reordered: issues.reordered,
              modified: issues.modified,
            })
          }
          for (const h of new Set(hashes)) {
            s.reasoningSeen.set(h, (s.reasoningSeen.get(h) ?? 0) + 1)
          }
          if (s.reasoningSeen.size > REASONING_SEEN_CAP) {
            // bounded bookkeeping: drop the oldest half of the map
            const drop = [...s.reasoningSeen.keys()].slice(0, Math.floor(s.reasoningSeen.size / 2))
            for (const k of drop) s.reasoningSeen.delete(k)
          }
          if (hashes.length > 0) s.reasoningLastSeq = hashes
        }
      }

      if (shouldAggregate(count, read, write)) {
        s.read += read
        s.write += write
        s.input += input
        s.usageSamples += count
        const recFields: Record<string, unknown> = {
          kind: "usage",
          sid,
          ts: Date.now(),
          read,
          write,
          input,
          messages: count,
          sampleHitRate: hitRatePct(read, write),
          cumulative: { read: s.read, write: s.write },
          cumulativeHitRate: hitRatePct(s.read, s.write),
          cursor: s.lastProcessedMessageID,
        }
        if (s.modelInfo) {
          recFields.provider = s.modelInfo.providerID
          recFields.model = s.modelInfo.modelID
          recFields.policy = s.modelInfo.family
        }
        if (caps?.cacheRatio === "glm") {
          recFields.promptTokens = read + write + input
          recFields.glmHitRate = glmHitRatio(read, write, input)
        }
        if (caps?.cacheRatio === "mimo") {
          // Provider-reported cached tokens / total prompt tokens. The runtime's
          // `input` is the non-cached prompt input and `cache.read` is the
          // cached prompt input, so total prompt tokens are derived as read +
          // input (cache.write is a separate accounting bucket). No cache-write
          // value is fabricated; the ratio is null when prompt tokens are 0.
          const promptTokens = read + input
          recFields.promptTokens = promptTokens
          recFields.cachedTokens = read
          recFields.cacheHitRate = mimoHitRate(read, promptTokens)
          if (cfg.policies?.[caps.policy]?.stickySession === true) {
            recFields.stickySessionId = mimoSessionIdFor(sid)
          }
          // Prefer the latest live provider identity over the latched one.
          if (s.mimoProvider) {
            recFields.provider = s.mimoProvider.providerID
            recFields.model = s.mimoProvider.modelID
          }
        }
        if (caps?.gptCacheMetadata === true && s.gptInjected) {
          recFields.keyStrategy = "session"
          recFields.mode = cfg.policies?.[caps.policy]?.mode
          recFields.ttl = cfg.policies?.[caps.policy]?.ttl
        }
        rec.record(recFields)
      } else {
        // No cache data observed for new messages (or none at all). We
        // deliberately do NOT emit a zero-valued usage record here.
        log("debug", "idle: no new assistant usage", {
          sid,
          messagesScanned: messages.length,
          newAssistantMessages: count,
          reachedBoundary: reachedStart,
        })
      }
    } catch (e) {
      rec.record({ kind: "telemetry-error", ts: Date.now(), error: String(e) })
    }
  }

  const prefixFields = (shape: Shape, toolCount: number | null) => ({
    fullSystemHash: shape.fullSystemHash,
    stableSystemPrefixHash: shape.stableSystemPrefixHash,
    volatileSystemSuffixHash: shape.volatileSystemSuffixHash,
    semanticToolsHash: shape.semanticToolsHash,
    wireToolsHash: shape.wireToolsHash,
    toolCount,
    // legacy aliases for backward compatibility with earlier dashboards
    systemHash: shape.fullSystemHash,
    toolsHash: shape.semanticToolsHash,
  })

  return {
    // Per-request model context: latch family/model for telemetry and, for
    // GPT-5.6, inject the cache-root-derived prompt-cache key + implicit cache
    // options at the exact point the runtime assembles the outgoing options.
    //
    // Cache root affinity: a forked/child session inherits the topmost
    // ancestor's key (via Session.parentID chain) rather than the raw session
    // id, so a fork that shares the parent's prompt prefix reuses the parent's
    // GPT cache. Compaction requests (agent === "compaction") for the same root
    // use a deterministic separate namespace (<root>:compact) so a compaction
    // cache write never interferes with the useful live-session cache.
    //
    // MiMo-V2.6 / GLM-5.3 + OpenRouter session affinity. Gate on the actual
    // OpenCode provider identity as well as the detected family; a matching
    // model slug on a direct endpoint is not sufficient. The runtime merges
    // model.headers before this hook's output, so preserve a case-insensitive
    // user/model or earlier-plugin x-session-id rather than silently overwriting
    // it. Otherwise add the deterministic ID derived from the logical session.
    "chat.headers": async (input, output) => {
      try {
        const model = input.model as unknown as ChatParamsModel
        const providerID = String(model?.providerID ?? "")
        const caps = resolveRuntimePolicy(model) as PolicyRuntime
        if (!caps.openRouterAffinity) return
        const family = caps.policy

        const hasSessionIDHeader = (headers?: Record<string, string>) =>
          Object.keys(headers ?? {}).some((name) => name.toLowerCase() === "x-session-id")
        let headerSource = "not_applicable"
        if (providerID === "openrouter") {
          if (hasSessionIDHeader(model?.headers) || hasSessionIDHeader(output.headers)) {
            headerSource = "preexisting"
          } else {
            const sessionID = mimoSessionIdFor(input.sessionID)
            if (sessionID) {
              output.headers["x-session-id"] = sessionID
              headerSource = "cache_engine"
            } else {
              headerSource = "unavailable"
            }
          }
        }

        const telemetry = affinityTelemetryFields(family, providerID, headerSource)
        if (telemetry) {
          rec.record({
            kind: "boundary",
            sid: input.sessionID,
            ts: Date.now(),
            policy: family,
            provider: telemetry.provider,
            model: String(model?.api?.id ?? model?.id ?? "") || null,
            ...telemetry,
          })
        }
      } catch (e) {
        rec.record({ kind: "telemetry-error", ts: Date.now(), error: String(e) })
      }
    },

    "chat.params": async (input, output) => {
      try {
        const info = rememberModel(input.sessionID, input.model as unknown as ChatParamsModel)
        // Record how this model was classified before any policy branch below.
        // The MiMo/GLM provider-observation branches return early, so this call
        // sits ahead of them to cover every request.
        recordPolicyResolution(input.sessionID, input.model)
        const family = info?.family
        const caps = info?.caps

        // ---- MiMo-V2.6: provider-switch diagnostics (telemetry only) ---------
        // MiMo cache lives at the provider side, so a provider change within one
        // OpenCode session can silently invalidate it. We record identity on every
        // MiMo request and emit a diagnostic when the OpenCode providerID changes.
        // This never forces or overrides provider routing.
        // NOTE: OpenRouter's *upstream* provider selection (e.g. xiaomi/fp8) is
        // not exposed to plugins; only the OpenCode providerID/modelID are
        // observable here.
        if (caps?.providerChange === "mimo" && policyEnabled(cfg, caps.policy) && info) {
          // Use the LIVE model identity (not the latched one) so a provider
          // switch within the session is actually observable.
          const live = input.model as unknown as ChatParamsModel
          const cur = {
            providerID: String(live?.providerID ?? ""),
            modelID: String(live?.api?.id ?? live?.id ?? ""),
          }
          if (cur.providerID) {
            const s = get(input.sessionID)
            const ev = providerChangeEvent(s.mimoProvider, cur)
            if (ev.changed) {
              const sticky =
                cfg.policies?.[caps.policy]?.stickySession === true
                  ? { stickySessionId: mimoSessionIdFor(input.sessionID) }
                  : {}
              rec.record({
                kind: "boundary",
                sid: input.sessionID,
                ts: Date.now(),
                reason: "mimo_provider_changed",
                policy: caps.policy,
                from: ev.from,
                to: ev.to,
                ...sticky,
                note: "OpenCode providerID changed; upstream routing is not plugin-visible",
              })
            }
            s.mimoProvider = cur
          }
          return
        }

        // ---- GLM-5.3 provider identity observation (telemetry only) ----------
        if (caps?.providerChange === "glm" && policyEnabled(cfg, caps.policy) && info) {
          const live = input.model as unknown as ChatParamsModel
          const cur = {
            providerID: String(live?.providerID ?? ""),
            modelID: String(live?.api?.id ?? live?.id ?? ""),
          }
          if (cur.providerID) {
            const s = get(input.sessionID)
            const ev = providerChangeEvent(s.glmProvider, cur)
            if (ev.changed) {
              rec.record({
                kind: "boundary",
                sid: input.sessionID,
                ts: Date.now(),
                reason: "glm_provider_changed",
                policy: caps.policy,
                from: ev.from,
                to: ev.to,
                note: "OpenCode providerID changed; provider-specific upstream routing is not plugin-visible",
              })
            }
            s.glmProvider = cur
          }
          return
        }

        if (!(caps?.gptCacheMetadata === true && policyEnabled(cfg, caps.policy))) {
          // DeepSeek / GLM / neutral: nothing to inject. GLM has no cache-key API;
          // DeepSeek caching is fully passive; we never mutate requests for them.
          return
        }
        const gpol = cfg.policies?.[caps.policy]
        const applyRoot = gpol?.cacheRootKey !== false
        const compaction = input.agent === "compaction"
        const isolated = compaction && gpol?.compactionCacheIsolation === true
        const enableKey = gpol?.promptCacheKey !== false

        // cache root resolution (only when used for key/effort baseline)
        const rootRes = applyRoot || gpol?.reasoningEffortDiagnostics === true ? await resolveCacheRoot(input.sessionID) : null
        const keyBase = applyRoot ? rootRes!.root : input.sessionID
        const desiredKey = enableKey ? gptCacheKeyFor(keyBase, { compaction: isolated }) : null

        // ---- reasoning-effort diagnostics (observe only, never change) ----
        // The effort setting is a request-config property; we track it per
        // cache root so forks compare against the same lineage baseline.
        if (gpol?.reasoningEffortDiagnostics === true) {
          const cur = reasoningEffortFromOptions(output.options)
          const effKey = applyRoot ? rootRes!.root : input.sessionID
          const step = observeEffort(effKey, cur)
          if (step.event === "change") {
            rec.record({
              kind: "boundary",
              sid: input.sessionID,
              ts: Date.now(),
              reason: "gpt_reasoning_effort_changed",
              provider: info.providerID,
              model: info.modelID,
              policy: family,
              cacheRoot: effKey,
              cacheRootSource: applyRoot ? rootRes!.source : "self",
              before: step.previous?.known ? step.previous.value : null,
              after: step.current?.known ? step.current.value : null,
            })
          }
        }

        if (!enableKey || !desiredKey) return

        // ---- cache-root affinity + compaction isolation key injection --------
        const already = output.options.promptCacheKey
        if (applyRoot && (already === undefined || already !== desiredKey)) {
          output.options.promptCacheKey = desiredKey
        }
        const optsDelta = gptCacheOptionsDelta(output.options, {
          key: desiredKey,
          mode: gpol?.mode,
          ttl: gpol?.ttl,
        })
        if (Object.keys(optsDelta).length > 0) Object.assign(output.options, optsDelta)

        const s = get(input.sessionID)
        const cacheCtxExtra = applyRoot
          ? {
              cacheRoot: rootRes!.root,
              cacheRootSource: rootRes!.source,
              cacheRootHops: rootRes!.hops,
            }
          : {
              cacheRoot: input.sessionID,
              cacheRootSource: "session" as const,
            }

        if (!s.gptInjected) {
          s.gptInjected = true

          rec.record({
            kind: "cache-options",
            sid: input.sessionID,
            ts: Date.now(),
            policy: caps.policy,
            provider: info.providerID,
            model: info.modelID,
            keyStrategy: applyRoot ? "cache-root" : "session",
            ...cacheCtxExtra,
            compaction,
            namespace: isolated ? "compact" : "live",
            key: desiredKey,
            options: { ...(output.options.promptCacheOptions ?? {}) },
          })

          if (applyRoot && rootRes!.source === "parent" && rootRes!.hops > 0) {
            rec.record({
              kind: "boundary",
              sid: input.sessionID,
              ts: Date.now(),
              reason: "gpt_session_fork",
              provider: info.providerID,
              model: info.modelID,
              policy: family,
              ...cacheCtxExtra,
              hops: rootRes!.hops,
            })
          }
        }

        if (compaction) {
          rec.record({
            kind: "boundary",
            sid: input.sessionID,
            ts: Date.now(),
            reason: "gpt_compaction",
            provider: info.providerID,
            model: info.modelID,
            policy: family,
            ...cacheCtxExtra,
            namespace: isolated ? "compact" : "live",
            key: desiredKey,
          })
        }
      } catch (e) {
        rec.record({ kind: "telemetry-error", ts: Date.now(), error: String(e) })
      }
    },

    event: async ({ event }: { event: Event }) => {
      try {
        if (event.type === "session.idle") {
          void collectUsage(event.properties.sessionID)
          return
        }
        if (event.type === "session.compacted") {
          const sid = event.properties.sessionID
          const s = get(sid)
          s.pendingInsert = true
          rec.record({
            kind: "compaction",
            sid,
            ts: Date.now(),
            reason: "compaction",
            usageSamples: s.usageSamples,
            cumulative: { read: s.read, write: s.write },
            ...(s.cacheRoot ? { cacheRoot: s.cacheRoot.root, cacheRootSource: s.cacheRoot.source } : {}),
            ...(s.modelInfo
              ? { provider: s.modelInfo.providerID, model: s.modelInfo.modelID, policy: s.modelInfo.family }
              : {}),
          })
          return
        }
      } catch (e) {
        rec.record({ kind: "telemetry-error", ts: Date.now(), error: String(e) })
      }
    },

    "experimental.chat.system.transform": async (input, output) => {
      try {
        const sid = input.sessionID
        if (!sid) return
        const model = input.model as unknown as ChatParamsModel
        rememberModel(sid, model)
        const s = get(sid)
        const caps = s.modelInfo?.caps

        // ---- GLM-5.3 / MiMo-V2.6 input-shape stabilization ------------------
        // Relocate the identifiable volatile env block (per-day date) to the
        // tail of the single system string, content-preserving, ONLY when the
        // resolved runtime policy opts into system stabilization and the block
        // markers are present exactly. Never touches other content/order; never
        // applied to other families. The runtime passes a single-element system
        // array (verified against the installed runtime), so no generic
        // reordering is involved.
        //
        // In-place mutation note: request.ts keeps using its own local `system`
        // array after the hook (the trigger's returned output is ignored), so
        // reassigning `output.system = [...]` would be lost. We rewrite the
        // single element in place instead.
        let systemText = output.system.join("\n")
        const envVariant = caps?.envRelocation ?? null
        const stabilize =
          envVariant !== null &&
          policyEnabled(cfg, caps!.policy) &&
          cfg.policies?.[caps!.policy]?.stabilizeSystem === true
        if (stabilize && output.system.length === 1) {
          const rel = relocateVolatileEnvBlock(output.system[0])
          if (rel.changed) {
            output.system[0] = rel.text
            systemText = rel.text
            if (envVariant === "mimo") {
              log("debug", "mimo system env block relocated to suffix", { sid })
              rec.record({
                kind: "boundary",
                sid,
                ts: Date.now(),
                reason: "mimo_system_env_relocated",
                policy: caps!.policy,
                provider: s.modelInfo?.providerID,
                model: s.modelInfo?.modelID,
              })
            } else {
              log("debug", "glm system env block relocated to suffix", { sid })
            }
          }
        }

        const cur: Shape = { ...emptyShape() }
        const curHashes = systemShapeHashes(s.baselineSystem ?? systemText, systemText)
        cur.fullSystemHash = curHashes.fullSystemHash
        cur.stableSystemPrefixHash = curHashes.stableSystemPrefixHash
        cur.volatileSystemSuffixHash = curHashes.volatileSystemSuffixHash
        if (s.baselineSystem === null) s.baselineSystem = systemText
        await refreshTools(sid, s, model as { providerID: string; id?: string; api?: { id?: string } } | undefined)
        cur.semanticToolsHash = s.tools?.semanticToolsHash ?? null
        cur.wireToolsHash = s.tools?.wireToolsHash ?? null
        cur.toolCount = s.toolCount
        const toolCount = s.toolCount

        const cacheCtx = (root: CacheRoot | null) =>
          root ? { cacheRoot: root.root, cacheRootSource: root.source, cacheRootHops: root.hops } : {}

        const prev = s.shape
        if (prev === null) {
          // First observation for this session: establish the baseline. The
          // absence of a previous hash is not a change.
          s.shape = cur
          rec.record({
            kind: "prefix-observation",
            sid,
            ts: Date.now(),
            ...(s.modelInfo
              ? { provider: s.modelInfo.providerID, model: s.modelInfo.modelID, policy: s.modelInfo.family }
              : {}),
            ...cacheCtx(s.cacheRoot),
            ...prefixFields(cur, toolCount),
            note: "initial",
          })
          return
        }

        const changed = shapeDiff(prev, cur)
        if (changed.length > 0) {
          const granular = shapeFieldDiffs(prev, cur, [
            "fullSystemHash",
            "stableSystemPrefixHash",
            "volatileSystemSuffixHash",
            "semanticToolsHash",
            "wireToolsHash",
          ])
          const reasons = prefixChangeReasons(granular)
          const before: Record<string, unknown> = {}
          const after: Record<string, unknown> = {}
          for (const f of granular) {
            before[f] = (prev as Record<string, unknown>)[f]
            after[f] = (cur as Record<string, unknown>)[f]
          }
          // richer tool diagnostics: does this change carry a tool-count shift,
          // a semantic tool change, and/or a wire (ordering/serialization) change?
          const toolsChanged = granular.includes("semanticToolsHash") || granular.includes("wireToolsHash")
          const semanticChanged = granular.includes("semanticToolsHash")
          const wireChanged = granular.includes("wireToolsHash")
          const prevCount = prev.toolCount ?? null
          rec.record({
            kind: "prefix-change",
            sid,
            ts: Date.now(),
            ...(s.modelInfo
              ? { provider: s.modelInfo.providerID, model: s.modelInfo.modelID, policy: s.modelInfo.family }
              : {}),
            ...cacheCtx(s.cacheRoot),
            dimensions: changed,
            changedFields: granular,
            reasons,
            before,
            after,
            ...(toolsChanged
              ? { toolCount, prevToolCount: prevCount, semanticToolsChanged: semanticChanged, wireToolsChanged: wireChanged }
              : {}),
          })
          // MiMo-specific explicit diagnostic: the STABLE prefix changed (not
          // just the relocated volatile env suffix). Reported only; the new
          // content is never overwritten with a stale snapshot.
          if (caps?.prefixDiagnostics === true && reasons.includes("system_stable_prefix_changed")) {
            rec.record({
              kind: "boundary",
              sid,
              ts: Date.now(),
              reason: "mimo_system_prefix_changed",
              policy: caps!.policy,
              provider: s.modelInfo?.providerID,
              model: s.modelInfo?.modelID,
              changedFields: granular,
              reasons,
            })
          }
          if (cfg.logPrefixChanges) {
            log("warn", "observed prefix shape change", {
              sid,
              dimensions: changed,
              changedFields: granular,
              reasons,
            })
          }
        }
        s.shape = cur
      } catch (e) {
        rec.record({ kind: "telemetry-error", ts: Date.now(), error: String(e) })
      }
    },

    "experimental.session.compacting": async (input, output) => {
      try {
        const s = get(input.sessionID)
        if (!digestDecision({ compactTemplate: cfg.compactTemplate, pendingInsert: s.pendingInsert })) return
        output.context.push(DIGEST_TEMPLATE)
        s.pendingInsert = false
      } catch {
        /* best-effort */
      }
    },
  }
}
