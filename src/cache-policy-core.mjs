// cache-policy-core.mjs
//
// Pure policy registry + resolver for CacheEngine (v0.4.0).
//
// This module is the structured policy-resolution layer described by
// docs/cache-policy-inventory.md. It separates four concerns that used to be
// entangled in a single model-name-to-behavior branch:
//
//   1. creator / family classification
//   2. baseline cache policy (documented facts)
//   3. model-specific overlays (CacheEngine code behaviors, NOT implied by family)
//   4. transport capabilities (e.g. OpenRouter affinity), kept separate from
//      creator cache semantics
//
// It performs NO network calls and NO runtime documentation lookups. Every
// registry entry is traceable to docs/cache-policy-inventory.md via
// `inventoryRef`. Inheritance is always explicit (`inheritsFrom`); "newer means
// same behavior" is never an unconditional rule.
//
// As of v0.4.1 the runtime hook layer (cache-engine.ts) consumes
// resolveRuntimePolicy() as its single source of policy classification.
// detectPolicy() is retained as the compatibility classifier for the legacy
// POLICY_* strings.

// ---------------------------------------------------------------------------
// Model normalization (shared with the legacy classifier)
// ---------------------------------------------------------------------------

// Normalize a model-like object into a searchable haystack. Accepts both the
// full OpenCode Model ({providerID, id, api:{id,npm}, name}) and slim test
// objects ({providerID, modelID/apiID}).
export function modelSignals(model) {
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
export function isOpenAIish(s) {
  const { providerID, slug, npm } = s
  const p = providerID.toLowerCase()
  if (p === "openai" || p === "azure") return true
  if (slug.startsWith("openai/") || slug.startsWith("azure/")) return true
  if (/@ai-sdk\/openai|@ai-sdk\/azure/.test(npm)) return true
  return false
}

// The documented OpenAI cache-policy boundary is the generation phrase
// "GPT-5.6 and later" (docs/cache-policy-inventory.md §1; OpenAI *Prompt
// caching* guide, re-verified 2026-09-27). This matcher expresses that boundary
// by version rather than by an exact-model string, so future 5.6+/6+/7+ models
// need no registry entry:
//   - major > 5                      -> in family
//   - major === 5 && minor >= 6      -> in family
//   - everything else                -> out
// The token must be followed by a non-digit/non-dot boundary, so malformed ids
// such as "gpt-5.60" and "gpt-5.6.1" do not match (same guard as pre-v0.4.2).
// OpenAI minor versions are single-digit, so a multi-digit minor is treated as
// malformed rather than as a higher version.
export function isGpt56OrLater(slug) {
  const text = String(slug ?? "").toLowerCase()
  const re = /gpt-(\d{1,3})(?:\.(\d))?(?![\d.])/g
  let m
  while ((m = re.exec(text)) !== null) {
    const major = Number(m[1])
    const minor = m[2] === undefined ? 0 : Number(m[2])
    if (major > 5) return true
    if (major === 5 && minor >= 6) return true
  }
  return false
}

// DeepSeek V4-and-later coverage (docs/cache-policy-inventory.md §2; 2026-09-27
// first-party re-check). DeepSeek caching is provider-wide and passive: there is
// no cache key, flag, or breakpoint, and Anthropic-style `cache_control` is
// documented as ignored. This predicate therefore only classifies a version
// token (`deepseek-v<major>[.<minor>]` with major >= 4) into the passive family;
// it grants no mutation. Because the baseline is passive, matching an unknown
// future `deepseek-v5+` id is safe by construction.
//
// First-party docs do NOT publish a generational naming rule, and the current
// V4.1 codename id `deepseek-flash` carries no version token, so it is covered
// by explicit exact ids rather than by this predicate.
export function isDeepseekV4OrLater(slug) {
  const text = String(slug ?? "").toLowerCase()
  const re = /deepseek-v(\d+)(?:\.(\d+))?(?![\d.])/g
  let m
  while ((m = re.exec(text)) !== null) {
    if (Number(m[1]) >= 4) return true
  }
  return false
}

// GLM-5.3-and-later family baseline (docs/cache-policy-inventory.md §3; Z.AI
// docs re-verified 2026-09-27). Z.AI publishes no generational-inheritance rule
// and no explicit cache control, so this is a CacheEngine inference about a
// passive/implicit baseline; it is safe because it grants no mutation. The
// GLM-5.3 `<env>` relocation is a separate, explicit overlay and is NOT granted
// by this predicate. GLM-5.2 and earlier stay outside this family.
export function isGlm53OrLater(slug) {
  const text = String(slug ?? "").toLowerCase()
  const re = /glm-(\d{1,3})(?:\.(\d))?(?![\d.])/g
  let m
  while ((m = re.exec(text)) !== null) {
    const major = Number(m[1])
    const minor = m[2] === undefined ? 0 : Number(m[2])
    if (major > 5) return true
    if (major === 5 && minor >= 3) return true
  }
  return false
}

// MiMo generations strictly newer than V2.6 (docs/cache-policy-inventory.md §4;
// Xiaomi docs re-verified 2026-09-27). The documented V2.6 ids (Flash/Pro and
// the Pro UltraSpeed mode) are matched by their explicit entries; this predicate
// covers a future V2.7+/V3+ generation that CacheEngine has never seen, granting
// only the passive baseline (telemetry + transport) and never the `<env>`
// relocation overlay, so it is safe by construction. V2.5 and earlier stay
// neutral.
//
// It intentionally does NOT match the existing V2.6 literal, so undocumented
// V2.6 variants (for example `mimo-v2.6-flashx`) stay neutral per the narrow
// MiMo detection rule.
export function isMimoAfterV26(slug) {
  const text = String(slug ?? "").toLowerCase()
  const re = /mimo-v(\d+)(?:\.(\d+))?(?![\d.])/g
  let m
  while ((m = re.exec(text)) !== null) {
    const major = Number(m[1])
    const minor = m[2] === undefined ? 0 : Number(m[2])
    if (major > 2) return true
    if (major === 2 && minor > 6) return true
  }
  return false
}

// Google Gemini 2.5-and-later (provider-managed implicit caching; docs say
// "Gemini 2.5 and newer"). Anchored at a slug boundary so a concatenated
// prefix like `mygemini-2.5` does not match, while a `namespace/gemini-...`
// gateway id does (intended). The `(?![\w.])` guard rejects concatenated
// suffixes (`gemini-2.5foo`) and multi-dot forms (`gemini-2.5.1`); version-typed
// so Gemma / `gemini-embedding-*` do not match. Only `gemini-flash-latest` and
// `gemini-flash-lite-latest` are accepted: `gemini-flash-latest` is documented
// by Google and both are present in the installed OpenCode model catalog, while
// `gemini-pro-latest` is neither documented nor in the catalog (verified
// 2026-10-05) so it stays neutral.
export function isGemini25OrLater(slug) {
  const text = String(slug ?? "").toLowerCase()
  const re = /(?:^|\/)gemini-(\d{1,3})(?:\.(\d))?(?![\w.])/g
  let m
  while ((m = re.exec(text)) !== null) {
    const major = Number(m[1])
    const minor = m[2] === undefined ? 0 : Number(m[2])
    if (major > 2) return true
    if (major === 2 && minor >= 5) return true
  }
  return /(?:^|\/)gemini-(?:flash|flash-lite)-latest(?![\w-])/.test(text)
}

// Alibaba / Qwen chat families (provider-managed implicit prefix caching; an
// explicit block-level `cache_control` marker also exists, but CacheEngine does
// not mutate any Qwen route). Boundary-anchored so a concatenated prefix like
// `myqwen-max` does not match, while a `namespace/qwen-...` gateway id does
// (intended). Accepts the `qwen-<family>` aliases (`qwen-max`, `qwen-plus-latest`)
// and version-typed ids (`qwen3.8-max`, `qwen3.5-397b-a17b`, `qwen2.5-72b-instruct`).
// The version form requires the version to be followed by `-` or end-of-token,
// so malformed ids (`qwen3.5.1`, `qwen3.5foo`) stay neutral. Embeddings and
// rerankers are non-generative and excluded. Verified 2026-10-05 (RF-PRV-006).
export function isQwenModel(slug) {
  const text = String(slug ?? "").toLowerCase()
  if (!text) return false
  if (/embedding|rerank/.test(text)) return false
  const re = /(?:^|[\/.])qwen/gi
  let m
  while ((m = re.exec(text)) !== null) {
    const rest = text.slice(m.index + m[0].length)
    if (rest.startsWith("-")) return true
    if (/^\d+(?:\.\d+)?(?:-|$)/.test(rest)) return true
  }
  return false
}

// xAI / Grok language models (provider-managed automatic prefix caching). xAI
// documents caching for "all grok language models"; the affinity hint is route
// specific (Chat Completions header `x-grok-conv-id`, Responses body
// `prompt_cache_key`). CacheEngine classifies the family but never mutates the
// request: OpenCode 1.18.34 drives direct xAI through the Responses API and
// pre-sets `providerOptions.xai.promptCacheKey = sessionID`, which @ai-sdk/xai
// serializes to the wire `prompt_cache_key`, so the harness already supplies the
// stable conversation affinity (RF-PRV-007/RF-OC-013). Boundary-anchored and
// non-language-product aware: `mygrok-4`, `grokster-4`, `grok-imagine-image`,
// `grok-voice-*`, `grok-3-embedding`, and malformed ids (`grok-4..7`,
// `grok-4foo`) stay neutral.
export function isGrokModel(slug) {
  const text = String(slug ?? "").toLowerCase()
  if (!text) return false
  const re = /(?:^|[\/.])grok-([a-z0-9][a-z0-9.-]*)/g
  let m
  while ((m = re.exec(text)) !== null) {
    const tail = m[1]
    // Non-language Grok products (image/video/voice/audio/embedding) are not
    // generative text models. Test only the matched model token, never the
    // surrounding namespace (e.g. `some-image-co/grok-4.7` is a language model).
    if (/imagine|image|video|voice|transcribe|speech|tts|embedding|rerank/.test(tail)) continue
    // Version-typed ids: grok-4, grok-4.7, grok-4.20-0309-reasoning,
    // grok-4.7-latest. Requires a real digit-led version with no empty or
    // duplicated separators.
    if (/^\d+(?:\.\d+)*(?:-[a-z0-9]+)*$/.test(tail)) return true
    // Documented generative aliases that are not version-typed.
    if (/^(?:build|code|beta)(?:-|$)/.test(tail)) return true
  }
  return false
}

// Candidate ids for exact/alias lookup. Includes the raw apiID/modelID, the
// lower-cased forms, and a single stripped transport/vendor prefix
// (e.g. "openai/gpt-5.6-luna" -> "gpt-5.6-luna", "xiaomi/mimo-v2.6-flash" ->
// "mimo-v2.6-flash"). Prefix stripping is a lookup convenience only and never
// implies cache semantics.
function candidateIds(s) {
  const raw = [s.apiID, s.modelID].filter(Boolean).map((v) => String(v).toLowerCase())
  const out = new Set()
  for (const v of raw) {
    out.add(v)
    const stripped = v.replace(/^[a-z0-9._-]+\//, "")
    if (stripped) out.add(stripped)
  }
  return [...out]
}

// ---------------------------------------------------------------------------
// Baseline policies (documented cache-policy facts, not code behavior)
// ---------------------------------------------------------------------------

export const BASELINES = {
  "openai.gpt56.cache": {
    id: "openai.gpt56.cache",
    creator: "openai",
    appliesTo: "GPT-5.6 and later (OpenAI-documented generation boundary)",
    automatic: true,
    defaultMode: "implicit",
    supportsExplicitBreakpoints: true,
    minCacheTokens: 1024,
    ttl: "30m",
    cacheKeyOptional: true,
    cacheWriteBilled: true,
    usageFields: [
      "input_tokens_details.cached_tokens",
      "input_tokens_details.cache_write_tokens",
    ],
    inventoryRef: "§1 OpenAI",
  },
  "deepseek.kv-cache": {
    id: "deepseek.kv-cache",
    creator: "deepseek",
    appliesTo: "DeepSeek provider-wide (documented default for all users)",
    automatic: true,
    defaultMode: "implicit",
    supportsExplicitBreakpoints: false,
    minCacheTokens: null,
    ttl: null,
    cacheKeyOptional: false,
    cacheWriteBilled: false,
    usageFields: ["prompt_cache_hit_tokens", "prompt_cache_miss_tokens"],
    inventoryRef: "§2 DeepSeek",
  },
  "zai.implicit-cache": {
    id: "zai.implicit-cache",
    creator: "z.ai",
    appliesTo: "Z.AI service-wide implicit context caching",
    automatic: true,
    defaultMode: "implicit",
    supportsExplicitBreakpoints: false,
    minCacheTokens: null,
    ttl: null,
    cacheKeyOptional: false,
    cacheWriteBilled: false,
    usageFields: ["prompt_tokens_details.cached_tokens"],
    inventoryRef: "§3 Z.AI GLM",
  },
  "xiaomi.implicit-cache": {
    id: "xiaomi.implicit-cache",
    creator: "xiaomi",
    appliesTo: "Xiaomi MiMo provider-managed implicit caching",
    automatic: true,
    defaultMode: "implicit",
    supportsExplicitBreakpoints: false,
    minCacheTokens: null,
    ttl: null,
    cacheKeyOptional: false,
    cacheWriteBilled: false,
    usageFields: ["prompt_tokens_details.cached_tokens", "cache_read_input_tokens"],
    inventoryRef: "§4 Xiaomi MiMo",
  },
  "moonshot.implicit-cache": {
    id: "moonshot.implicit-cache",
    creator: "moonshot",
    appliesTo:
      "Moonshot/Kimi OpenAI-compatible Chat Completions and Responses (automatic prefix caching)",
    automatic: true,
    defaultMode: "implicit",
    supportsExplicitBreakpoints: false,
    minCacheTokens: null,
    ttl: "5m",
    cacheKeyOptional: true,
    // Cache Write (separate billing + TTL choice) is documented for kimi-k3 only;
    // kimi-k2.6/kimi-k2.7 report implicit reads only. Kept true because the
    // family includes kimi-k3 (see the inventory §5 table, item 11).
    cacheWriteBilled: true,
    usageFields: [
      "prompt_tokens_details.cached_tokens",
      "prompt_tokens_details.cache_write_tokens",
    ],
    inventoryRef: "§5 Moonshot Kimi",
  },
  "anthropic.ephemeral-cache": {
    id: "anthropic.ephemeral-cache",
    creator: "anthropic",
    appliesTo:
      "Anthropic Claude Messages API (explicit cache_control breakpoints; OpenCode applies them automatically)",
    automatic: false,
    defaultMode: "explicit",
    supportsExplicitBreakpoints: true,
    minCacheTokens: null,
    ttl: "5m",
    cacheKeyOptional: false,
    cacheWriteBilled: true,
    usageFields: [
      "cache_read_input_tokens",
      "cache_creation_input_tokens",
    ],
    inventoryRef: "§6 Anthropic Claude",
  },
  "google.gemini-implicit": {
    id: "google.gemini-implicit",
    creator: "google",
    appliesTo:
      "Google Gemini 2.5 and later (provider-managed implicit caching; no request field)",
    automatic: true,
    defaultMode: "implicit",
    supportsExplicitBreakpoints: false,
    minCacheTokens: null,
    ttl: null,
    cacheKeyOptional: false,
    cacheWriteBilled: false,
    usageFields: [
      "usageMetadata.cachedContentTokenCount",
      "prompt_tokens_details.cached_tokens",
    ],
    inventoryRef: "§7 Google Gemini",
  },
  "alibaba.qwen-cache": {
    id: "alibaba.qwen-cache",
    creator: "alibaba",
    appliesTo:
      "Alibaba Model Studio / DashScope Qwen (provider-managed implicit prefix caching; explicit block-level cache_control also documented)",
    automatic: true,
    defaultMode: "implicit",
    supportsExplicitBreakpoints: true,
    minCacheTokens: 1024,
    ttl: null,
    cacheKeyOptional: false,
    // Explicit caching reports cache_creation; implicit caching reports reads
    // only (created at standard input price with no distinct creation field).
    cacheWriteBilled: true,
    usageFields: [
      "prompt_tokens_details.cached_tokens",
      "prompt_tokens_details.cache_creation_input_tokens",
      "cache_read_input_tokens",
      "cache_creation_input_tokens",
    ],
    inventoryRef: "§8 Alibaba Qwen",
  },
  "xai.grok-cache": {
    id: "xai.grok-cache",
    creator: "xai",
    appliesTo:
      "xAI Grok language models (provider-managed automatic prefix caching; route-specific affinity hint)",
    automatic: true,
    defaultMode: "implicit",
    // xAI documents no explicit breakpoint mechanism, only routing hints
    // (`x-grok-conv-id` / `prompt_cache_key`), and no TTL or minimum.
    supportsExplicitBreakpoints: false,
    minCacheTokens: null,
    ttl: null,
    cacheKeyOptional: true,
    // xAI reports only cached reads; there is no cache-write/creation field.
    cacheWriteBilled: false,
    usageFields: [
      "input_tokens_details.cached_tokens", // Responses
      "prompt_tokens_details.cached_tokens", // Chat Completions
    ],
    inventoryRef: "§8b xAI Grok",
  },
  "neutral.none": {
    id: "neutral.none",
    creator: "unknown",
    appliesTo: "No registered cache policy; no model-specific optimization implied",
    automatic: false,
    defaultMode: null,
    supportsExplicitBreakpoints: false,
    minCacheTokens: null,
    ttl: null,
    cacheKeyOptional: false,
    cacheWriteBilled: false,
    usageFields: [],
    inventoryRef: "§10 Compatibility Matrix",
  },
}

// ---------------------------------------------------------------------------
// Model-specific overlays (CacheEngine code behaviors)
//
// An overlay is a concrete CacheEngine mutation. It is attached to a family
// ONLY by explicit registration; being classified into a creator/family never
// implies an overlay. This is what keeps "is GLM" from automatically meaning
// "<env> relocation".
// ---------------------------------------------------------------------------

export const OVERLAYS = {
  "gpt56.prompt-cache-options": {
    id: "gpt56.prompt-cache-options",
    family: "gpt-5.6",
    hook: "chat.params",
    behavior: "inject missing promptCacheKey + promptCacheOptions(implicit, 30m)",
    inventoryRef: "§1 OpenAI",
  },
  "glm53.env-relocation": {
    id: "glm53.env-relocation",
    family: "glm-5.3",
    hook: "experimental.chat.system.transform",
    behavior: "relocate the identifiable <env> block to the system tail",
    inventoryRef: "§3 Z.AI GLM",
  },
  "mimo26.env-relocation": {
    id: "mimo26.env-relocation",
    family: "mimo-v2.6",
    hook: "experimental.chat.system.transform",
    behavior: "relocate the identifiable <env> block to the system tail",
    inventoryRef: "§4 Xiaomi MiMo",
  },
}

// ---------------------------------------------------------------------------
// Transport capabilities (routing), deliberately independent of cache policy
// ---------------------------------------------------------------------------

export const TRANSPORTS = {
  openrouter: {
    id: "openrouter",
    kind: "openrouter",
    sessionAffinityHeader: "x-session-id",
    stickyRouting: true,
    inventoryRef: "§9 OpenRouter transport",
  },
}

function resolveTransport(s) {
  const p = String(s.providerID ?? "").toLowerCase()
  if (p === "openrouter") return { ...TRANSPORTS.openrouter }
  if (!p) {
    return { id: "unknown", kind: "unknown", sessionAffinityHeader: null, stickyRouting: false, inventoryRef: "§9 OpenRouter transport" }
  }
  return { id: p, kind: "direct", sessionAffinityHeader: null, stickyRouting: false, inventoryRef: "§9 OpenRouter transport" }
}

// ---------------------------------------------------------------------------
// Runtime capability descriptors
//
// The runtime consumes `resolvePolicy(...).runtime` for gating. `policy` is the
// legacy telemetry/state string, so telemetry stays byte-identical. Every
// capability is explicit per registry entry: classification into a creator or
// family never implies a mutation. `legacy: false` entries always resolve to
// NEUTRAL_RUNTIME, so a future-looking model gains nothing until the registry
// explicitly says so.
// ---------------------------------------------------------------------------

const NEUTRAL_RUNTIME = Object.freeze({
  policy: "neutral",
  isNeutral: true,
  gptCacheMetadata: false,
  envRelocation: null,
  thinkingIntegrity: false,
  cacheRatio: null,
  providerChange: null,
  prefixDiagnostics: false,
  openRouterAffinity: false,
  // Grok capability flags are intentionally separate from `openRouterAffinity`
  // and `gptCacheMetadata`: Grok affinity is provider/harness-managed and
  // route-aware, and CacheEngine never injects a key or header for it.
  grokCacheAffinity: false,
  grokRouteAware: false,
})

const rt = (policy, overrides = {}) => ({
  ...NEUTRAL_RUNTIME,
  ...overrides,
  policy,
  isNeutral: policy === "neutral",
})

// ---------------------------------------------------------------------------
// Registry
//
// Entries are evaluated in array order, which encodes detection priority and
// preserves the legacy classifier's precedence (gpt-5.6 > glm-5.3 > mimo-v2.6 >
// deepseek). `legacy: true` entries reproduce the pre-v0.4.0 detectPolicy()
// behavior exactly. `legacy: false` entries (gpt-6, Pro UltraSpeed) are
// available to the new resolver only, so runtime behavior is unchanged until
// wiring is approved.
// ---------------------------------------------------------------------------

export const POLICY_REGISTRY = [
  {
    // v0.4.2: one documented GPT-5.6-and-later family, matched by the version
    // boundary rather than an exact model string. GPT-6 (astra/sol/luna) is
    // documented in the same regime with no cache-control exception, so it
    // inherits this baseline and overlay. Future 5.6+/6+/7+ models resolve here
    // without a new registry entry.
    id: "openai.gpt-5.6-plus",
    creator: "openai",
    family: "gpt-5.6",
    kind: "family",
    predicate: isGpt56OrLater,
    requiresOpenAIish: true,
    exactIds: [
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.6-cyber",
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-6-luna",
    ],
    baseline: "openai.gpt56.cache",
    overlays: ["gpt56.prompt-cache-options"],
    legacy: true,
    runtime: rt("gpt56", { gptCacheMetadata: true }),
    boundary: "GPT-5.6 and later",
    note: "Documented boundary 'GPT-5.6 and later' (OpenAI Prompt caching guide, re-verified 2026-09-27) includes GPT-6 with no documented cache-control exception. No explicit breakpoint or prewarm behavior is registered.",
    inventoryRef: "§1 OpenAI",
  },
  {
    id: "zai.glm-5.3",
    creator: "z.ai",
    family: "glm-5.3",
    kind: "family",
    pattern: /glm-5\.3(?![\d.])/i,
    exactIds: ["glm-5.3", "glm-5.3-flash", "glm-5.3-flashx"],
    baseline: "zai.implicit-cache",
    overlays: ["glm53.env-relocation"],
    legacy: true,
    runtime: rt("glm53", {
      envRelocation: "glm",
      thinkingIntegrity: true,
      cacheRatio: "glm",
      providerChange: "glm",
      openRouterAffinity: true,
    }),
    inventoryRef: "§3 Z.AI GLM",
  },
  {
    // v0.4.4: "GLM-5.3 and later" family baseline. A future 5.3+ model inherits
    // the implicit-cache baseline and its non-mutating diagnostics/transport,
    // but NOT the GLM-5.3-specific `<env>` relocation overlay (`overlays: []`
    // and no `envRelocation` capability). GLM-5.2 and earlier stay neutral.
    id: "zai.glm-5.3-plus",
    creator: "z.ai",
    family: "glm-5.3",
    kind: "family",
    predicate: isGlm53OrLater,
    baseline: "zai.implicit-cache",
    overlays: [],
    legacy: true,
    runtime: rt("glm53", {
      thinkingIntegrity: true,
      cacheRatio: "glm",
      providerChange: "glm",
      openRouterAffinity: true,
    }),
    boundary: "GLM-5.3 and later",
    note: "Z.AI publishes no generational-inheritance rule and no explicit cache control. The baseline is implicit caching; the `<env>` relocation is a GLM-5.3-only CacheEngine overlay and is intentionally not inherited. No cache-control field is invented.",
    inventoryRef: "§3 Z.AI GLM",
  },
  {
    id: "xiaomi.mimo-v2.6",
    creator: "xiaomi",
    family: "mimo-v2.6",
    kind: "family",
    pattern: /mimo-v2\.6-(flash|pro)(?![\w-])/i,
    exactIds: ["mimo-v2.6-flash", "mimo-v2.6-pro"],
    baseline: "xiaomi.implicit-cache",
    overlays: ["mimo26.env-relocation"],
    legacy: true,
    runtime: rt("mimo26", {
      envRelocation: "mimo",
      cacheRatio: "mimo",
      providerChange: "mimo",
      prefixDiagnostics: true,
      openRouterAffinity: true,
    }),
    inventoryRef: "§4 Xiaomi MiMo",
  },
  {
    id: "xiaomi.mimo-v2.6-pro-ultraspeed",
    creator: "xiaomi",
    family: "mimo-v2.6",
    kind: "family",
    pattern: /mimo-v2\.6-pro-ultraspeed/i,
    exactIds: ["mimo-v2.6-pro-ultraspeed"],
    baseline: "xiaomi.implicit-cache",
    overlays: [],
    legacy: true,
    runtime: rt("mimo26", {
      cacheRatio: "mimo",
      providerChange: "mimo",
      prefixDiagnostics: true,
      openRouterAffinity: true,
    }),
    policyStatus: "documented-series-member-baseline-only",
    note: "v0.4.5: documented as a Pro mode in the same V2.6 series. It gets the MiMo family baseline (cached-token telemetry, provider-change/prefix diagnostics, OpenRouter affinity) but NOT the validated `<env>` relocation overlay.",
    inventoryRef: "§4 Xiaomi MiMo",
  },
  {
    // v0.4.5: "MiMo V2.6 and later" family baseline. A future 2.6+ model gets
    // the passive baseline and its non-mutating diagnostics/transport, but never
    // the `<env>` overlay, which stays explicit to the validated Flash/Pro entry.
    id: "xiaomi.mimo-v2.6-plus",
    creator: "xiaomi",
    family: "mimo-v2.6",
    kind: "family",
    predicate: isMimoAfterV26,
    baseline: "xiaomi.implicit-cache",
    overlays: [],
    legacy: true,
    runtime: rt("mimo26", {
      cacheRatio: "mimo",
      providerChange: "mimo",
      prefixDiagnostics: true,
      openRouterAffinity: true,
    }),
    boundary: "MiMo V2.6 and later",
    note: "Xiaomi documents implicit caching with no cache-control field and no generational-inheritance rule; the `<env>` relocation is a CacheEngine overlay with no first-party basis and is not inherited.",
    inventoryRef: "§4 Xiaomi MiMo",
  },
  {
    // v0.4.3: formalize the documented "DeepSeek V4 and later" family. Coverage
    // is passive (no mutation, no overlays). Version ids inherit via the
    // predicate; the V4.1 codename id `deepseek-flash` has no version token and
    // is matched by exact id. Pre-V4 and unknown future ids fall through to the
    // passive creator baseline below, so nothing speculative is ever applied.
    id: "deepseek.v4-plus",
    creator: "deepseek",
    family: "deepseek",
    kind: "family",
    predicate: isDeepseekV4OrLater,
    exactIds: ["deepseek-flash", "deepseek-v4-pro"],
    baseline: "deepseek.kv-cache",
    overlays: [],
    legacy: true,
    runtime: rt("deepseek"),
    boundary: "DeepSeek V4 and later",
    note: "DeepSeek caching is provider-wide and passive (no cache key, flag, breakpoint, or cache-control; Anthropic `cache_control` is ignored). Verified 2026-09-27. Canonical current ids: `deepseek-flash` (V4.1-Flash) and `deepseek-v4-pro`; `deepseek-v4-flash`/`deepseek-v4-flash-vision-exp` are accepted retired aliases.",
    inventoryRef: "§2 DeepSeek",
  },
  {
    // Safe passive fallback for any other `*deepseek*` id (pre-V4, retired, or
    // unknown future models) so DeepSeek always fails safe to observation only.
    id: "deepseek.baseline",
    creator: "deepseek",
    family: "deepseek",
    kind: "creator",
    pattern: /deepseek/i,
    providerPattern: /deepseek/i,
    baseline: "deepseek.kv-cache",
    overlays: [],
    legacy: true,
    runtime: rt("deepseek"),
    inventoryRef: "§2 DeepSeek",
  },
  {
    // v0.5.0: Moonshot/Kimi. On the native OpenAI-compatible Chat Completions
    // and Responses paths, context caching is automatic (implicit); the optional
    // `prompt_cache_options` object only selects the write TTL (`5m`|`1h`) and
    // does not enable caching, so CacheEngine stays PASSIVE here (no request
    // mutation). The Anthropic-compatible Messages path uses a different
    // top-level `cache_control` shape and is deliberately NOT applied to the
    // OpenAI-compatible request. Matched by the documented current ids (bare or
    // gateway-prefixed); deprecated K2/K2.5/`moonshot-v1-*` ids and other
    // `*kimi*` names stay neutral.
    id: "moonshot.kimi",
    creator: "moonshot",
    family: "kimi",
    kind: "family",
    pattern: /(?:^|\/)kimi-k(?:3|2\.6|2\.7-code)(?![\w.])/i,
    exactIds: ["kimi-k3", "kimi-k2.6", "kimi-k2.7-code", "kimi-k2.7-code-highspeed"],
    baseline: "moonshot.implicit-cache",
    overlays: [],
    legacy: true,
    runtime: rt("kimi"),
    boundary: "Kimi K2.6 / K2.7-code / K3 (Moonshot OpenAI-compatible path)",
    note: "Moonshot context caching is automatic on the OpenAI-compatible Chat/Responses path; `prompt_cache_options` selects only the write TTL (5m/1h, default 5m) and is not required for caching, and explicit `prompt_cache_breakpoint` is rejected. CacheEngine is therefore passive (no mutation). The Anthropic-compatible Messages path uses a separate top-level `cache_control` and is not applied here. Cache Write (separate billing/TTL choice) is documented for kimi-k3 only. Verified 2026-10-04.",
    inventoryRef: "§5 Moonshot Kimi",
  },
  {
    // v0.5.2: Anthropic Claude. CacheEngine is PASSIVE because OpenCode itself
    // applies Anthropic `cache_control` breakpoints (ProviderTransform.applyCaching:
    // first two system messages + last two non-system messages, default 5m TTL,
    // <=4 breakpoints) for Claude/Anthropic transports, and normalizes
    // cache_read_input_tokens/cache_creation_input_tokens into tokens.cache.{read,write}.
    // Injecting CacheEngine's own top-level `cacheControl` via chat.params would
    // DISABLE OpenCode's breakpoint strategy and risk duplicate/TTL-conflicting
    // markers, so no mutation is registered here. Classification + accounting only.
    id: "anthropic.claude",
    creator: "anthropic",
    family: "claude",
    kind: "family",
    pattern: /(?:^|[\/.])claude-(?:(?:opus|sonnet|haiku|fable|mythos)-\d|3(?:[.-]\d+)?)(?![\w])/i,
    baseline: "anthropic.ephemeral-cache",
    overlays: [],
    legacy: true,
    runtime: rt("claude"),
    boundary: "Anthropic Claude (Messages API / Claude-compatible routes)",
    note: "OpenCode 1.18.34 already applies Anthropic cache_control breakpoints for Claude/Anthropic transports (native @ai-sdk/anthropic, google-vertex-anthropic, Bedrock cachePoint, and OpenRouter when the model id contains anthropic/claude) and normalizes cache_read_input_tokens/cache_creation_input_tokens. CacheEngine therefore stays passive: no cache_control, no cache key, no TTL, no breakpoint injection. Verified 2026-10-04.",
    inventoryRef: "§6 Anthropic Claude",
  },
  {
    // v0.5.3: Google Gemini. Caching is provider-managed implicit (Gemini 2.5+
    // and newer): there is no request-side cache-control field, and OpenCode's
    // applyCaching gate EXCLUDES Gemini/Google (Gemini is a no-op for OpenCode's
    // cache markers). Google's explicit caching is a separate cachedContents
    // resource, deliberately NOT managed here. CacheEngine is therefore PASSIVE:
    // classification + accounting only, no mutation on any route.
    id: "google.gemini",
    creator: "google",
    family: "gemini",
    kind: "family",
    predicate: isGemini25OrLater,
    exactIds: ["gemini-flash-latest", "gemini-flash-lite-latest"],
    baseline: "google.gemini-implicit",
    overlays: [],
    legacy: true,
    runtime: rt("gemini"),
    boundary: "Google Gemini 2.5 and later (implicit caching)",
    note: "Native Gemini caching is provider-managed implicit for 2.5+; no request-side cache-control field exists, OpenCode's applyCaching gate excludes Gemini, and OpenCode normalizes usageMetadata.cachedContentTokenCount into tokens.cache.read (there is no native Gemini write field). Google's explicit `cachedContents` API is a separate resource lifecycle and is intentionally not managed. OpenRouter is gateway-specific and remains passive (RF-OR-003/RF-OR-004). Verified 2026-10-05.",
    inventoryRef: "§7 Google Gemini",
  },
  {
    // v0.5.x: Alibaba / Qwen. Caching is provider-managed implicit on every
    // route; the explicit block-level `cache_control` marker exists but cannot be
    // placed through the V1 `chat.params` hook (top-level options only), and
    // OpenCode already applies Anthropic-style breakpoints on the Qwen Messages
    // routes. CacheEngine is therefore PASSIVE: classification + accounting, no
    // mutation on any route. See inventory §8 and RF-PRV-006.
    id: "alibaba.qwen",
    creator: "alibaba",
    family: "qwen",
    kind: "family",
    predicate: isQwenModel,
    baseline: "alibaba.qwen-cache",
    overlays: [],
    legacy: true,
    runtime: rt("qwen"),
    boundary: "Alibaba / Qwen (all transports)",
    note: "Qwen caching is provider-managed: implicit prefix caching is automatic and non-disableable (~1024-token minimum, no fixed TTL), and explicit block-level cache_control:{type:ephemeral} exists (1024 min, 5m, <=4 markers) but is not placed by CacheEngine because the V1 chat.params hook cannot reach content blocks. OpenCode already applies Anthropic-style breakpoints on the Qwen Messages routes (OpenCode Go/Zen via @ai-sdk/anthropic), so CacheEngine must not duplicate them. Coding Plan / Token Plan cache semantics are undocumented -> passive. OpenRouter Qwen documents explicit block markers, but OpenCode injects none and the V1 hook cannot reach blocks -> passive. No Qwen affinity. Verified 2026-10-05 (RF-PRV-006).",
    inventoryRef: "§8 Alibaba Qwen",
  },
  {
    // v0.5.x: xAI / Grok. Caching is automatic and provider-managed on all Grok
    // language models; xAI exposes only cache reads. CacheEngine is PASSIVE on
    // every route: OpenCode 1.18.34 drives direct xAI through the Responses API
    // and already sets providerOptions.xai.promptCacheKey = sessionID, which
    // @ai-sdk/xai serializes to the wire `prompt_cache_key`, so the harness owns
    // the stable conversation affinity and CacheEngine must preserve it. The
    // Chat Completions header `x-grok-conv-id` is not reachable in this runtime.
    // Go/Zen/OpenRouter/gateways are not direct xAI. See inventory §8b and
    // RF-PRV-007 / RF-OC-013.
    id: "xai.grok",
    creator: "xai",
    family: "grok",
    kind: "family",
    predicate: isGrokModel,
    baseline: "xai.grok-cache",
    overlays: [],
    legacy: true,
    runtime: rt("grok", { grokCacheAffinity: true, grokRouteAware: true }),
    boundary: "xAI / Grok language models (all transports)",
    note: "Grok prompt caching is automatic/provider-managed on all grok language models and xAI reports only cached reads (no write/creation field, so no write token is ever fabricated). CacheEngine never mutates the request. OpenCode 1.18.34 routes direct xAI (providerID xai, npm @ai-sdk/xai) through the Responses API and pre-sets providerOptions.xai.promptCacheKey = sessionID, serialized to wire prompt_cache_key by @ai-sdk/xai — so the harness already provides the stable conversation affinity and CacheEngine must not overwrite it. The Chat Completions header x-grok-conv-id is not reachable in this runtime. OpenCode Go/Zen/OpenRouter and generic gateways are not direct xAI and stay passive. Auth method (API key vs SuperGrok/X Premium) is not a policy distinction. No TTL or minimum is documented, so none is invented. Verified 2026-10-06 (RF-PRV-007 / RF-OC-013).",
    inventoryRef: "§8b xAI Grok",
  },
]

// ---------------------------------------------------------------------------
// Explicit aliases identified by the inventory
// ---------------------------------------------------------------------------

// `legacy` records whether the pre-v0.4.0 classifier already matched this alias.
// Only legacy aliases carry runtime capabilities; newer documented aliases are
// resolved for information but stay runtime-neutral (no new optimization).
export const MODEL_ALIASES = {
  "gpt-5.6": { canonicalId: "gpt-5.6-sol", family: "gpt-5.6", creator: "openai", legacy: true, inventoryRef: "§1 OpenAI" },
  "gpt-daybreak-blue-latest": { canonicalId: "gpt-5.6-sol", family: "gpt-5.6", creator: "openai", legacy: false, inventoryRef: "§1 OpenAI" },
  "gpt-daybreak-red-latest": { canonicalId: "gpt-5.6-cyber", family: "gpt-5.6", creator: "openai", legacy: false, inventoryRef: "§1 OpenAI" },
  "deepseek-v4-flash": { canonicalId: "deepseek-flash", family: "deepseek", creator: "deepseek", legacy: true, status: "retired-legacy-id", inventoryRef: "§2 DeepSeek" },
  "deepseek-chat": { canonicalId: null, family: "deepseek", creator: "deepseek", legacy: true, status: "retired", inventoryRef: "§2 DeepSeek" },
  "deepseek-reasoner": { canonicalId: null, family: "deepseek", creator: "deepseek", legacy: true, status: "retired", inventoryRef: "§2 DeepSeek" },
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

function neutralResult(reason, transport) {
  return {
    creator: "unknown",
    family: "neutral",
    baseline: BASELINES["neutral.none"],
    overlays: [],
    runtime: NEUTRAL_RUNTIME,
    transport,
    matchType: "neutral",
    matchReason: reason,
    matchedId: null,
    inventoryRef: null,
    note: null,
  }
}

function overlaysFor(ids) {
  return (ids ?? []).map((id) => OVERLAYS[id]).filter(Boolean)
}

// A family entry matches by regex `pattern` or by a pure `predicate(slug)`.
function familyMatches(entry, slug) {
  if (typeof entry.predicate === "function") return entry.predicate(slug)
  return entry.pattern ? entry.pattern.test(slug) : false
}

// Only legacy entries carry runtime capabilities. A non-legacy entry (gpt-6,
// Pro UltraSpeed) resolves for information but stays neutral at runtime.
function runtimeForEntry(entry) {
  return entry.legacy === false ? NEUTRAL_RUNTIME : entry.runtime ?? NEUTRAL_RUNTIME
}

function resultFromEntry(entry, matchType, matchReason, matchedId, transport) {
  return {
    creator: entry.creator,
    family: entry.family,
    baseline: BASELINES[entry.baseline] ?? null,
    overlays: overlaysFor(entry.overlays),
    runtime: runtimeForEntry(entry),
    transport,
    matchType,
    matchReason,
    matchedId: matchedId ?? null,
    inventoryRef: entry.inventoryRef ?? null,
    note: entry.note ?? null,
  }
}

function resultFromFamily(family, creator, matchType, matchReason, matchedId, inventoryRef, note, transport, aliasLegacy) {
  const entry = POLICY_REGISTRY.find((e) => e.family === family && e.kind !== "exact")
  // An alias is runtime-active only when both the alias and its target family
  // were recognized before v0.4.0.
  const active = aliasLegacy !== false && (!entry || entry.legacy !== false)
  return {
    creator,
    family,
    baseline: entry ? BASELINES[entry.baseline] ?? null : null,
    overlays: entry ? overlaysFor(entry.overlays) : [],
    runtime: active && entry ? entry.runtime ?? NEUTRAL_RUNTIME : NEUTRAL_RUNTIME,
    transport,
    matchType,
    matchReason,
    matchedId: matchedId ?? null,
    inventoryRef: inventoryRef ?? null,
    note: note ?? null,
  }
}

// Structured resolver. Returns creator, family, baseline, overlays, transport,
// matchType, and matchReason. Unknown models resolve to a neutral result with
// an empty overlay list and no model-specific optimization.
export function resolvePolicy(model) {
  if (!model || typeof model !== "object") {
    return neutralResult("neutral:invalid-model", resolveTransport({}))
  }
  const s = modelSignals(model)
  const transport = resolveTransport(s)
  if (!s.slug) return neutralResult("neutral:no-model-identity", transport)

  const ids = candidateIds(s)

  // 1. Explicit aliases (inventory-identified). An alias inherits its target
  // family's context gate, so e.g. an OpenAI alias on a non-OpenAI gateway does
  // not gain a cache policy it would not otherwise have.
  for (const id of ids) {
    const alias = MODEL_ALIASES[id]
    if (!alias) continue
    const familyEntry = POLICY_REGISTRY.find((e) => e.family === alias.family && e.kind !== "exact")
    if (familyEntry?.requiresOpenAIish && !isOpenAIish(s)) continue
    const reason = `alias:${id}->${alias.canonicalId ?? alias.family}`
    return resultFromFamily(alias.family, alias.creator, "exact", reason, id, alias.inventoryRef, alias.status ?? null, transport, alias.legacy)
  }

  // 2. Exact model ids (documented models). The entry's context gate still
  // applies, so an exact OpenAI id on a non-OpenAI endpoint is never guessed.
  for (const entry of POLICY_REGISTRY) {
    if (!entry.exactIds || entry.exactIds.length === 0) continue
    const hit = ids.find((id) => entry.exactIds.includes(id))
    if (!hit) continue
    if (entry.requiresOpenAIish && !isOpenAIish(s)) continue
    return resultFromEntry(entry, "exact", `exact-id:${hit}`, hit, transport)
  }

  // 3. Model family / range matchers (regex pattern or version predicate).
  for (const entry of POLICY_REGISTRY) {
    if (entry.kind !== "family") continue
    if (!familyMatches(entry, s.slug)) continue
    if (entry.requiresOpenAIish && !isOpenAIish(s)) continue
    return resultFromEntry(entry, "family", `family-pattern:${entry.id}`, null, transport)
  }

  // 4. Creator baseline.
  for (const entry of POLICY_REGISTRY) {
    if (entry.kind !== "creator") continue
    const slugHit = entry.pattern ? entry.pattern.test(s.slug) : false
    const providerHit = entry.providerPattern ? entry.providerPattern.test(s.providerID) : false
    if (slugHit || providerHit) return resultFromEntry(entry, "creator", `creator-baseline:${entry.id}`, null, transport)
  }

  return neutralResult("neutral:no-match", transport)
}

// Convenience accessor for the runtime: the legacy policy string + explicit
// capability flags. This is the single source the runtime gates on; it is
// guaranteed equal to the pre-v0.4.0 detectPolicy() classification.
export function resolveRuntimePolicy(model) {
  return resolvePolicy(model).runtime
}

// ---------------------------------------------------------------------------
// Resolution explanation (v0.4.6)
//
// A pure, total function of (model, registry) that explains WHY a model resolved
// the way it did, so a newly released model can be spotted for later review.
//
// Design constraints this encodes:
//   * Detection is never "highest numeric version wins". A future model inherits
//     a family baseline only because a registry entry explicitly registers a
//     version range or a creator baseline, and it inherits a model-specific
//     overlay only when the matched entry registers that overlay.
//   * An overlay that exists for a family but was not applied to this model is
//     reported explicitly, so "unvalidated" is visible rather than silent.
//   * Provider identity is reported as known/unknown without guessing it.
//
// It never returns prompt, system, tool, or header content.
// ---------------------------------------------------------------------------

// Overlay ids registered for a family (used to detect "overlay exists but was
// not applied to this model").
export function overlaysRegisteredForFamily(family) {
  return Object.keys(OVERLAYS).filter((id) => OVERLAYS[id].family === family)
}

// Coarse match category: exact-id | alias | family | creator | neutral.
export function policyMatchCategory(result) {
  if (result.matchType === "exact") {
    return String(result.matchReason ?? "").startsWith("alias:") ? "alias" : "exact-id"
  }
  if (result.matchType === "family") return "family"
  if (result.matchType === "creator") return "creator"
  return "neutral"
}

// Finer-grained explanation of HOW the match happened, for reviewers.
function policyMatchKind(result) {
  if (result.matchType === "exact") {
    return String(result.matchReason ?? "").startsWith("alias:") ? "alias" : "exact-id"
  }
  if (result.matchType === "family") {
    const entryId = String(result.matchReason ?? "").split(":")[1]
    const entry = POLICY_REGISTRY.find((e) => e.id === entryId)
    if (!entry) return "unknown"
    return typeof entry.predicate === "function" ? "version-range" : "pattern"
  }
  if (result.matchType === "creator") return "creator-baseline"
  return "unknown"
}

// Explain a resolution without mutating anything. Safe for any input, including
// null/undefined/garbage models: those resolve to the neutral/unknown path.
export function explainPolicyResolution(model) {
  const result = resolvePolicy(model)
  const s = modelSignals(model)
  const overlayIds = (result.overlays ?? []).map((o) => o.id)
  const provider = typeof s.providerID === "string" && s.providerID.length > 0 ? s.providerID : null
  // A resolved overlay list is not proof of an applied overlay. A registry entry
  // can carry overlays while its runtime is neutral (a non-runtime-active alias),
  // in which case no hook applies anything and the honest answer is "skipped".
  const runtimeActive = result.runtime?.isNeutral !== true
  const overlayApplied = overlayIds.length > 0 && runtimeActive
  // Either the family has an overlay this model was never validated for, or the
  // matched entry is not runtime-active. Distinguish the two.
  const unvalidated = !overlayApplied ? overlaysRegisteredForFamily(result.family) : []
  const overlaySkipped = !overlayApplied && (unvalidated.length > 0 || overlayIds.length > 0)
  const overlaySkippedReason = !overlayApplied
    ? overlayIds.length > 0
      ? "registry-entry-not-runtime-active"
      : unvalidated.length > 0
        ? "overlay-not-validated-for-model"
        : null
    : null
  return {
    matchCategory: policyMatchCategory(result),
    matchKind: policyMatchKind(result),
    matchReason: result.matchReason ?? null,
    matchedId: result.matchedId ?? null,
    creator: result.creator,
    family: result.family,
    policy: result.runtime.policy,
    isNeutral: result.runtime.policy === "neutral",
    baselineId: result.baseline?.id ?? null,
    overlays: overlayIds,
    overlayApplied,
    // An overlay is registered for this family (or on the matched entry) but was
    // not applied to this model, so no prompt transformation happens.
    overlaySkipped,
    overlaySkippedReason,
    overlaySkippedCandidates: overlaySkipped ? unvalidated.length > 0 ? unvalidated : overlayIds : [],
    transportKind: result.transport?.kind ?? "unknown",
    sessionAffinityHeader: result.transport?.sessionAffinityHeader ?? null,
    providerIdentityKnown: provider !== null,
    provider,
    model: String(s.apiID || s.modelID || "") || null,
  }
}

// Compatibility classification used by detectPolicy(). Reproduces the
// pre-v0.4.0 behavior exactly: it considers only `legacy` registry entries,
// excludes newer-generation/alias/exact-overlay additions, and returns a family
// string (or "neutral"). Callers map the family to a POLICY_* constant.
export function resolveLegacyFamily(model) {
  if (!model || typeof model !== "object") return "neutral"
  const s = modelSignals(model)
  if (!s.slug) return "neutral"
  for (const entry of POLICY_REGISTRY) {
    if (!entry.legacy) continue
    if (entry.kind === "family") {
      if (!familyMatches(entry, s.slug)) continue
      if (entry.requiresOpenAIish && !isOpenAIish(s)) continue
      return entry.family
    }
    if (entry.kind === "creator") {
      const slugHit = entry.pattern ? entry.pattern.test(s.slug) : false
      const providerHit = entry.providerPattern ? entry.providerPattern.test(s.providerID) : false
      if (slugHit || providerHit) return entry.family
    }
  }
  return "neutral"
}
