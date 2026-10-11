// cache-engine-v2.mjs
//
// OpenCode V2 runtime adapter for opencode-cache-engine.
//
// Target (verified locally, 2026-10-10 against the installed runtime
// OpenCode 2.0.26 + @opencode/plugin 2.0.25):
//   * A V2 plugin is a plain object `{ id, setup(ctx) }`; `define()` is the
//     identity function, so no runtime dependency is required. `setup` may
//     return a cleanup callback.
//   * `ctx.session.hook(name, cb, options?)` (ModelHooks) registers a session
//     hook; callbacks receive a mutable event object (mutate in place).
//       - "context":     { sessionID, agent, model: {id, providerID}, system: SystemPart[], messages, options, tools }
//       - "model.request": { sessionID, agent, model, kind, baseURL?, headers }
//   * `ctx.event.subscribe()` -> AsyncIterable<V2Event>; `session.idle` carries { data: { sessionID } }.
//   * `ctx.session.context({ sessionID })` -> Promise<SessionMessageInfo[]>; assistant
//     messages carry `tokens: { input, output, reasoning, cache: { read, write } }`.
//
// The adapter reuses the runtime-independent policy resolver and accounting
// primitives. It does NOT import the V1 adapter or any OpenCode SDK package,
// so it stays decoupled and dependency-free. Every hook is fail-safe.
//
// Scope (emergency migration, Stage B/C + a first usage pass): provider-policy
// request transforms (GPT cache metadata; GLM/MiMo `<env>` relocation) and
// OpenRouter session affinity, plus usage aggregation from session history.
// Secondary V1 diagnostics (prefix/reasoning observation, tool fingerprints,
// reasoning-integrity, provider-observation telemetry) are intentionally NOT
// ported here and remain on the V1 adapter.

import {
  DEFAULT_CONFIG_PATH,
  affinityTelemetryFields,
  createRecorder,
  ensureMetricsDir,
  gptCacheKeyFor,
  gptCacheOptionFieldNames,
  gptCacheOptionsDelta,
  glmHitRatio,
  hitRatePct,
  isOpenRouterAffinityEligible,
  loadConfig,
  mimoHitRate,
  mimoSessionIdFor,
  nextProcessedCursor,
  policyEnabled,
  relocateVolatileEnvBlock,
  scanPage,
  shouldAggregate,
} from "./cache-engine-core.mjs"
import { resolveRuntimePolicy } from "./cache-policy-core.mjs"

// Bounded per-session state (see the session-state notes below).
const MAX_SESSIONS = 1024
const DELETED_TTL_MS = 10 * 60_000
const DELETED_CAP = 8192
const EVICTED_TTL_MS = 10 * 60_000
const EVICTED_CAP = 4096

const log = (level, msg, extra) => {
  try {
    if (process.env.CACHE_ENGINE_DEBUG === "1") console.error(`[cache-engine-v2] ${msg}`, extra ?? "")
  } catch {
    /* diagnostics must never break a request */
  }
}

// Normalize a V2 model ref ({ id, providerID }) into the shared resolver's shape.
const toModelInfo = (model) => ({
  providerID: String(model?.providerID ?? ""),
  id: String(model?.id ?? ""),
  api: { id: String(model?.id ?? "") },
})

// Translate a V2 SessionMessageInfo into the shared scanner's { info } shape.
const toScanMessage = (m) => ({
  info: {
    id: m?.id,
    role: m?.type,
    tokens: m?.tokens,
    time: m?.time,
  },
})

// Sort the mapped scan messages ({ info: { time } }) by created ascending.
const byCreated = (a, b) => (a?.info?.time?.created ?? 0) - (b?.info?.time?.created ?? 0)

// Drop entries older than `ttlMs`, then enforce a capacity cap. Only runs when
// the map already exceeds its cap (existing behavior). Exported so the TTL
// parameterization can be unit-tested deterministically with an injected `now`.
export function pruneMarks(map, cap, ttlMs, now = Date.now()) {
  if (map.size <= cap) return
  const cutoff = now - ttlMs
  for (const [k, at] of map) if (at < cutoff) map.delete(k)
  while (map.size > cap) map.delete(map.keys().next().value)
}

/**
 * Build the V2 plugin object. Exported as both `CacheEngineV2` (named) and the
 * module default so either loader convention works.
 */
export const CacheEngineV2 = {
  id: "opencode-cache-engine",

  async setup(ctx) {
    const cfg = loadConfig({ configPath: DEFAULT_CONFIG_PATH, env: process.env })
    if (!cfg?.enabled) return
    ensureMetricsDir(cfg.metricsFile)
    const rec = createRecorder(cfg.metricsFile)

    // Per-session transient state: usage cursor/watermark + accounting totals +
    // a latched policy capability set for ratio selection. In-memory only; never
    // persisted (same limitation as V1).
    //
    // Bounding strategy:
    //   * `session.deleted` removes state immediately and records a bounded
    //     tombstone so a late/queued `session.idle` cannot recreate state and
    //     recount a deliberately-ended session (V1 parity).
    //   * `sessions` is capped at MAX_SESSIONS with LRU eviction (the least
    //     recently used entry is discarded). Crucially, capacity eviction is
    //     NOT a deletion: it records a bounded "evicted" mark so that when the
    //     session reappears the first scan SKIPS the pre-existing backlog
    //     (under-count) instead of recounting it (double-count). This avoids
    //     suppressing an active session for a TTL while never double-counting.
    //   * Both mark maps are bounded (TTL + cap) so memory stays bounded.
    // The unavoidable limitation: cursor state is not durable across restarts,
    // and a same-millisecond boundary or a failure after cursor advancement can
    // still undercount. Exactly-once accounting is not claimed.
    const sessions = new Map()
    const tombstones = new Map()
    const evicted = new Map()

    const isTombstoned = (sid) => {
      if (!sid) return false
      const at = tombstones.get(sid)
      if (at == null) return false
      if (Date.now() - at > DELETED_TTL_MS) {
        tombstones.delete(sid)
        return false
      }
      return true
    }
    const forgetSession = (sid) => {
      if (!sid) return
      sessions.delete(sid)
      evicted.delete(sid)
      tombstones.set(sid, Date.now())
      pruneMarks(tombstones, DELETED_CAP, DELETED_TTL_MS)
    }
    const markEvicted = (sid) => {
      if (!sid) return
      evicted.set(sid, Date.now())
      pruneMarks(evicted, EVICTED_CAP, EVICTED_TTL_MS)
    }

    // Returns the session state, or null when the id is tombstoned (a
    // deliberately deleted session must not be recreated from a late event).
    // Access refreshes LRU position so an active session is never the eviction
    // victim.
    const getSession = (sid) => {
      if (!sid || isTombstoned(sid)) return null
      const existing = sessions.get(sid)
      if (existing) {
        sessions.delete(sid)
        sessions.set(sid, existing)
        return existing
      }
      const wasEvicted = evicted.has(sid)
      if (wasEvicted) evicted.delete(sid)
      const s = {
        caps: null,
        lastProcessedMessageID: null,
        lastProcessedAt: null,
        read: 0,
        write: 0,
        input: 0,
        gptInjected: false,
        skipBacklog: wasEvicted,
      }
      sessions.set(sid, s)
      if (sessions.size > MAX_SESSIONS) {
        const victim = sessions.keys().next().value
        if (victim !== undefined && victim !== sid) {
          sessions.delete(victim)
          markEvicted(victim)
        }
      }
      return s
    }

    const recordSafe = (fields) => {
      try {
        rec.record(fields)
      } catch (e) {
        log("warn", "telemetry write failed", String(e))
      }
    }

    // ---- context hook: policy request transforms --------------------------
    // The server dispatches `context` only for `primary` requests; auxiliary
    // kinds (compaction/title/generate) use their own hooks (RF-OC-018), so no
    // request-kind guard is needed here.
    const onContext = (event) => {
      try {
        const model = event?.model
        const caps = resolveRuntimePolicy(toModelInfo(model))
        if (!caps || caps.isNeutral) return
        const sid = String(event?.sessionID ?? "")
        const s = getSession(sid)
        if (s) s.caps = caps

        const providerID = String(model?.providerID ?? "").trim().toLowerCase()
        const modelID = String(model?.id ?? "")

        // GLM-5.3 / MiMo-V2.6 <env> relocation, exactly as V1: only when the
        // policy opts in and there is a single system text part (the verified
        // V1 runtime shape); content-preserving, position-only. Multi-part
        // system content is left untouched (safe skip).
        const envVariant = caps.envRelocation ?? null
        const stabilize =
          envVariant !== null && policyEnabled(cfg, caps.policy) && cfg.policies?.[caps.policy]?.stabilizeSystem === true
        const system = Array.isArray(event?.system) ? event.system : null
        if (stabilize && system && system.length === 1 && system[0] && system[0].type === "text" && typeof system[0].text === "string") {
          const rel = relocateVolatileEnvBlock(system[0].text)
          if (rel.changed) {
            system[0].text = rel.text
            log("debug", `${envVariant} system env block relocated`, { sid })
          }
        }

        // GPT-5.6+ cache metadata: add only missing promptCacheKey /
        // promptCacheOptions in the transport's field names, preserving any
        // existing values. The options object is required by the API; if it is
        // absent or malformed we safely skip the transform rather than inventing
        // an object the host may not observe.
        if (caps.gptCacheMetadata === true && policyEnabled(cfg, caps.policy)) {
          const options = event?.options
          if (!options || typeof options !== "object" || Array.isArray(options)) return
          const gpol = cfg.policies?.[caps.policy]
          const fieldNames = gptCacheOptionFieldNames({ providerID, npm: undefined })
          const desiredKey = gpol?.promptCacheKey === false ? null : gptCacheKeyFor(sid, { compaction: false })
          let injectedKey = null
          if (desiredKey && options[fieldNames.key] === undefined) {
            options[fieldNames.key] = desiredKey
            injectedKey = desiredKey
          }
          const delta = gptCacheOptionsDelta(options, {
            key: desiredKey ?? undefined,
            mode: gpol?.mode,
            ttl: gpol?.ttl,
            fieldNames,
          })
          const injectedOptions = Object.keys(delta).length > 0
          if (injectedOptions) Object.assign(options, delta)
          // Once-per-session telemetry, and only when something was actually
          // injected — never report a desired key that was already present as
          // plugin-injected.
          if (s && !s.gptInjected && (injectedKey !== null || injectedOptions)) {
            s.gptInjected = true
            recordSafe({
              kind: "cache-options",
              sid,
              ts: Date.now(),
              policy: caps.policy,
              provider: providerID,
              model: modelID,
              key: injectedKey,
              keyInjected: injectedKey !== null,
              transport: fieldNames.key,
            })
          }
        }
      } catch (e) {
        recordSafe({ kind: "telemetry-error", ts: Date.now(), error: String(e) })
      }
    }

    // ---- model.request hook: OpenRouter session affinity -------------------
    // Telemetry reuses the shared `affinityTelemetryFields` helper so the V2
    // `boundary` record carries the same schema as V1 (reason, eligible,
    // providerIdentityKnown, provider, headerPresent, headerAttached,
    // headerSource). Mutation behaviour is unchanged.
    const onModelRequest = (event) => {
      try {
        const model = event?.model
        const caps = resolveRuntimePolicy(toModelInfo(model))
        if (!caps || !caps.openRouterAffinity) return
        const providerID = String(model?.providerID ?? "").trim().toLowerCase()
        const modelID = String(model?.id ?? "")

        const headers = event?.headers && typeof event.headers === "object" ? event.headers : null
        const eligible = isOpenRouterAffinityEligible(caps.policy, providerID)
        let headerSource = "not_applicable"
        if (eligible) {
          const hasSessionID = headers ? Object.keys(headers).some((name) => name.toLowerCase() === "x-session-id") : false
          if (!headers) {
            headerSource = "unavailable"
          } else if (hasSessionID) {
            headerSource = "preexisting"
          } else {
            const derived = mimoSessionIdFor(String(event?.sessionID ?? ""))
            if (derived) {
              headers["x-session-id"] = derived
              headerSource = "cache_engine"
            } else {
              headerSource = "unavailable"
            }
          }
        }

        const telemetry = affinityTelemetryFields(caps.policy, providerID, headerSource)
        if (telemetry) {
          recordSafe({
            kind: "boundary",
            sid: String(event?.sessionID ?? ""),
            ts: Date.now(),
            policy: caps.policy,
            model: modelID || null,
            ...telemetry,
          })
        }
      } catch (e) {
        recordSafe({ kind: "telemetry-error", ts: Date.now(), error: String(e) })
      }
    }

    // ---- usage aggregation: session.idle -> session.context ----------------
    const collectUsage = async (sid) => {
      try {
        const s = getSession(sid)
        if (!s) return
        if (typeof ctx?.session?.context !== "function") return
        // Race history retrieval against abort so shutdown never waits on a
        // pending request; the abandoned promise's settlement is handled to
        // avoid unhandled rejections.
        const history = ctx.session.context({ sessionID: sid }).then(
          (r) => ({ ok: r }),
          (e) => ({ err: e }),
        )
        const outcome = await Promise.race([history, abortPromise.then(() => "abort")])
        if (outcome === "abort") return
        if (outcome.err) throw outcome.err
        // The session may have been deleted or capacity-evicted during the
        // await. Only proceed if this exact object is still the current entry.
        if (sessions.get(sid) !== s || isTombstoned(sid)) return

        const res = outcome.ok
        const messages = Array.isArray(res) ? res : Array.isArray(res?.data) ? res.data : []
        const page = messages.map(toScanMessage).slice().sort(byCreated)

        // Re-entry after a capacity eviction: skip the pre-existing backlog
        // (undercount) rather than recount it. Resume accounting from here on.
        if (s.skipBacklog) {
          s.skipBacklog = false
          s.lastProcessedMessageID = nextProcessedCursor(page, null)
          let maxCreated = null
          for (const m of page) {
            const c = m?.info?.time?.created
            if (Number.isFinite(c)) maxCreated = maxCreated == null ? c : Math.max(maxCreated, c)
          }
          if (maxCreated != null) s.lastProcessedAt = maxCreated
          return
        }

        const scanned = scanPage(page, s.lastProcessedMessageID, s.lastProcessedAt)
        s.lastProcessedMessageID = nextProcessedCursor(page, s.lastProcessedMessageID)
        if (scanned.maxCreated != null) {
          s.lastProcessedAt = s.lastProcessedAt == null ? scanned.maxCreated : Math.max(s.lastProcessedAt, scanned.maxCreated)
        }
        if (!shouldAggregate(scanned.count, scanned.read, scanned.write)) return
        s.read += scanned.read
        s.write += scanned.write
        s.input += scanned.input
        const caps = s.caps
        const recFields = {
          kind: "usage",
          sid,
          ts: Date.now(),
          read: scanned.read,
          write: scanned.write,
          input: scanned.input,
          messages: scanned.count,
          sampleHitRate: hitRatePct(scanned.read, scanned.write),
          cumulative: { read: s.read, write: s.write },
          cumulativeHitRate: hitRatePct(s.read, s.write),
          cursor: s.lastProcessedMessageID,
        }
        if (caps?.policy) recFields.policy = caps.policy
        if (caps?.cacheRatio === "glm") {
          recFields.promptTokens = scanned.read + scanned.write + scanned.input
          recFields.glmHitRate = glmHitRatio(scanned.read, scanned.write, scanned.input)
        }
        if (caps?.cacheRatio === "mimo") {
          const promptTokens = scanned.read + scanned.input
          recFields.promptTokens = promptTokens
          recFields.cachedTokens = scanned.read
          recFields.cacheHitRate = mimoHitRate(scanned.read, promptTokens)
        }
        recordSafe(recFields)
      } catch (e) {
        recordSafe({ kind: "telemetry-error", ts: Date.now(), error: String(e) })
      }
    }

    // ---- event consumer: session.usage.updated / session.idle (usage) +
    // ---- session.deleted (cleanup) ----------------------------------------
    // `subscribe()` returns an AsyncIterable<V2Event> with no signal support, so
    // each iteration races the iterator's `next()` against the abort signal and
    // calls `return()` on shutdown. Events are consumed strictly one at a time
    // and each usage trigger is awaited before the next event is read, so history
    // scans can never overlap and the per-session cursor can never be advanced
    // concurrently. `session.usage.updated` is the primary trigger (fired on each
    // usage change); `session.idle` is retained as a secondary trigger. Only the
    // event's `data.sessionID` is used to drive the shared history scan — the
    // event's token totals are cumulative session snapshots that can include
    // auxiliary usage absent from `session.context`, so they are never used for
    // accounting.
    const ac = new AbortController()
    const abortPromise = new Promise((resolve) => {
      if (ac.signal.aborted) resolve("abort")
      else ac.signal.addEventListener("abort", () => resolve("abort"), { once: true })
    })
    const consumeEvents = async () => {
      let iterator
      try {
        if (typeof ctx?.event?.subscribe !== "function") return
        const iterable = ctx.event.subscribe()
        iterator = iterable && typeof iterable[Symbol.asyncIterator] === "function" ? iterable[Symbol.asyncIterator]() : null
        if (!iterator) return
        while (!ac.signal.aborted) {
          const next = await Promise.race([
            iterator.next().then((r) => ({ type: "next", r }), (e) => ({ type: "err", e })),
            abortPromise.then(() => ({ type: "abort" })),
          ])
          if (next.type === "abort") break
          if (next.type === "err") throw next.e
          if (next.r.done) break
          const ev = next.r.value
          if (ev && ev.type === "session.deleted" && ev.data && typeof ev.data.sessionID === "string") {
            forgetSession(ev.data.sessionID)
          } else if (ev && ev.type === "session.usage.updated" && ev.data && typeof ev.data.sessionID === "string") {
            // Primary usage trigger. Serialized with all other events by the loop
            // above, so a slow scan defers the next event rather than overlapping.
            await collectUsage(ev.data.sessionID)
          } else if (ev && ev.type === "session.idle" && ev.data && typeof ev.data.sessionID === "string") {
            // Secondary trigger, sharing the same safe accounting path.
            await collectUsage(ev.data.sessionID)
          }
        }
      } catch (e) {
        log("warn", "event stream ended", String(e))
      } finally {
        try {
          await iterator?.return?.()
        } catch {
          /* ignore */
        }
      }
    }

    const registrations = []
    const safeHook = async (name, handler) => {
      try {
        if (typeof ctx?.session?.hook !== "function") return
        registrations.push(await ctx.session.hook(name, handler))
      } catch (e) {
        recordSafe({ kind: "telemetry-error", ts: Date.now(), error: `hook ${name}: ${String(e)}` })
      }
    }
    await safeHook("context", onContext)
    await safeHook("model.request", onModelRequest)

    // Fire-and-forget the event consumer; keep the plugin load non-blocking.
    void consumeEvents()

    log("info", "opencode-cache-engine V2 adapter ready")

    // Cleanup: stop the consumer, dispose hook registrations, clear state.
    return async () => {
      try {
        ac.abort()
      } catch {
        /* ignore */
      }
      for (const r of registrations) {
        try {
          await r?.dispose?.()
        } catch {
          /* ignore */
        }
      }
      sessions.clear()
      tombstones.clear()
      evicted.clear()
    }
  },
}

export default CacheEngineV2
