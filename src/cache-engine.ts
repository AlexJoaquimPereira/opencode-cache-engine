import type { Plugin } from "@opencode-ai/plugin"
import type { Event, Message, Part } from "@opencode-ai/sdk"
import {
  DEFAULT_CONFIG_PATH,
  DIGEST_TEMPLATE,
  POLICY_GLM53,
  POLICY_GPT56,
  POLICY_NEUTRAL,
  createRecorder,
  detectPolicy,
  detectReasoningIssues,
  digestDecision,
  ensureMetricsDir,
  glmHitRatio,
  gptCacheKeyFor,
  gptCacheOptionsDelta,
  hitRatePct,
  loadConfig,
  nextProcessedCursor,
  observeReasoningEffort,
  policyEnabled,
  prefixChangeReasons,
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

// ---------------------------------------------------------------------------
// cache-engine
//
// Provider-aware prompt-cache observability + conservative cache-shape
// preservation for ONE OpenCode TUI across three model families:
//
//   DeepSeek V4 Flash  -> pure passive. >99.66% hit rate is preserved by never
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
//
// The engine remains conservative: it observes, hashes, compares, records,
// appends a compaction continuation template, and (for GPT-5.6 only) injects
// documented cache options. It never rewrites message history, reorders tools,
// or alters user content. DeepSeek and neutral models are byte-untouched.
//
// IMPORTANT (terminology): local hashes describe the *observed* prefix shape.
// A changed hash means request bytes changed; it is NOT proof the provider's
// cache key changed or that a cache miss occurred. Provider-reported cache
// token counts are authoritative; hashes are diagnostics only.
// ---------------------------------------------------------------------------

const TOOL_FETCH_TTL_MS = 1500
const PAGE_SIZE = 100
const REASONING_SEEN_CAP = 5000
const ROOT_HOPS_MAX = 16
const ROOT_CACHE_TTL_MS = 30_000

// The runtime plugin client accepts these options even though the v1 SDK type
// only declares `path.id`/`query`; the empirical call shape is sessionID-based.
type MessagesOpts = { sessionID: string; limit?: number; before?: string }
type MessagePage = { info: Message; parts: Part[] }
type MessagesResult = { data?: MessagePage[]; response?: Response }

type ToolDef = { id: string; description: string; parameters: unknown }

type Shape = {
  fullSystemHash: string | null
  stableSystemPrefixHash: string | null
  volatileSystemSuffixHash: string | null
  semanticToolsHash: string | null
  wireToolsHash: string | null
  toolCount: number | null
}

type ModelInfo = { family: string; providerID: string; modelID: string }

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
}

const emptyShape = (): Shape => ({
  fullSystemHash: null,
  stableSystemPrefixHash: null,
  volatileSystemSuffixHash: null,
  semanticToolsHash: null,
  wireToolsHash: null,
  toolCount: null,
})

type ChatParamsModel = { providerID: string; id?: string; api?: { id?: string; npm?: string }; name?: string }

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

  // Latch the first NON-neutral model observed for a session. Title/summary
  // requests may use the small model; we never let that overwrite a real
  // gpt56/glm53/deepseek classification once established.
  const rememberModel = (sid: string, model: ChatParamsModel | undefined): ModelInfo | null => {
    if (!model) return null
    const family = detectPolicy(model)
    const s = get(sid)
    const info: ModelInfo = {
      family,
      providerID: String(model.providerID ?? ""),
      modelID: String(model.api?.id ?? model.id ?? ""),
    }
    if (s.modelInfo == null || (s.modelInfo.family === POLICY_NEUTRAL && family !== POLICY_NEUTRAL)) {
      s.modelInfo = info
      // A title/summary request (neutral small model) may have established the
      // system baseline first. Its "powered by the model named ..." env line
      // differs from the real model's, so re-baseline on upgrade.
      if (s.baselineSystem !== null && s.modelInfo.family !== POLICY_NEUTRAL) {
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
  // newer than the last-processed boundary, paginating until the boundary (or
  // the tail) is reached.
  const collectUsage = async (sid: string): Promise<void> => {
    try {
      const listMessages = (opts: MessagesOpts): Promise<MessagesResult> =>
        (client.session.messages as unknown as (o: MessagesOpts) => Promise<MessagesResult>).call(client.session, opts)
      const s = get(sid)
      const startCursor = s.lastProcessedMessageID
      let before: string | undefined
      let read = 0
      let write = 0
      let input = 0
      let count = 0
      let reachedStart = false
      let firstPage: MessagePage[] | null = null
      let lastPageSize = 0
      const reasoningNewestFirst: { id: string; hashes: string[] }[] = []
      let guard = 0

      while (guard++ < 200) {
        const res = await listMessages({ sessionID: sid, limit: PAGE_SIZE, before })
        const page = res?.data ?? []
        lastPageSize = page.length
        if (firstPage === null && page.length > 0) firstPage = page
        const scan = scanPage(page, startCursor)
        read += scan.read
        write += scan.write
        input += scan.input
        count += scan.count
        reachedStart = scan.reachedStart
        for (const r of scan.reasoning) reasoningNewestFirst.push(r)
        if (reachedStart) break

        const next = res?.response?.headers?.get("x-next-cursor")
        if (!next || page.length === 0 || next === before) break
        before = next
      }

      s.lastProcessedMessageID = nextProcessedCursor(firstPage, startCursor)

      const family = s.modelInfo?.family
      const glmIntegrity =
        family === POLICY_GLM53 &&
        policyEnabled(cfg, POLICY_GLM53) &&
        cfg.policies?.[POLICY_GLM53]?.preserveThinkingIntegrity === true

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
        if (family === POLICY_GLM53) {
          recFields.promptTokens = read + write + input
          recFields.glmHitRate = glmHitRatio(read, write, input)
        }
        if (family === POLICY_GPT56 && s.gptInjected) {
          recFields.keyStrategy = "session"
          recFields.mode = cfg.policies?.[POLICY_GPT56]?.mode
          recFields.ttl = cfg.policies?.[POLICY_GPT56]?.ttl
        }
        rec.record(recFields)
      } else {
        // No cache data observed for new messages (or none at all). We
        // deliberately do NOT emit a zero-valued usage record here.
        log("debug", "idle: no new assistant usage", {
          sid,
          messagesScanned: lastPageSize,
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
    "chat.params": async (input, output) => {
      try {
        const info = rememberModel(input.sessionID, input.model as unknown as ChatParamsModel)
        const family = info?.family
        if (!(family === POLICY_GPT56 && policyEnabled(cfg, POLICY_GPT56))) {
          // DeepSeek / GLM / neutral: nothing to inject. GLM has no cache-key API;
          // DeepSeek caching is fully passive; we never mutate requests for them.
          return
        }
        const gpol = cfg.policies?.[POLICY_GPT56]
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
            policy: POLICY_GPT56,
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
        // Diagnostic only. `session.usage.updated` is emitted by the runtime
        // (session-cumulative totals) but is not part of the typed Event union;
        // it is never used as the authoritative aggregation path.
        if ((event as { type?: string }).type === "session.usage.updated") {
          const e = event as unknown as {
            properties?: { sessionID?: string }
            data?: { sessionID?: string; cost?: number; tokens?: { cache?: { read: number; write: number } } }
          }
          const t = e?.data?.tokens
          if (t?.cache) {
            const sid = e?.properties?.sessionID ?? e?.data?.sessionID
            const s = sid ? get(sid) : null
            rec.record({
              kind: "usage-event",
              sid,
              ts: Date.now(),
              read: t.cache.read,
              write: t.cache.write,
              cost: e?.data?.cost,
              ...(s?.modelInfo
                ? { provider: s.modelInfo.providerID, model: s.modelInfo.modelID, policy: s.modelInfo.family }
                : {}),
            })
          }
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
        const family = s.modelInfo?.family

        // ---- GLM-5.3 input-shape stabilization -----------------------------
        // Relocate the identifiable volatile env block (per-day date) to the
        // tail of the single system string, content-preserving, ONLY when the
        // model is GLM-5.3 and the block markers are present exactly. Never
        // touches other content/order; never applied to other families.
        //
        // In-place mutation note: request.ts keeps using its own local `system`
        // array after the hook (the trigger's returned output is ignored), so
        // reassigning `output.system = [...]` would be lost. We rewrite the
        // single element in place instead.
        let systemText = output.system.join("\n")
        if (
          family === POLICY_GLM53 &&
          policyEnabled(cfg, POLICY_GLM53) &&
          cfg.policies?.[POLICY_GLM53]?.stabilizeSystem === true &&
          output.system.length === 1
        ) {
          const rel = relocateVolatileEnvBlock(output.system[0])
          if (rel.changed) {
            output.system[0] = rel.text
            systemText = rel.text
            log("debug", "glm system env block relocated to suffix", { sid })
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
