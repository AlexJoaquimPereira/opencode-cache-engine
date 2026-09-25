// cache-engine-core.mjs
//
// Pure, dependency-light logic for the cache-engine plugin. Kept in plain JS so
// the unit tests (cache-engine.test.mjs) can `import` it under Node without a
// TypeScript compiler. The plugin entry (cache-engine.ts) imports this module.
//
// This module is PROVIDER-AWARE: it classifies a model into a cache-policy
// family (deepseek | gpt56 | glm53 | mimo26 | neutral) and exposes small pure
// helpers for each family's strategy. The plugin entry (cache-engine.ts) remains
// the only place that touches OpenCode hooks; every decision here is testable in
// Node.
//
// Terminology note: these functions deal with the *observed* system/tool
// prefix shape. An observed change means the request's prefix bytes changed; it
// is NOT proof that the provider's cache key changed or that a cache miss
// occurred. Provider-reported cache token counts are the only authoritative
// signal; local hashes are diagnostics.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export const CONFIG_FILENAME = "cache-engine.json"
export const DEFAULT_CONFIG_PATH = join(homedir(), ".config/opencode", CONFIG_FILENAME)
export const DEFAULT_METRICS_FILE = join(homedir(), ".cache/opencode/cache-metrics.jsonl")

export const DIGEST_TEMPLATE = `## Session digest (cache-stable continuation block)
- Goal:
- Decisions made:
- Pending:
- Active files:
`

// Cache-policy families. "neutral" preserves stock behavior (no mutation).
export const POLICY_DEEPSEEK = "deepseek"
export const POLICY_GPT56 = "gpt56"
export const POLICY_GLM53 = "glm53"
export const POLICY_MIMO26 = "mimo26"
export const POLICY_NEUTRAL = "neutral"

export const GPT56_DEFAULT_TTL = "30m"
export const GPT56_DEFAULT_MODE = "implicit"

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function defaultPolicies() {
  return {
    deepseek: { enabled: true },
    gpt56: {
      enabled: true,
      promptCacheKey: true,
      // Disabled by default: this OpenCode runtime does not expose reliable
      // fork lineage (session.fork copies messages without setting parent_id),
      // so cross-fork cache-root inheritance cannot be applied safely. The code
      // path remains and can be re-enabled if the runtime gains proper lineage.
      cacheRootKey: false,
      compactionCacheIsolation: true,
      reasoningEffortDiagnostics: true,
      mode: GPT56_DEFAULT_MODE,
      ttl: GPT56_DEFAULT_TTL,
    },
    glm53: {
      enabled: true,
      stabilizeSystem: true,
      preserveThinkingIntegrity: true,
    },
    mimo26: {
      enabled: true,
      stabilizeSystem: true,
      stickySession: true,
      // MiMo reasoning diagnostics are instrumentation only. Unlike GLM
      // preserved thinking, there is no evidence that MiMo prompt-cache reuse
      // depends on reasoning replay, so this never rewrites reasoning content.
      preserveThinkingIntegrity: true,
    },
  }
}

export function defaultConfig() {
  return {
    enabled: true,
    metricsFile: DEFAULT_METRICS_FILE,
    compactTemplate: true,
    logPrefixChanges: true,
    policies: defaultPolicies(),
  }
}

export function expandHome(p) {
  if (p === "~") return homedir()
  if (typeof p === "string" && p.startsWith("~/")) return join(homedir(), p.slice(2))
  return p
}

const boolOr = (v, fb) => (typeof v === "boolean" ? v : fb)

function parsePolicy(rawPolicy, defaults) {
  const out = { ...defaults }
  if (!rawPolicy || typeof rawPolicy !== "object") return out
  for (const k of Object.keys(defaults)) {
    if (typeof defaults[k] === "boolean") out[k] = boolOr(rawPolicy[k], defaults[k])
  }
  // gpt56 mode/ttl are strings with validated values
  if (defaults.mode !== undefined) {
    const mode = typeof rawPolicy.mode === "string" ? rawPolicy.mode : defaults.mode
    out.mode = mode === "implicit" || mode === "explicit" ? mode : defaults.mode
  }
  if (defaults.ttl !== undefined) {
    out.ttl = typeof rawPolicy.ttl === "string" && rawPolicy.ttl.length > 0 ? rawPolicy.ttl : defaults.ttl
  }
  return out
}

// Env override is applied first, then the file may override. Invalid input
// falls back to defaults. Returns a fresh object; never mutates callers.
export function parseConfig(raw, env) {
  const cfg = defaultConfig()
  const e = env || {}
  if (typeof e.CACHE_ENGINE_METRICS_FILE === "string" && e.CACHE_ENGINE_METRICS_FILE.length > 0) {
    cfg.metricsFile = expandHome(e.CACHE_ENGINE_METRICS_FILE)
  }
  if (raw && typeof raw === "object") {
    if (typeof raw.enabled === "boolean") cfg.enabled = raw.enabled
    if (typeof raw.metricsFile === "string" && raw.metricsFile.length > 0) cfg.metricsFile = expandHome(raw.metricsFile)
    if (typeof raw.compactTemplate === "boolean") cfg.compactTemplate = raw.compactTemplate
    if (typeof raw.logPrefixChanges === "boolean") cfg.logPrefixChanges = raw.logPrefixChanges
    if (raw.policies && typeof raw.policies === "object") {
      const d = defaultPolicies()
      for (const fam of ["deepseek", "gpt56", "glm53", "mimo26"]) {
        if (raw.policies[fam]) cfg.policies[fam] = parsePolicy(raw.policies[fam], d[fam])
      }
    }
  }
  return cfg
}

export function loadConfig({ configPath = DEFAULT_CONFIG_PATH, env } = {}) {
  try {
    if (existsSync(configPath)) {
      return parseConfig(JSON.parse(readFileSync(configPath, "utf8")), env)
    }
  } catch {
    // malformed config -> defaults
  }
  return parseConfig(undefined, env)
}

// Ensure the metrics file's parent directory exists. Best-effort; never throws.
export function ensureMetricsDir(metricsFile) {
  try {
    mkdirSync(dirname(metricsFile), { recursive: true })
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// Metrics writer (best-effort, must never throw)
// ---------------------------------------------------------------------------

export function createRecorder(metricsFile) {
  return {
    record(line) {
      try {
        appendFileSync(metricsFile, JSON.stringify(line) + "\n")
      } catch {
        // Telemetry is best-effort; a failed write must not break a request.
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Hashing / canonicalization
// ---------------------------------------------------------------------------

export function shorthash(s) {
  return createHash("sha256").update(String(s ?? "")).digest("hex").slice(0, 16)
}

// Deterministic stringification. Object keys are sorted so object/insertion
// ordering can never create a false change. Non-serializable values (functions,
// symbols, undefined) are normalized to stable markers rather than omitted, so
// the output is total and reproducible.
export function canonicalStringify(value) {
  if (value === null) return "null"
  const t = typeof value
  if (t === "string") return JSON.stringify(value)
  if (t === "number") return Number.isFinite(value) ? String(value) : '"__nonfinite__"'
  if (t === "boolean") return String(value)
  if (t === "bigint") return String(value)
  if (t === "undefined") return '"__undefined__"'
  if (t === "function" || t === "symbol") return '"__nonserializable__"'
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`
  if (t === "object") {
    const obj = value
    const keys = Object.keys(obj).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`).join(",")}}`
  }
  return '"__unknown__"'
}

// ---------------------------------------------------------------------------
// Model detection -> cache-policy family
// ---------------------------------------------------------------------------

// Normalize a model-like object into a searchable haystack. Accepts both the
// full OpenCode Model ({providerID, id, api:{id,npm}, name}) and slim test
// objects ({providerID, modelID/apiID}).
function modelSignals(model) {
  const m = model && typeof model === "object" ? model : {}
  const api = m.api && typeof m.api === "object" ? m.api : {}
  const providerID = String(m.providerID ?? m.provider ?? "")
  const apiID = String(m.modelID ?? api.id ?? m.id ?? m.apiID ?? "")
  const modelID = String(m.id ?? "")
  const npm = String(api.npm ?? m.npm ?? "")
  const name = String(m.name ?? "")
  const slug = `${apiID} ${modelID}`.trim()
  return { providerID, apiID, modelID, npm, name, slug: slug.toLowerCase() }
}

// OpenAI-ish context is required before we apply GPT-5.6 options, so we never
// send GPT-5.6-only fields to a non-OpenAI endpoint merely because a model
// string contains "gpt-5.6". A slug that explicitly starts with openai/ or
// azure/ (typical for openrouter/azure/openai-compatible routes) also counts
// because the upstream IS OpenAI. A bare openai-compatible provider with no
// such slug does NOT count: we must not guess.
function isOpenAIish(s) {
  const { providerID, slug, npm } = s
  const p = providerID.toLowerCase()
  if (p === "openai" || p === "azure") return true
  if (slug.startsWith("openai/") || slug.startsWith("azure/")) return true
  if (/@ai-sdk\/openai|@ai-sdk\/azure/.test(npm)) return true
  return false
}

// The gpt-5.6 family, tolerating OpenCode's variants: gpt-5.6, gpt-5.6-luna,
// gpt-5.6-luna:flex, gpt-5.6-luna-pro:flex, gpt-5.6-<anything>.
// A trailing digit guard avoids matching hypothetical "gpt-5.60" etc.
const GPT56_RE = /gpt-5\.6(?![\d.])/i
// GLM 5.3 family only (not glm-4.x / glm-4.6 etc).
const GLM53_RE = /glm-5\.3(?![\d.])/i
// Xiaomi MiMo V2.6 explicitly targets Flash + Pro only. The trailing
// (?![\w-]) guard prevents matching a hypothetical "mimo-v2.6-pro-ultraspeed"
// or "mimo-v2.6-flashx", and the v2\.6 literal excludes V2.5 / V2.
const MIMO26_RE = /mimo-v2\.6-(flash|pro)(?![\w-])/i
const DEEPSEEK_RE = /deepseek/i

// Pure classifier. Returns one of the POLICY_* keys. `model` may be a full
// OpenCode Model, or {providerID, modelID|apiID|id}.
export function detectPolicy(model) {
  if (!model || typeof model !== "object") return POLICY_NEUTRAL
  const s = modelSignals(model)
  if (!s.slug) return POLICY_NEUTRAL
  if (GPT56_RE.test(s.slug) && isOpenAIish(s)) return POLICY_GPT56
  if (GLM53_RE.test(s.slug)) return POLICY_GLM53
  if (MIMO26_RE.test(s.slug)) return POLICY_MIMO26
  if (DEEPSEEK_RE.test(s.slug) || DEEPSEEK_RE.test(s.providerID)) return POLICY_DEEPSEEK
  return POLICY_NEUTRAL
}

export function policyEnabled(cfg, family) {
  const pol = cfg?.policies?.[family]
  if (!pol) return false
  return pol.enabled !== false
}

// ---------------------------------------------------------------------------
// GPT-5.6 cache options
// ---------------------------------------------------------------------------

// Build the delta to merge into the request's provider options for a GPT-5.6
// model. Conservative: `implicit` mode + a stable session-derived key, only
// added when the fields are not already present (so we never fight the runtime
// or an explicit provider config). No explicit breakpoints by default.
// Returns {} when nothing should change.
//
// `existingOptions` is the outgoing options record (output.options in the
// chat.params hook). We never overwrite what is already there.
export function gptCacheOptionsDelta(existingOptions, { key, mode = GPT56_DEFAULT_MODE, ttl = GPT56_DEFAULT_TTL } = {}) {
  const delta = {}
  if (!existingOptions || typeof existingOptions !== "object") return delta
  if (typeof key === "string" && key.length > 0 && existingOptions.promptCacheKey === undefined) {
    delta.promptCacheKey = key
  }
  const existingMode = existingOptions.promptCacheOptions
  if (existingMode === undefined || existingMode === null) {
    const m = mode === "explicit" ? "explicit" : "implicit"
    delta.promptCacheOptions = { mode: m, ttl: typeof ttl === "string" && ttl.length > 0 ? ttl : GPT56_DEFAULT_TTL }
  }
  return delta
}

// ---------------------------------------------------------------------------
// GLM-5.3 system stabilization
// ---------------------------------------------------------------------------

// The OpenCode system string begins with the agent prompt, then an env block
// ("You are powered by the model named ... Today's date: ... </env>") whose
// only per-day volatile byte is the date line. For GLM-5.3 and MiMo-V2.6 we
// relocate that whole identifiable env block to the END of the system string so
// a daily date change only invalidates the tail of the prompt, leaving the long
// stable prefix intact. Content is preserved byte-for-byte (only position
// changes).
//
// Returns { text, changed }. When the block cannot be identified unambiguously,
// returns the input unchanged (changed:false). This is a content-preserving
// reorder of clearly volatile metadata only -- it never reorders arbitrary
// instructions. This function is ONLY applied when the caller has already
// classified the model into a family that opts into system stabilization.
export function relocateVolatileEnvBlock(text) {
  if (typeof text !== "string") return { text, changed: false }
  const START = "You are powered by the model named "
  const startIdx = text.indexOf(START)
  if (startIdx < 0) return { text, changed: false }
  const endMarker = "</env>"
  const endIdx = text.indexOf(endMarker, startIdx)
  if (endIdx < 0) return { text, changed: false }
  const blockEnd = endIdx + endMarker.length
  const block = text.slice(startIdx, blockEnd)
  const rest = text.slice(0, startIdx) + text.slice(blockEnd)
  if (rest.trim().length === 0) return { text, changed: false }
  const sep = rest.endsWith("\n") ? "" : "\n"
  const out = rest + sep + block
  return { text: out, changed: out !== text }
}

// ---------------------------------------------------------------------------
// Prefix shape diagnostics (decomposition)
//
// The system prefix is a single long string. To answer "did the STABLE prefix
// change?" rather than "did the whole system prompt change?", we compare the
// current system text against the session's first-seen baseline and split at
// the longest common byte prefix: everything up to the first difference is the
// stable prefix; the tail is the volatile suffix (e.g. the relocated env block
// with its daily date).
// ---------------------------------------------------------------------------

export function commonPrefixLength(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return 0
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++
  return i
}

// Returns hash fields for a system observation given the baseline text.
export function systemShapeHashes(baseline, current) {
  const fullSystemHash = shorthash(current)
  const common = commonPrefixLength(baseline, current)
  const stableSystemPrefixHash = shorthash(current.slice(0, common))
  const volatile = current.slice(common)
  const volatileSystemSuffixHash = volatile.length > 0 ? shorthash(volatile) : null
  return { fullSystemHash, stableSystemPrefixHash, volatileSystemSuffixHash }
}

// ---------------------------------------------------------------------------
// Tool fingerprints
// ---------------------------------------------------------------------------

// Keep only the model-visible fields of a tool definition. This intentionally
// drops runtime-only state (object identity, function refs, timestamps,
// arbitrary metadata) that is not part of what the model sees.
export function normalizeTool(tool) {
  const t = tool || {}
  const params = t.parameters === undefined || t.parameters === null ? null : t.parameters
  return {
    id: typeof t.id === "string" ? t.id : String(t.id ?? ""),
    description: typeof t.description === "string" ? t.description : "",
    parameters: params,
  }
}

const canonicalTool = (t) => canonicalStringify(normalizeTool(t))

// SEMANTIC fingerprint: order-INSENSITIVE (sorted). Detects meaningful tool
// definition changes regardless of ordering. Returns null on unusable input.
export function toolFingerprint(tools) {
  if (!Array.isArray(tools)) return null
  const parts = tools.map(canonicalTool).sort()
  return shorthash(parts.join("\u0000"))
}

// WIRE fingerprint: order-SENSITIVE (registry order, i.e. the closest
// deterministic pre-wire representation available to a plugin). The provider
// caches what is actually sent; OpenCode additionally sorts tools
// alphabetically before sending, so registry order is NOT byte-equal to the
// wire. We document that and fingerprint the closest representation rather than
// pretending it is exact.
export function toolWireFingerprint(tools) {
  if (!Array.isArray(tools)) return null
  const parts = tools.map(canonicalTool)
  return shorthash(parts.join("\u0000"))
}

// ---------------------------------------------------------------------------
// Prefix shape comparison
// ---------------------------------------------------------------------------

// Compare a previous observed shape against the current one. A dimension is
// only reported as changed when BOTH sides carry a real (non-null) hash; an
// unknown dimension is never treated as a change. Returns the array of changed
// dimensions ("system", "tools") which is empty when nothing changed.
// System change = the full system hash changed. Tools change = the semantic
// OR the wire tool fingerprint changed (both non-null on each side).
export function shapeDiff(prev, cur) {
  const changed = []
  if (!prev || !cur) return changed
  const full = (v) => v.fullSystemHash ?? v.systemHash
  if (full(prev) != null && full(cur) != null && full(prev) !== full(cur)) changed.push("system")
  const semPrev = prev.semanticToolsHash ?? prev.toolsHash
  const semCur = cur.semanticToolsHash ?? cur.toolsHash
  if (semPrev != null && semCur != null && semPrev !== semCur) changed.push("tools")
  else {
    // wire-only reorder: semantic equal but registry order changed
    const wPrev = prev.wireToolsHash
    const wCur = cur.wireToolsHash
    if (wPrev != null && wCur != null && wPrev !== wCur) changed.push("tools")
  }
  return changed
}

// Granular per-field diff. Returns the list of field names (in `fields`) whose
// value differs between prev and cur while BOTH sides are non-null. Used for
// fine-grained telemetry (stable prefix vs volatile suffix vs wire tools).
export function shapeFieldDiffs(prev, cur, fields) {
  const out = []
  if (!prev || !cur) return out
  for (const f of fields || []) {
    if (prev[f] != null && cur[f] != null && prev[f] !== cur[f]) out.push(f)
  }
  return out
}

// ---------------------------------------------------------------------------
// Usage aggregation
// ---------------------------------------------------------------------------

// cacheHitRate = cache.read / (cache.read + cache.write). Returns null when
// there is no denominator (no read/write tokens observed).
export function hitRatePct(read, write) {
  const denom = read + write
  if (denom <= 0) return null
  return Math.round((100 * read) / denom)
}

// GLM-5.3 hit ratio vs TOTAL prompt tokens: cached / (read + write + input).
// Returns null when the denominator is unknown/zero.
export function glmHitRatio(read, write, input) {
  const denom = read + write + input
  if (denom <= 0 || !Number.isFinite(read)) return null
  return Math.round((100 * read) / denom)
}

// ---------------------------------------------------------------------------
// MiMo-V2.6 cache metrics + sticky-session identity
//
// MiMo caching is provider-managed (implicit context caching). Xiaomi documents
// usage.prompt_tokens_details.cached_tokens as the number of PROMPT tokens
// served from cache and prompt_tokens as the total prompt-token count, so the
// authoritative cache metric is cachedTokens / promptTokens -- NOT the
// read/(read+write) form used by other families. `hitRatePct` is intentionally
// left untouched so existing providers are unaffected.
//
// The runtime exposes `Message.info.tokens` as { input, output, cache:{read,
// write} } where `input` is the NON-cached prompt input and `cache.read` is the
// cached prompt input. Total prompt tokens are therefore derived as
// read + input (cache.write is a separate accounting bucket and is NOT folded
// in). We never fabricate cache-write values.
// ---------------------------------------------------------------------------

// cachedTokens / promptTokens, rounded to a percentage. Returns null when the
// denominator is unknown/zero or the inputs are not finite numbers, so no
// fabricated hit rate is ever emitted.
export function mimoHitRate(cachedTokens, promptTokens) {
  if (!Number.isFinite(cachedTokens) || !Number.isFinite(promptTokens)) return null
  if (promptTokens <= 0 || cachedTokens < 0) return null
  return Math.round((100 * cachedTokens) / promptTokens)
}

// Derive a provider-neutral stable ID from the logical OpenCode session ID.
// The full SHA-256 digest avoids intentional truncation/collapse of distinct
// sessions. This helper only generates an identifier; it does not select a
// provider or inject the identifier into any request transport.
export function stableSessionIdFor(sessionID) {
  if (typeof sessionID !== "string" || sessionID.length === 0) return null
  return `oc-ses-${createHash("sha256").update(sessionID).digest("hex")}`
}

// OpenRouter session affinity is currently eligible only for the two policy
// families with documented affinity use: MiMo-V2.6 and GLM-5.3. This pure
// policy decision is separate from ID generation and transport/header injection.
export function isOpenRouterAffinityEligible(policyFamily, providerID) {
  return (
    providerID === "openrouter" &&
    (policyFamily === POLICY_MIMO26 || policyFamily === POLICY_GLM53)
  )
}

// Produce safe telemetry fields for one affinity-capable request. Provider
// identity is observable and recorded; header values are deliberately not.
// A supplied non-OpenRouter identity is classified from the observed value
// rather than guessed against a provider allowlist.
export function affinityTelemetryFields(policyFamily, providerID, headerSource) {
  if (policyFamily !== POLICY_MIMO26 && policyFamily !== POLICY_GLM53) return null

  const identity = typeof providerID === "string" && providerID.length > 0 ? providerID : null
  const eligible = isOpenRouterAffinityEligible(policyFamily, identity)
  if (!eligible) {
    return {
      reason: identity
        ? "openrouter_affinity_bypassed_non_openrouter"
        : "openrouter_affinity_bypassed_provider_missing_or_unknown",
      eligible: false,
      providerIdentityKnown: identity !== null,
      provider: identity,
      headerPresent: false,
      headerAttached: false,
      headerSource: "not_applicable",
    }
  }

  const source = ["cache_engine", "preexisting", "unavailable"].includes(headerSource)
    ? headerSource
    : "unavailable"
  const headerPresent = source === "cache_engine" || source === "preexisting"
  return {
    reason: "openrouter_affinity_eligible",
    eligible: true,
    providerIdentityKnown: true,
    provider: identity,
    headerPresent,
    headerAttached: source === "cache_engine",
    headerSource: source,
  }
}

// Derive a stable, session-scoped identifier suitable for OpenRouter's
// documented `session_id` sticky-routing key. Pure function of the OpenCode
// session id only: identical sessions map to identical ids, distinct sessions
// map to distinct ids, and transient request contents cannot influence it. The
// value is printable, contains no whitespace, and is far below the 256-char cap
// (25 chars). The plugin uses it as the existing OpenRouter x-session-id header
// value for eligible MiMo/GLM requests.
export function mimoSessionIdFor(sessionID) {
  if (typeof sessionID !== "string" || sessionID.length === 0) return null
  return `mimo-ses-${shorthash(sessionID)}`
}

// Detect a provider switch within the same session. `previous` and `current`
// are {providerID, modelID} observations. Returns {changed:false} until two
// real observations exist; a change is only reported when both are known and
// the providerID differs. Never forces or overrides provider selection.
export function providerChangeEvent(previous, current) {
  const prev = previous && typeof previous.providerID === "string" ? previous.providerID : null
  const cur = current && typeof current.providerID === "string" ? current.providerID : null
  if (prev == null || cur == null || prev === cur) return { changed: false, from: null, to: null }
  return { changed: true, from: previous, to: current }
}

// Decide whether a `usage` record should be emitted for an aggregation sample.
// We must not fabricate a zero-valued cache event merely because the session
// became idle: a sample only counts when at least one assistant message with
// cache token data was aggregated.
export function shouldAggregate(count, read, write) {
  return count > 0 && (read > 0 || write > 0)
}

// ---------------------------------------------------------------------------
// Message scanning / cursor
//
// `client.session.messages` returns messages newest-first (confirmed against
// the runtime). We track a single stable boundary: `lastProcessedMessageID`.
// Everything NEWER than the boundary is unprocessed; scanning stops as soon as
// the boundary is reached, so repeated `session.idle` events never double-count
// historical messages and no unbounded per-message Set is required.
// ---------------------------------------------------------------------------

function reasoningHashesFor(m) {
  const parts = m && m.parts
  if (!Array.isArray(parts)) return []
  const hashes = []
  for (const p of parts) {
    if (p && p.type === "reasoning" && typeof p.text === "string" && p.text.length > 0) {
      hashes.push(shorthash(p.text))
    }
  }
  return hashes
}

// page: Array<{ info: { id, role, tokens }, parts }>, newest-first.
// startCursor: lastProcessedMessageID or null (first aggregation).
// Returns sums for the unprocessed segment plus scan bookkeeping.
export function scanPage(page, startCursor) {
  let read = 0
  let write = 0
  let input = 0
  let count = 0
  let reachedStart = false
  const seenIds = []
  const reasoning = []
  for (const m of page || []) {
    const info = m && m.info
    const id = info && info.id
    if (typeof id !== "string" || id.length === 0) continue
    if (startCursor != null && id === startCursor) {
      reachedStart = true
      break
    }
    seenIds.push(id)
    if (info.role !== "assistant") continue
    const t = info.tokens
    if (t) {
      read += t.cache && Number.isFinite(t.cache.read) ? t.cache.read : 0
      write += t.cache && Number.isFinite(t.cache.write) ? t.cache.write : 0
      input += Number.isFinite(t.input) ? t.input : 0
      count += 1
      const rh = reasoningHashesFor(m)
      if (rh.length > 0) reasoning.push({ id, hashes: rh })
    }
  }
  return { read, write, input, count, reachedStart, seenIds, reasoning }
}

// Compute the new `lastProcessedMessageID` after scanning.
//
// Messages append at the TOP of a newest-first list, so the correct boundary is
// the NEWEST message that has been processed (the first element of the first
// scanned page): the next aggregation scans down from the top and stops as soon
// as it reaches that boundary. When the tail of the session was reached without
// ever hitting the boundary (e.g. the old boundary was pruned), we still know
// every message on the first scanned page was new and processed, so the newest
// of those becomes the new boundary.
export function nextProcessedCursor(firstPage, startCursor) {
  if (!Array.isArray(firstPage) || firstPage.length === 0) return startCursor
  const newest = firstPage[0]
  const id = newest && newest.info && newest.info.id
  return typeof id === "string" && id.length > 0 ? id : startCursor
}

// ---------------------------------------------------------------------------
// Reasoning-integrity diagnostics (GLM-5.3 preserved thinking)
//
// INSTRUMENTATION ONLY. The plugin never rewrites, deletes, reorders, or
// deduplicates reasoning content. GLM preserved thinking is cache-friendly
// ONLY when the previous reasoning_content is replayed complete, unmodified,
// and in original order; duplicated or reordered reasoning can explode context
// and destroy cache efficiency. We detect such anomalies and record counts
// (never content).
// ---------------------------------------------------------------------------

// currentSeq: reasoning-part hashes of the newest assistant message, in order.
// lastSeq:     reasoning-part hashes of the previous assistant message.
// seen:        Set/Map of reasoning hashes seen in EARLIER messages.
// Returns counts; reordered is only meaningful when the same multiset of blocks
// reappears in a different order (a faithful replay that got shuffled).
// modified is only meaningful when a same-cardinality block sequence partially
// overlaps the previous one (a replay in which some block content was swapped).
export function detectReasoningIssues(currentSeq, lastSeq, seen) {
  const out = { withinDuplicates: 0, crossDuplicates: 0, reordered: false, modified: false }
  if (!Array.isArray(currentSeq) || currentSeq.length === 0) return out

  // duplicated identical reasoning objects within one message
  out.withinDuplicates = currentSeq.length - new Set(currentSeq).size

  // blocks that were already seen in earlier messages (duplicate replay)
  const firstIdx = new Map()
  currentSeq.forEach((h, i) => {
    if (!firstIdx.has(h)) firstIdx.set(h, i)
  })
  let cross = 0
  for (const [h, i] of firstIdx) {
    if (seen && seen.has && seen.has(h)) cross += 1
  }
  out.crossDuplicates = cross

  // reordered historical reasoning: same multiset as the previous message but a
  // different sequence (only comparable when both are non-empty and equal-sized)
  if (Array.isArray(lastSeq) && lastSeq.length > 0 && lastSeq.length === currentSeq.length) {
    const sameSet = lastSeq.every((h) => firstIdx.has(h))
    const sameOrder = lastSeq.every((h, i) => h === currentSeq[i])
    if (sameSet && !sameOrder) out.reordered = true
    else if (!sameSet) {
      // same cardinality, partial overlap -> a block was substituted
      const overlap = lastSeq.filter((h) => firstIdx.has(h)).length
      if (overlap > 0 && overlap < lastSeq.length) out.modified = true
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// GPT-5.6 cache root + namespace keys
//
// The GPT prompt_cache_key should represent the CACHE ROOT of the session tree
// (the topmost ancestor that a forked/child session shares a prompt prefix
// with), not the raw session id. In this OpenCode version (1.18.27) the
// canonical lineage field is Session.parentID (DB session.parent_id); it is
// populated when a session is created via Session.create({parentID}) -- the
// task/subagent tool does this (task.ts:159) -- but session.fork (message-copy)
// does NOT set it (verified empirically: forked children have empty parent_id).
// So root resolution climbs the parentID chain when present, and otherwise falls
// back to the session itself as root; the fallback is surfaced in telemetry.
// ---------------------------------------------------------------------------

// provider-safe length cap for prompt_cache_key values (session ids are ~24ch)
export const GPT_KEY_MAX_LENGTH = 256

// Pure root resolver over a synchronous parent lookup (used in tests; the
// plugin feeds it an async-backed chain built from client.session.get). Walks
// from `start` up parentID links until none/unknown/cycle/depth-cap.
// parentOf(id) => parent session id | null | undefined.
export function resolveCacheRootSync(start, parentOf, { maxHops = 16 } = {}) {
  const seen = new Set()
  let cur = start
  let hops = 0
  let source = "self"
  while (typeof cur === "string" && cur.length > 0 && hops < maxHops) {
    if (seen.has(cur)) {
      source = "cycle"
      break
    }
    seen.add(cur)
    let parent
    try {
      parent = parentOf(cur)
    } catch {
      source = "unknown"
      break
    }
    if (parent == null || typeof parent !== "string" || parent.length === 0 || parent === cur) break
    if (seen.has(parent)) {
      source = "cycle"
      cur = parent
      hops++
      break
    }
    cur = parent
    hops++
    source = "parent"
  }
  if (hops >= maxHops && source === "parent") source = "depth"
  return { root: typeof cur === "string" ? cur : start, hops, source }
}

// GPT prompt_cache_key for a given namespace. Compaction requests for the same
// cache root get a deterministic, stable, distinct namespace so a compaction
// cache write never interferes with the live-session cache. Returns null when
// the derived key would exceed provider constraints.
export function gptCacheKeyFor(cacheRoot, { compaction = false } = {}) {
  if (typeof cacheRoot !== "string" || cacheRoot.length === 0) return null
  const key = compaction ? `${cacheRoot}:compact` : cacheRoot
  return key.length <= GPT_KEY_MAX_LENGTH ? key : null
}

// ---------------------------------------------------------------------------
// GPT-5.6 reasoning-effort diagnostics
//
// This runtime exposes the effective GPT reasoning effort on the merged options
// record seen by chat.params as `reasoningEffort` (flat camelCase; the runtime
// defaults gpt-5.x non-pro models to "medium" in ProviderTransform.options()).
// We only OBSERVE it across requests for the same session/cache root; we never
// change it. Unknown/absent is reported as unknown and never fabricates a value
// or a false change.
// ---------------------------------------------------------------------------

// Extract the reasoning-effort value from the chat.params options record.
// Returns { known, value } where value is a string when known, else null.
export function reasoningEffortFromOptions(options) {
  const o = options && typeof options === "object" ? options : {}
  const direct = o.reasoningEffort
  if (typeof direct === "string" && direct.length > 0) return { known: true, value: direct }
  // openrouter-style nesting: reasoning.effort
  const nested = o.reasoning && typeof o.reasoning === "object" ? o.reasoning.effort : undefined
  if (typeof nested === "string" && nested.length > 0) return { known: true, value: nested }
  return { known: false, value: null }
}

// Step the reasoning-effort observer for one request.
// state: { known, value } (previous observation) or null (first observation).
// current: output of reasoningEffortFromOptions.
// Returns { event: "none"|"baseline"|"change", state, previous, current }.
// Rules:
//   - first observation establishes the baseline (no change event)
//   - unknown current => never a change; baseline stays unknown until a value
//   - known value differing from a known baseline => "change"
export function observeReasoningEffort(state, current) {
  if (!state || (state.known !== true && state.value === undefined)) {
    return { event: "baseline", state: { known: current.known, value: current.value }, previous: null, current }
  }
  if (!current.known) {
    return { event: "none", state, previous: state, current }
  }
  if (state.known && state.value === current.value) {
    return { event: "none", state, previous: state, current }
  }
  return { event: "change", state: { known: true, value: current.value }, previous: state, current }
}

// ---------------------------------------------------------------------------
// Boundary reason classification (structured, local diagnostics only)
//
// These tokens describe WHICH structural dimension changed. They are causal
// diagnostics for the *observed* prefix shape -- never a claim that the
// provider cache key changed or that a cache miss occurred. The authoritative
// signal remains provider-reported usage.
// ---------------------------------------------------------------------------

// Map granular changed shape fields to structured reason tokens.
export function prefixChangeReasons(changedFields) {
  const out = []
  for (const f of changedFields || []) {
    if (f === "stableSystemPrefixHash") out.push("system_stable_prefix_changed")
    else if (f === "volatileSystemSuffixHash") out.push("system_volatile_suffix_changed")
    else if (f === "semanticToolsHash") out.push("tools_semantic_changed")
    else if (f === "wireToolsHash") out.push("tools_wire_changed")
    else if (f === "fullSystemHash") {
      // full changed but neither stable nor volatile reported granularly
      if (!changedFields.includes("stableSystemPrefixHash") && !changedFields.includes("volatileSystemSuffixHash")) {
        out.push("system_stable_prefix_changed")
      }
    }
  }
  if (out.length === 0) out.push("unknown")
  return out
}

// Map reasoning-integrity flags to reason tokens (empty when none).
export function reasoningIssueReasons(issues) {
  const out = []
  if (!issues) return out
  if (issues.withinDuplicates > 0) out.push("reasoning_duplicate_detected")
  if (issues.crossDuplicates > 0) out.push("reasoning_duplicate_detected")
  if (issues.reordered) out.push("reasoning_reordered")
  if (issues.modified) out.push("reasoning_modified")
  return out
}

// ---------------------------------------------------------------------------
// Compaction digest dedup guard
// ---------------------------------------------------------------------------

// Returns true when the digest template should be appended for this compaction
// invocation. Prevents duplicate insertion if the hook fires more than once for
// the same compaction operation.
export function digestDecision({ compactTemplate, pendingInsert }) {
  return compactTemplate === true && pendingInsert === true
}
