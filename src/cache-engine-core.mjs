// cache-engine-core.mjs
//
// Pure, dependency-light logic for the cache-engine plugin. Kept in plain JS so
// the unit tests (cache-engine.test.mjs) can `import` it under Node without a
// TypeScript compiler. The plugin entry (cache-engine.ts) imports this module.
//
// This module is PROVIDER-AWARE: it classifies a model into a cache-policy
// family (deepseek | gpt56 | glm53 | mimo26 | kimi | claude | gemini | qwen |
// grok | muse | minimax | neutral) and exposes small pure helpers for each
// family's strategy. The plugin entry (cache-engine.ts) remains
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
import { resolveLegacyFamily } from "./cache-policy-core.mjs"
import { shorthash } from "./cache-usage-core.mjs"

// Usage/accounting primitives live in the runtime-independent cache-usage-core
// module; re-exported here so the existing public surface is unchanged.
export {
  shorthash,
  hitRatePct,
  glmHitRatio,
  mimoHitRate,
  shouldAggregate,
  scanPage,
  nextProcessedCursor,
} from "./cache-usage-core.mjs"

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
export const POLICY_KIMI = "kimi"
export const POLICY_CLAUDE = "claude"
export const POLICY_GEMINI = "gemini"
export const POLICY_QWEN = "qwen"
export const POLICY_GROK = "grok"
export const POLICY_MUSE = "muse"
export const POLICY_MINIMAX = "minimax"
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
      // Experimental (P2-T2): relocate the standalone daily date line to the
      // system tail. Content-preserving; default OFF until provider-side evidence
      // shows repeatable cache benefit (plan §6). Controlled independently of
      // stabilizeSystem.
      stabilizeDate: false,
      preserveThinkingIntegrity: true,
    },
    mimo26: {
      enabled: true,
      stabilizeSystem: true,
      // See glm53.stabilizeDate: experimental date-line relocation, default OFF.
      stabilizeDate: false,
      stickySession: true,
      // MiMo reasoning diagnostics are instrumentation only. Unlike GLM
      // preserved thinking, there is no evidence that MiMo prompt-cache reuse
      // depends on reasoning replay, so this never rewrites reasoning content.
      preserveThinkingIntegrity: true,
    },
    // Kimi is a passive family (Moonshot caching is automatic); the entry exists
    // for consistency with the other families and so a future Kimi overlay can
    // gate on `enabled` like the rest.
    kimi: { enabled: true },
    // Claude is passive: OpenCode already applies Anthropic cache_control
    // breakpoints, so CacheEngine classifies and accounts but does not mutate.
    claude: { enabled: true },
    // Gemini is passive: Google's implicit caching is provider-managed and
    // OpenCode's applyCaching gate excludes Gemini, so CacheEngine classifies
    // and accounts but does not mutate.
    gemini: { enabled: true },
    // Qwen is passive on every route: Alibaba/DashScope implicit caching is
    // provider-managed, OpenCode already applies Anthropic-style breakpoints on
    // the Qwen Messages routes, and the V1 hook cannot place the documented
    // block-level marker on the others. Classification/observability only.
    qwen: { enabled: true },
    // Grok is passive on every route: xAI caching is automatic/provider-managed
    // and the harness (OpenCode) already supplies the Responses affinity key for
    // direct xAI, so CacheEngine only classifies and observes.
    grok: { enabled: true },
    // Muse is passive on every route: Meta caching is automatic, the
    // prompt_cache_key routing hint must be application-stable (never
    // per-session), and retention is harness/user-owned. Classification and
    // observability only.
    muse: { enabled: true },
    // MiniMax is passive on every route: caching is automatic, OpenCode already
    // owns the Anthropic cache_control breakpoints on the @ai-sdk/anthropic
    // routes, and M2.x write billing is represented in the baseline only.
    minimax: { enabled: true },
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

// Precedence: defaults -> configuration file -> environment override. An
// explicit CACHE_ENGINE_METRICS_FILE always wins over the file. Invalid input
// falls back to defaults. Returns a fresh object; never mutates callers.
export function parseConfig(raw, env) {
  const cfg = defaultConfig()
  if (raw && typeof raw === "object") {
    if (typeof raw.enabled === "boolean") cfg.enabled = raw.enabled
    if (typeof raw.metricsFile === "string" && raw.metricsFile.length > 0) cfg.metricsFile = expandHome(raw.metricsFile)
    if (typeof raw.compactTemplate === "boolean") cfg.compactTemplate = raw.compactTemplate
    if (typeof raw.logPrefixChanges === "boolean") cfg.logPrefixChanges = raw.logPrefixChanges
    if (raw.policies && typeof raw.policies === "object") {
      const d = defaultPolicies()
      for (const fam of ["deepseek", "gpt56", "glm53", "mimo26", "kimi", "claude", "gemini", "qwen", "grok", "muse", "minimax"]) {
        if (raw.policies[fam]) cfg.policies[fam] = parsePolicy(raw.policies[fam], d[fam])
      }
    }
  }
  // Explicit environment override applied LAST so it takes precedence.
  const e = env || {}
  if (typeof e.CACHE_ENGINE_METRICS_FILE === "string" && e.CACHE_ENGINE_METRICS_FILE.length > 0) {
    cfg.metricsFile = expandHome(e.CACHE_ENGINE_METRICS_FILE)
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
//
// `shorthash` (the shared 16-hex-char digest) now lives in cache-usage-core.mjs
// and is imported above.
// ---------------------------------------------------------------------------

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
//
// Classification now lives in the structured registry/resolver in
// cache-policy-core.mjs (traceable to docs/cache-policy-inventory.md).
// detectPolicy() remains a compatibility wrapper over resolveLegacyFamily() so
// runtime behavior is unchanged until the resolver is wired in a later release.
// ---------------------------------------------------------------------------

const LEGACY_FAMILY_TO_POLICY = {
  "gpt-5.6": POLICY_GPT56,
  "glm-5.3": POLICY_GLM53,
  "mimo-v2.6": POLICY_MIMO26,
  deepseek: POLICY_DEEPSEEK,
  kimi: POLICY_KIMI,
  claude: POLICY_CLAUDE,
  gemini: POLICY_GEMINI,
  qwen: POLICY_QWEN,
  grok: POLICY_GROK,
  muse: POLICY_MUSE,
  minimax: POLICY_MINIMAX,
}

// Pure classifier. Returns one of the POLICY_* keys. `model` may be a full
// OpenCode Model, or {providerID, modelID|apiID|id}. Newer generations (e.g.
// gpt-6) and intra-family exact overlays intentionally resolve to neutral here,
// exactly as before v0.4.0; use resolvePolicy() for the richer structured result.
export function detectPolicy(model) {
  return LEGACY_FAMILY_TO_POLICY[resolveLegacyFamily(model)] ?? POLICY_NEUTRAL
}

export function policyEnabled(cfg, family) {
  const pol = cfg?.policies?.[family]
  if (!pol) return false
  return pol.enabled !== false
}

// ---------------------------------------------------------------------------
// GPT-5.6 cache options
// ---------------------------------------------------------------------------

// GPT prompt-cache option field names differ by transport.
//
// The AI SDK's OpenAI and Azure providers accept camelCase options
// (`promptCacheKey` / `promptCacheOptions`) and serialize them to the snake_case
// wire fields (`prompt_cache_key` / `prompt_cache_options`). The OpenRouter AI
// SDK provider does NOT translate: it spreads `providerOptions.openrouter`
// verbatim into the request body, so OpenRouter must be given the snake_case
// wire names directly, otherwise the fields are ignored upstream.
//
// Verified by capturing the serialized request body with the exact installed
// versions: @openrouter/ai-sdk-provider@2.9.0, @ai-sdk/openai@3.0.88,
// @ai-sdk/azure@3.0.93, ai@6.0.168.
const GPT_CACHE_FIELDS_CAMEL = { key: "promptCacheKey", options: "promptCacheOptions" }
const GPT_CACHE_FIELDS_SNAKE = { key: "prompt_cache_key", options: "prompt_cache_options" }

export function gptCacheOptionFieldNames({ providerID, npm } = {}) {
  // Normalize defensively (the same boundary rule the chat.headers affinity gate
  // uses): casing/whitespace must never select camelCase fields for an
  // OpenRouter request, because OpenRouter forwards providerOptions verbatim and
  // silently ignores camelCase cache fields.
  const normalizedProviderID = String(providerID ?? "").trim().toLowerCase()
  const openrouter = normalizedProviderID === "openrouter" || npm === "@openrouter/ai-sdk-provider"
  return openrouter ? { ...GPT_CACHE_FIELDS_SNAKE } : { ...GPT_CACHE_FIELDS_CAMEL }
}

// Build the delta to merge into the request's provider options for a GPT-5.6
// model. Conservative: `implicit` mode + a stable session-derived key, only
// added when the fields are not already present (so we never fight the runtime
// or an explicit provider config). No explicit breakpoints by default.
// Returns {} when nothing should change.
//
// `existingOptions` is the outgoing options record (output.options in the
// chat.params hook). `fieldNames` selects the transport's field names; it
// defaults to the camelCase options the OpenAI/Azure SDK expects.
export function gptCacheOptionsDelta(
  existingOptions,
  { key, mode = GPT56_DEFAULT_MODE, ttl = GPT56_DEFAULT_TTL, fieldNames = GPT_CACHE_FIELDS_CAMEL } = {},
) {
  const delta = {}
  if (!existingOptions || typeof existingOptions !== "object") return delta
  const fields = { ...GPT_CACHE_FIELDS_CAMEL, ...(fieldNames || {}) }
  if (typeof key === "string" && key.length > 0 && existingOptions[fields.key] === undefined) {
    delta[fields.key] = key
  }
  const existingMode = existingOptions[fields.options]
  if (existingMode === undefined || existingMode === null) {
    const m = mode === "explicit" ? "explicit" : "implicit"
    delta[fields.options] = { mode: m, ttl: typeof ttl === "string" && ttl.length > 0 ? ttl : GPT56_DEFAULT_TTL }
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
// stable prefix intact. The block's content is preserved and the non-empty line
// multiset is unchanged; the reorder is deterministic and idempotent. It is NOT
// always a byte-for-byte permutation: when the surviving text does not already
// end in a newline, exactly one separator "\n" is inserted before the moved
// block, so the output may be one byte longer than the input.
//
// Returns { text, changed }. When the block cannot be identified unambiguously,
// returns the input unchanged (changed:false). This is a content-preserving
// reorder of clearly volatile metadata only -- it never reorders arbitrary
// instructions. This function is ONLY applied when the caller has already
// classified the model into a family that opts into system stabilization.
function countOccurrences(haystack, needle) {
  if (!needle) return 0
  let count = 0
  let idx = haystack.indexOf(needle)
  while (idx !== -1) {
    count += 1
    idx = haystack.indexOf(needle, idx + needle.length)
  }
  return count
}

// Relocate a single identifiable volatile environment block to the end of the
// string. The block's content is preserved and the non-empty line multiset is
// unchanged; the reorder is deterministic and idempotent, and is NOT always a
// byte-for-byte permutation (a single separator "\n" may be inserted before the
// moved block when the surviving text does not already end in a newline). Two
// shapes are recognized; both require exactly one `<env>`/`</env>` pair, and
// anything ambiguous or unrecognized is returned unchanged.
//   1. Legacy (V1) shape: a single "You are powered by the model named " marker
//      immediately preceding the block; the marker..`</env>` span is moved.
//   2. Structural (OpenCode 2.0.26+) shape: no model-name marker; the block is
//      eligible only when its first non-empty interior line is the OpenCode
//      environment field "Working directory:" AND it also carries a "Platform:"
//      field — this scopes relocation to OpenCode's own environment preamble and
//      never to arbitrary text.
export function relocateVolatileEnvBlock(text) {
  if (typeof text !== "string") return { text, changed: false }
  const OPEN = "<env>"
  const CLOSE = "</env>"
  const START = "You are powered by the model named "
  if (countOccurrences(text, OPEN) !== 1) return { text, changed: false }
  if (countOccurrences(text, CLOSE) !== 1) return { text, changed: false }
  const openIdx = text.indexOf(OPEN)
  const closeIdx = text.indexOf(CLOSE)
  if (!(openIdx < closeIdx)) return { text, changed: false }
  // Legacy marker span takes precedence when present (preserves the V1 contract).
  if (countOccurrences(text, START) === 1) {
    const startIdx = text.indexOf(START)
    if (startIdx < openIdx) return relocateRange(text, startIdx, closeIdx + CLOSE.length)
    // The model-name marker exists but does not precede the block: an ambiguous
    // legacy shape. Leave it unchanged (prior V1 behavior) rather than falling
    // through to the structural path.
    return { text, changed: false }
  }
  // Structural shape: the single env block must look like OpenCode's own.
  const interior = text.slice(openIdx + OPEN.length, closeIdx)
  if (isOpenCodeEnvInterior(interior)) return relocateRange(text, openIdx, closeIdx + CLOSE.length)
  return { text, changed: false }
}

// Move text[startIdx,endIdx) to the end. The moved block's bytes are preserved
// and the non-empty line multiset is unchanged; the reorder is deterministic and
// idempotent. When the remaining text does not already end in a newline, a
// single separator "\n" is inserted before the moved block, so the result may be
// one byte longer than the input. Returns unchanged when the remaining text is
// empty.
function relocateRange(text, startIdx, endIdx) {
  const block = text.slice(startIdx, endIdx)
  const rest = text.slice(0, startIdx) + text.slice(endIdx)
  if (rest.trim().length === 0) return { text, changed: false }
  const sep = rest.endsWith("\n") ? "" : "\n"
  const out = rest + sep + block
  return { text: out, changed: out !== text }
}

// Narrow structural eligibility for OpenCode's own environment block (see
// RF-OC-033). The block must start with the "Working directory:" field AND carry
// the "Platform:" field; requiring both scopes relocation to OpenCode's
// environment preamble and rejects arbitrary text that merely begins with
// "Working directory:".
function isOpenCodeEnvInterior(interior) {
  const lines = interior
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  if (lines.length === 0) return false
  if (!lines[0].startsWith("Working directory:")) return false
  return lines.some((l) => l.startsWith("Platform:"))
}

// ---------------------------------------------------------------------------
// Daily-date-line relocation
// ---------------------------------------------------------------------------
// The OpenCode 2.0.26 system prefix carries the daily date as a standalone line
// ("Today's date: Wed Oct 14 2026") OUTSIDE the <env> block, immediately before
// it -- the only per-day volatile byte in that part. For the families that opt
// into system stabilization, move ONLY that date line to the end of the
// containing system text, so a daily rollover invalidates the smallest possible
// tail. This is content-preserving in the same sense as
// relocateVolatileEnvBlock: the moved line's bytes and the non-empty line
// multiset are preserved, all other bytes (including newlines/blank lines) are
// byte-for-byte unchanged, and at most one separator "\n" is inserted when the
// surviving text does not already end in a newline. It NEVER changes the date
// value/format and NEVER pins it.
//
// Returns { text, changed }. Unchanged (no-op) unless there is EXACTLY ONE
// well-formed, standalone date line that is NOT inside the <env> block. The
// legacy 1.18.x shape keeps the date inside <env>, where the existing block
// relocation already moves it to the tail; missing / duplicate / malformed /
// ambiguous date lines are likewise a no-op.
const RE_DATE_LINE = /^Today's date:\s*(\S.*)$/i
const RE_DATE_VALUE = /^(?:\d{4}-\d{2}-\d{2}|[A-Za-z]{3,9}\s+[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})$/

export function relocateVolatileDateLine(text) {
  if (typeof text !== "string") return { text, changed: false }
  const lines = text.split("\n")
  // The anchor label must appear EXACTLY ONCE and carry a well-formed value. A
  // second label (even with a malformed/empty value) is ambiguous -> no-op.
  let idx = -1
  for (let i = 0; i < lines.length; i++) {
    const m = RE_DATE_LINE.exec(lines[i])
    if (!m) continue
    if (idx !== -1) return { text, changed: false } // second label -> ambiguous
    if (!RE_DATE_VALUE.test(m[1].trim())) return { text, changed: false } // malformed value
    idx = i
  }
  if (idx === -1) return { text, changed: false } // absent
  // The <env> structure must be well-formed (at most one marker pair), and the
  // date must not sit inside it. This mirrors the sibling <env> helper's
  // single-pair guard so we never relocate a date that belongs to a block.
  const openN = countOccurrences(text, "<env>")
  const closeN = countOccurrences(text, "</env>")
  if (openN !== closeN || openN > 1) return { text, changed: false }
  if (openN === 1) {
    const open = lines.findIndex((l) => l.includes("<env>"))
    const close = lines.findIndex((l) => l.includes("</env>"))
    if (open < idx && idx < close) return { text, changed: false }
  }
  // Already at the tail (only blank lines follow) -> no-op (no churn).
  if (lines.slice(idx + 1).every((l) => l.trim() === "")) return { text, changed: false }
  let start = 0
  for (let i = 0; i < idx; i++) start += lines[i].length + 1
  return relocateRange(text, start, start + lines[idx].length)
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
  // Byte length of the stable prefix = the first-differing byte offset (relative
  // to the session baseline). Persisted as `systemStablePrefixLength` so a change
  // can be located by byte offset, not only by hash.
  return { fullSystemHash, stableSystemPrefixHash, volatileSystemSuffixHash, stablePrefixLength: common }
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
// First-difference reporting and the silent-invalidator linter
// ---------------------------------------------------------------------------

// Byte-level first difference between two system texts. `firstDiffOffset` is the
// length of the longest common prefix (0 when the first byte differs; the full
// length when identical). Read-only; never mutates its inputs. This is the
// primitive behind "locate the exact byte that changed".
export function firstSystemDifference(baseline, current) {
  const a = typeof baseline === "string" ? baseline : ""
  const b = typeof current === "string" ? current : ""
  const firstDiffOffset = commonPrefixLength(a, b)
  return {
    equal: a === b,
    firstDiffOffset,
    beforeLength: a.length,
    afterLength: b.length,
  }
}

// Default severities live in one table. `effectiveSeverity` is the single source
// of truth: allow-listed rules are FORCED to `info`, so an allow-listed rule can
// never emit a high-severity finding even if its default severity is changed.
const VOLATILITY_RULES = Object.freeze({
  "VOL-TIMESTAMP": "high",
  "VOL-SESSION-ID": "high",
  "VOL-TOOL-SET": "high",
  "VOL-TOOL-ORDER": "medium",
  // Reserved: reliably detecting these needs delta/serialization evidence a
  // single snapshot cannot supply; not emitted, to avoid false positives.
  "VOL-CONDITIONAL": "medium",
  "VOL-NONDET-JSON": "medium",
  "VOL-DYNAMIC-BEFORE-STABLE": "medium",
  "VOL-DATE": "info",
  "VOL-CWD-PATH": "info",
})

// Rules whose volatility is expected; forced to `info` regardless of the table.
const LINTER_ALLOWLIST = new Set(["VOL-DATE", "VOL-CWD-PATH"])
const LINTER_MAX_TEXT = 200_000

// Deterministic effective severity for a rule. Allow-listed rules are pinned to
// `info`; any other rule uses its declared default (falling back to `medium`).
// Exported so the policy is directly testable.
export function effectiveSeverity(ruleId, defaultSeverity) {
  if (LINTER_ALLOWLIST.has(ruleId)) return "info"
  return defaultSeverity ?? VOLATILITY_RULES[ruleId] ?? "medium"
}

// Normalize the set of high-severity rule IDs deterministically: sorted, unique,
// joined. Returns null when there are no high findings. Pure; stores no content.
export function volatilitySignature(findings) {
  const high = [...new Set((findings || []).filter((f) => f && f.severity === "high").map((f) => f.ruleId))].sort()
  return high.length > 0 ? high.join(",") : null
}

// Decide whether to emit a `system_volatility` boundary record given the previous
// per-session signature. Emits only on transition into a high-severity state or
// when the rule set changes; a cleared state (null) resets so a later recurrence
// emits again. Pure and bounded — the persisted value is only the signature.
export function volatilityTransition(prevSignature, findings) {
  const signature = volatilitySignature(findings)
  const emit = signature !== null && signature !== prevSignature
  return { signature, emit, rules: signature ? signature.split(",") : [] }
}

function systemTextOf(parts) {
  if (parts == null) return ""
  const pick = (p) => (typeof p === "string" ? p : typeof p?.text === "string" ? p.text : "")
  const joined = Array.isArray(parts) ? parts.map(pick).join("\n") : pick(parts)
  // Bound work on pathological inputs; never throw.
  return joined.length > LINTER_MAX_TEXT ? joined.slice(0, LINTER_MAX_TEXT) : joined
}

// A timestamp must carry a time-of-day (the date-only case is VOL-DATE), so a
// plain `2026-10-14` does not trip this rule.
const RE_TIMESTAMP =
  /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?\b|\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/
const RE_DATE = /\b\d{4}-\d{2}-\d{2}\b|\b(?:today'?s date|current date)\b/i
// Strong session-id forms (always high): OpenCode `ses_…` and UUIDs.
const RE_SESSION_ID_STRONG =
  /\bses_[A-Za-z0-9]{8,}\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i
// A bare 32-hex token is ambiguous (it can be a content hash), so it is only a
// finding when session-related context is nearby.
const RE_HEX32 = /\b[0-9a-f]{32}\b/i
const RE_SESSION_CONTEXT = /\b(?:session|conversation|chat)[ _-]?(?:id|key|token)?\b/i
const RE_CWD =
  /\b(?:working directory|cwd|worktree)\s*[:=]\s*\S|(?:^|\s)\/(?:home|Users|root)\/\S|(?:^|\s)[A-Za-z]:\\/i

// Silent-invalidator linter (read-only, advisory). Operates on the rendered
// system text parts and, optionally, the current tool list. Returns findings
// keyed by stable rule IDs; it NEVER rewrites the request.
//
// Severity is resolved through `effectiveSeverity`, so allow-listed rules are
// always `info`. Tool rules compare only when BOTH the current and previous tool
// snapshots are explicitly supplied as arrays; an omitted snapshot is never
// treated as an empty one.
export function lintSystemVolatility(parts, tools, options = {}) {
  const findings = []
  const push = (ruleId, detail) =>
    findings.push({
      ruleId,
      severity: effectiveSeverity(ruleId, VOLATILITY_RULES[ruleId]),
      detail,
      allowlisted: LINTER_ALLOWLIST.has(ruleId),
    })

  const text = systemTextOf(parts)

  if (RE_TIMESTAMP.test(text)) push("VOL-TIMESTAMP", "wall-clock timestamp in system text")

  if (RE_SESSION_ID_STRONG.test(text)) {
    push("VOL-SESSION-ID", "session identifier in system text")
  } else if (RE_HEX32.test(text)) {
    const m = text.match(RE_HEX32)
    const idx = m ? m.index : -1
    const window = idx >= 0 ? text.slice(Math.max(0, idx - 48), idx + 48 + 32) : ""
    // Only high when session-related context is adjacent; a stable hash with no
    // context is intentionally not a finding (avoids a high false positive).
    if (RE_SESSION_CONTEXT.test(window)) {
      push("VOL-SESSION-ID", "hex session identifier with session context")
    }
  }

  if (RE_CWD.test(text)) push("VOL-CWD-PATH", "absolute cwd/worktree path in system text")
  if (RE_DATE.test(text)) push("VOL-DATE", "date line in system text")

  const prev = options?.previousTools
  if (Array.isArray(prev) && Array.isArray(tools)) {
    const curIds = tools.map((t) => String(t?.id ?? ""))
    const prevIds = prev.map((t) => String(t?.id ?? ""))
    const prevSet = new Set(prevIds)
    const setChanged =
      curIds.length !== prevIds.length || curIds.some((id) => !prevSet.has(id))
    if (setChanged) {
      push("VOL-TOOL-SET", "tool set changed")
    } else if (curIds.join("\u0000") !== prevIds.join("\u0000")) {
      push("VOL-TOOL-ORDER", "tool order changed")
    }
  }

  const highCount = findings.filter((f) => f.severity === "high").length
  const worstSeverity = findings.some((f) => f.severity === "high")
    ? "high"
    : findings.some((f) => f.severity === "medium")
      ? "medium"
      : findings.length > 0
        ? "info"
        : "none"
  return { findings, highCount, worstSeverity }
}

// ---------------------------------------------------------------------------
// Usage aggregation helpers (hitRatePct / glmHitRatio / mimoHitRate) and the
// message-scan/cursor helpers now live in cache-usage-core.mjs and are
// re-exported above; only identity and diagnostics remain in this module.
// ---------------------------------------------------------------------------

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

// Usage-emission + message-scan/cursor helpers now live in cache-usage-core.mjs
// (re-exported above). Only the reasoning-integrity diagnostics remain here.

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
