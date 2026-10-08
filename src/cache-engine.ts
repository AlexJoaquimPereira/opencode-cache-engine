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
  gptCacheOptionFieldNames,
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
// Bound on remembered per-identity tool-fetch timestamps within one session.
const TOOL_FETCH_CACHE_CAP = 64
const REASONING_SEEN_CAP = 5000
const ROOT_HOPS_MAX = 16
const ROOT_CACHE_TTL_MS = 30_000
// Deleted-session tombstones (N4): time-based so a freshly-deleted id is never
// evicted by count pressure before queued/idle work can drain; the count cap is
// only a secondary memory bound.
const DELETED_SESSIONS_TTL_MS = 10 * 60_000
const DELETED_SESSIONS_CAP = 8192
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
  grokCacheAffinity: boolean
  grokRouteAware: boolean
  museCacheAffinity: boolean
  museRouteAware: boolean
  museCacheRetention: string | null
  minimaxRouteAware: boolean
  minimaxCacheWriteBilled: boolean
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
  // Per-identity tool-fetch cache: each provider+model keeps its own TTL window
  // AND its own fingerprints, so a suppressed repeat restores the correct values
  // instead of leaving another identity's in the per-session slot. Bounded
  // (oldest identity evicted past the cap).
  toolFetch: Map<string, { at: number; tools: ToolCache; toolCount: number | null }>
  lastProcessedMessageID: string | null
  lastProcessedAt: number | null
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
  // Per-session tail of the background usage-collection chain (N1): serializes
  // concurrent `session.idle` collections so they never capture the same cursor.
  collectChain: Promise<void>
  // Set by the session.deleted handler on the object it removes. Queued/async
  // work holds this exact object and skips if it was deleted, so the guard does
  // NOT depend on the bounded tombstone set (N4).
  deleted: boolean
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
  // Tombstones for explicitly deleted sessions (N4): a late or queued
  // `session.idle` must not resurrect per-session state after
  // `session.deleted`. Time-based (see TTL); a genuine new request for the same
  // id clears the tombstone (see rememberModel).
  const deletedSessions = new Map<string, number>()
  const isDeleted = (sid: string): boolean => {
    const at = deletedSessions.get(sid)
    if (at == null) return false
    if (Date.now() - at > DELETED_SESSIONS_TTL_MS) {
      deletedSessions.delete(sid)
      return false
    }
    return true
  }
  const get = (sid: string): SessionState => {
    let s = sessions.get(sid)
    if (!s) {
      s = {
        shape: null,
        baselineSystem: null,
        modelInfo: null,
        tools: null,
        toolCount: null,
        toolFetch: new Map(),
        lastProcessedMessageID: null,
        lastProcessedAt: null,
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
        collectChain: Promise.resolve(),
        deleted: false,
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
  // gpt56/glm53/deepseek classification once established. A genuine switch to a
  // DIFFERENT non-neutral family (mid-session /model change) DOES replace the
  // latched info, so one family's capabilities can never authorize mutations for
  // another live model.
  const rememberModel = (sid: string, model: ChatParamsModel | undefined): ModelInfo | null => {
    // A genuine request for this session id means it is live again; clear any
    // deletion tombstone so legitimate state creation is never blocked.
    deletedSessions.delete(sid)
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
    const familyChanged =
      s.modelInfo != null && !s.modelInfo.caps.isNeutral && !caps.isNeutral && s.modelInfo.family !== caps.policy
    if (s.modelInfo == null || (s.modelInfo.caps.isNeutral && !caps.isNeutral) || familyChanged) {
      s.modelInfo = info
      // A title/summary request (neutral small model) may have established the
      // system baseline first, and a family switch changes the "powered by the
      // model named ..." env line; re-baseline whenever the new family is
      // non-neutral. Never downgrade a known non-neutral model to neutral.
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
    // TTL and fingerprints are tracked per provider+model identity: each identity
    // keeps its own window and its own hashes, so a title/summary request cannot
    // reuse (and misattribute) another model's fingerprints, and a repeat of an
    // earlier identity within its own window restores that identity's values.
    // The per-session cache is bounded.
    const fetchKey = `${providerID}\u0000${apiID}`
    const cached = s.toolFetch.get(fetchKey)
    if (cached && now - cached.at < TOOL_FETCH_TTL_MS) {
      s.tools = cached.tools
      s.toolCount = cached.toolCount
      return
    }
    try {
      const res = await (client.tool.list as unknown as (opts: {
        query: { directory: string; provider: string; model: string }
      }) => Promise<{ data?: ToolDef[] }>)({
        query: { directory, provider: providerID, model: apiID },
      })
      const tools: ToolCache = {
        semanticToolsHash: toolFingerprint(res?.data),
        wireToolsHash: toolWireFingerprint(res?.data),
      }
      const toolCount = Array.isArray(res?.data) ? res.data.length : null
      s.tools = tools
      s.toolCount = toolCount
      // delete+set so a re-fetched identity moves to the end (last-use order).
      s.toolFetch.delete(fetchKey)
      s.toolFetch.set(fetchKey, { at: now, tools, toolCount })
      if (s.toolFetch.size > TOOL_FETCH_CACHE_CAP) {
        const oldest = s.toolFetch.keys().next().value
        if (oldest !== undefined) s.toolFetch.delete(oldest)
      }
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
  const collectUsageOnce = async (sid: string, s: SessionState): Promise<void> => {
    // N4: skip if this exact session object was deleted (captured object flag,
    // so the guard is independent of the bounded tombstone set) or if a
    // tombstone still covers the id.
    if (s.deleted || isDeleted(sid)) return
    try {
      // V1.18.33 shape: { path: { id } } -> { data?: MessagePage[] }. Methods use
      // `this._client`, so invoke with .call() to preserve the receiver binding.
      const listMessages = (opts: { path: { id: string } }): Promise<SessionMessagesResult> =>
        (client.session.messages as unknown as (o: { path: { id: string } }) => Promise<SessionMessagesResult>).call(client.session, opts)
      const startCursor = s.lastProcessedMessageID
      const res = await listMessages({ path: { id: sid } })
      const messages = res?.data ?? []
      const scanned = scanPage(messages, startCursor, s.lastProcessedAt)
      const read = scanned.read
      const write = scanned.write
      const input = scanned.input
      const count = scanned.count
      const reachedStart = scanned.reachedStart
      const reasoningChronological = scanned.reasoning

      s.lastProcessedMessageID = nextProcessedCursor(messages, startCursor)
      if (scanned.maxCreated != null) {
        s.lastProcessedAt = s.lastProcessedAt == null ? scanned.maxCreated : Math.max(s.lastProcessedAt, scanned.maxCreated)
      }

      const caps = s.modelInfo?.caps
      const glmIntegrity =
        caps?.thinkingIntegrity === true &&
        policyEnabled(cfg, caps.policy) &&
        cfg.policies?.[caps.policy]?.preserveThinkingIntegrity === true

      if (glmIntegrity && reasoningChronological.length > 0) {
        // scanPage returns messages oldest-first, so reasoning is already
        // chronological: process it directly so `seen` grows naturally and
        // `lastSeq` reflects the previous assistant reasoning.
        for (const { id, hashes } of reasoningChronological) {
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
        // Attribute usage to the counted assistant messages' own identity when
        // available (per-message), then the live observed MiMo provider, then the
        // latched session model as a safe fallback.
        if (s.modelInfo || scanned.providerID || s.mimoProvider) {
          recFields.provider = scanned.providerID ?? s.mimoProvider?.providerID ?? s.modelInfo?.providerID
          recFields.model = scanned.modelID ?? s.mimoProvider?.modelID ?? s.modelInfo?.modelID
        }
        if (s.modelInfo) recFields.policy = s.modelInfo.family
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
        }
        if (caps?.gptCacheMetadata === true && s.gptInjected) {
          recFields.keyStrategy = cfg.policies?.[caps.policy]?.cacheRootKey !== false ? "cache-root" : "session"
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

  // N1: serialize per-session collections. Each `session.idle` appends a link to
  // the session's chain, so a second collection re-reads `lastProcessedMessageID`
  // only after the first has advanced it: no double-count, and no follow-up is
  // lost. N4: tombstoned sessions are dropped before `get()` can recreate state.
  // The internal catch keeps the fire-and-forget caller free of unhandled
  // rejections while preserving the chain for later links.
  const collectUsage = (sid: string): Promise<void> => {
    if (isDeleted(sid)) return Promise.resolve()
    const s = get(sid)
    const run = s.collectChain.then(() => collectUsageOnce(sid, s)).catch((e) => {
      rec.record({ kind: "telemetry-error", ts: Date.now(), error: String(e) })
    })
    s.collectChain = run
    return run
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
        // OpenCode provider IDs are canonical lowercase, but normalize
        // defensively so casing/whitespace can never bypass (or leak) the
        // OpenRouter-only affinity gate. Header-name handling below is already
        // case-insensitive.
        const providerID = String(model?.providerID ?? "").trim().toLowerCase()
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
        const liveModel = input.model as unknown as ChatParamsModel
        const info = rememberModel(input.sessionID, liveModel)
        // Record how this model was classified before any policy branch below.
        // The MiMo/GLM provider-observation branches return early, so this call
        // sits ahead of them to cover every request.
        recordPolicyResolution(input.sessionID, input.model)
        // Policy decisions follow the LIVE model and provider, so a stale latched
        // family can never authorize a mutation (or suppress one) for a different
        // live model. `info` stays for session continuity (baseline/usage).
        const caps = resolveRuntimePolicy(input.model) as PolicyRuntime
        const family = caps.policy
        const liveProviderID = String(liveModel?.providerID ?? info?.providerID ?? "")
        const liveModelID = String(liveModel?.api?.id ?? liveModel?.id ?? info?.modelID ?? "")

        // ---- xAI / Grok: route-aware affinity observation (no mutation) ------
        // xAI prompt caching is automatic. For direct xAI the stable conversation
        // affinity is owned by the runtime: OpenCode sets
        // providerOptions.xai.promptCacheKey = sessionID on the Responses API and
        // @ai-sdk/xai serializes it to the wire `prompt_cache_key` (RF-PRV-007 /
        // RF-OC-013). CacheEngine classifies the family and records the route
        // disposition, but never injects a key nor the Chat Completions
        // `x-grok-conv-id` header (that route is not reachable in this runtime,
        // and overwriting the runtime key is forbidden).
        if (caps?.grokCacheAffinity === true && caps?.grokRouteAware === true && policyEnabled(cfg, caps.policy) && info) {
          const npm = String((input.model as unknown as ChatParamsModel)?.api?.npm ?? "")
          const provider = liveProviderID
          const lowerProvider = provider.toLowerCase()
          let affinitySource
          if (lowerProvider === "xai") {
            if (npm === "@ai-sdk/xai") {
              const existingKey = output.options?.promptCacheKey
              // "preexisting" = a key is already present (runtime/user/plugin);
              // CacheEngine never overwrites or claims provenance.
              affinitySource = typeof existingKey === "string" && existingKey.length > 0 ? "preexisting" : "missing"
            } else {
              // xAI identity but an unverified transport: fail closed.
              affinitySource = "unknown_provider"
            }
          } else if (!provider) {
            affinitySource = "unknown_provider"
          } else {
            affinitySource = "not_direct_xai"
          }
          rec.record({
            kind: "boundary",
            sid: input.sessionID,
            ts: Date.now(),
            reason: "grok_affinity",
            policy: "grok",
            provider: provider || null,
            model: liveModelID || null,
            affinitySource,
            note: "xAI affinity is provider/harness-managed; CacheEngine does not mutate",
          })
          return
        }

        // ---- Meta / Muse: route observation (no mutation) --------------------
        // Meta caching is automatic positional prefix caching. Meta documents
        // that `prompt_cache_key` must be an application-stable value and NOT a
        // per-user/per-session value, so CacheEngine never injects or derives
        // one, and `prompt_cache_retention` is a request-level policy with
        // memory/privacy implications that stays harness/user-owned. We only
        // record which of those the exact route already carries.
        if (caps?.museCacheAffinity === true && caps?.museRouteAware === true && policyEnabled(cfg, caps.policy) && info) {
          const npm = String((input.model as unknown as ChatParamsModel)?.api?.npm ?? "")
          const provider = liveProviderID
          const lowerProvider = provider.toLowerCase()
          const isMetaProvider = lowerProvider === "meta"
          // Fail closed: an unverified `meta` transport (e.g. a user-defined
          // provider with npm @ai-sdk/openai-compatible) is treated as unknown
          // rather than as verified direct Meta, matching the Grok branch.
          const isDirectMeta = isMetaProvider && npm === "@ai-sdk/openai"
          const existingKey = output.options?.promptCacheKey
          const existingRetention = output.options?.promptCacheRetention
          let affinitySource
          if (isDirectMeta) {
            affinitySource = typeof existingKey === "string" && existingKey.length > 0 ? "preexisting" : "missing"
          } else if (isMetaProvider || !provider) {
            affinitySource = "unknown_provider"
          } else {
            affinitySource = "not_direct_meta"
          }
          const hasRetention = typeof existingRetention === "string" && existingRetention.length > 0
          rec.record({
            kind: "boundary",
            sid: input.sessionID,
            ts: Date.now(),
            reason: "muse_affinity",
            policy: "muse",
            provider: provider || null,
            model: liveModelID || null,
            affinitySource,
            retentionSource: isDirectMeta ? (hasRetention ? "preexisting" : "none") : "n/a",
            note: "Meta caching is automatic; prompt_cache_key must be app-stable, never per-session, so CacheEngine injects nothing",
          })
          return
        }

        // ---- MiniMax: route observation (no mutation) ------------------------
        // MiniMax caching is automatic prefix caching. M2.x additionally supports
        // explicit Anthropic cache_control (billed writes), but OpenCode owns
        // those breakpoints on the @ai-sdk/anthropic routes; M3 has no write
        // charge. CacheEngine records the route disposition and mutates nothing.
        if (caps?.minimaxRouteAware === true && policyEnabled(cfg, caps.policy) && info) {
          const npm = String((input.model as unknown as ChatParamsModel)?.api?.npm ?? "")
          const provider = liveProviderID
          const lowerProvider = provider.toLowerCase()
          let route
          if (!provider) route = "unknown_provider"
          else if (lowerProvider.startsWith("minimax")) route = "direct_minimax"
          else if (lowerProvider.startsWith("opencode")) route = "opencode"
          else if (lowerProvider === "openrouter") route = "openrouter"
          else route = "gateway"
          // A MiniMax cache write can only be billed where a breakpoint is actually
          // sent: the Anthropic-compatible routes, for the M2.x baseline. Report
          // that per-request potential, not the bare model capability, so an
          // OpenAI-compatible/OpenRouter M2.x request is not mislabeled as billed.
          const harnessAnthropicCaching = npm === "@ai-sdk/anthropic" && lowerProvider !== "openrouter"
          rec.record({
            kind: "boundary",
            sid: input.sessionID,
            ts: Date.now(),
            reason: "minimax_route",
            policy: "minimax",
            provider: provider || null,
            model: liveModelID || null,
            route,
            harnessAnthropicCaching,
            modelWriteBilledCapable: caps.minimaxCacheWriteBilled === true,
            cacheWriteBilled: harnessAnthropicCaching && caps.minimaxCacheWriteBilled === true,
            note: "MiniMax caching is automatic; the harness owns any Anthropic cache_control breakpoints; CacheEngine mutates nothing",
          })
          return
        }

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
        // Transport-correct field names. OpenRouter forwards providerOptions
        // verbatim into the request body and needs snake_case wire names; the
        // OpenAI/Azure SDKs expect camelCase options and serialize them.
        const fieldNames = gptCacheOptionFieldNames({
          providerID: liveProviderID,
          npm: (input.model as unknown as ChatParamsModel)?.api?.npm,
        })

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
              provider: liveProviderID,
              model: liveModelID,
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
        // Write the desired key when it is CacheEngine-owned policy: cache-root
        // affinity (applyRoot) or compaction isolation (isolated). The runtime
        // pre-sets promptCacheKey to the session id for direct OpenAI/Azure, so
        // without this a compaction request would keep the live-session key and
        // share its namespace. Live requests with cacheRootKey disabled and no
        // root affinity still preserve an existing key.
        const already = output.options[fieldNames.key]
        if ((applyRoot || isolated) && (already === undefined || already !== desiredKey)) {
          output.options[fieldNames.key] = desiredKey
        }
        const optsDelta = gptCacheOptionsDelta(output.options, {
          key: desiredKey,
          mode: gpol?.mode,
          ttl: gpol?.ttl,
          fieldNames,
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
            provider: liveProviderID,
            model: liveModelID,
            keyStrategy: applyRoot ? "cache-root" : "session",
            ...cacheCtxExtra,
            compaction,
            namespace: isolated ? "compact" : "live",
            key: desiredKey,
            options: { ...(output.options[fieldNames.options] ?? {}) },
          })

          if (applyRoot && rootRes!.source === "parent" && rootRes!.hops > 0) {
            rec.record({
              kind: "boundary",
              sid: input.sessionID,
              ts: Date.now(),
              reason: "gpt_session_fork",
              provider: liveProviderID,
              model: liveModelID,
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
            provider: liveProviderID,
            model: liveModelID,
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
        // Bounded retention: drop per-session state only when OpenCode reports
        // the session deleted (EventSessionDeleted -> properties.info.id). Active
        // or merely idle sessions are never evicted, so usage accounting, stable
        // keys, baseline/shape, and compaction bookkeeping are preserved.
        if (event.type === "session.deleted") {
          const sid = event.properties.info?.id
          if (sid) {
            // Mark the exact object first: any queued/async work holding it is
            // now guaranteed to skip, regardless of the bounded tombstone set.
            const s = sessions.get(sid)
            if (s) s.deleted = true
            sessions.delete(sid)
            effortByRoot.delete(sid)
            // N4: block stale/queued idle collection from recreating state.
            deletedSessions.set(sid, Date.now())
            if (deletedSessions.size > DELETED_SESSIONS_CAP) {
              const cutoff = Date.now() - DELETED_SESSIONS_TTL_MS
              for (const [k, at] of deletedSessions) {
                if (at < cutoff) deletedSessions.delete(k)
              }
              while (deletedSessions.size > DELETED_SESSIONS_CAP) {
                const oldest = deletedSessions.keys().next().value
                if (oldest === undefined) break
                deletedSessions.delete(oldest)
              }
            }
          }
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
        // Policy gating follows the LIVE model, never a stale latched family.
        const caps = resolveRuntimePolicy(input.model) as PolicyRuntime

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
                provider: String(model?.providerID ?? ""),
                model: String(model?.api?.id ?? model?.id ?? ""),
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
      } catch (e) {
        // Best-effort: never break compaction, but record the failure like every
        // other hook so it is observable. The recorder itself never throws.
        rec.record({ kind: "telemetry-error", ts: Date.now(), error: String(e) })
      }
    },
  }
}
