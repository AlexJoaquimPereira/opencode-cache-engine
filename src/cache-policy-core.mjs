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
// This release does not wire the resolver into runtime hooks. detectPolicy()
// remains the compatibility classifier until wiring is approved.

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
    inventoryRef: "§6 Compatibility Matrix",
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
    inventoryRef: "§5 OpenRouter transport",
  },
}

function resolveTransport(s) {
  const p = String(s.providerID ?? "").toLowerCase()
  if (p === "openrouter") return { ...TRANSPORTS.openrouter }
  if (!p) {
    return { id: "unknown", kind: "unknown", sessionAffinityHeader: null, stickyRouting: false, inventoryRef: "§5 OpenRouter transport" }
  }
  return { id: p, kind: "direct", sessionAffinityHeader: null, stickyRouting: false, inventoryRef: "§5 OpenRouter transport" }
}

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
    id: "openai.gpt-5.6",
    creator: "openai",
    family: "gpt-5.6",
    kind: "family",
    pattern: /gpt-5\.6(?![\d.])/i,
    requiresOpenAIish: true,
    exactIds: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.6-cyber"],
    baseline: "openai.gpt56.cache",
    overlays: ["gpt56.prompt-cache-options"],
    legacy: true,
    inventoryRef: "§1 OpenAI",
  },
  {
    id: "openai.gpt-6",
    creator: "openai",
    family: "gpt-6",
    kind: "family",
    pattern: /gpt-6(?![\d.])/i,
    requiresOpenAIish: true,
    exactIds: ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"],
    baseline: "openai.gpt56.cache",
    inheritsFrom: "gpt-5.6",
    overlays: [],
    legacy: false,
    note: "Documented inheritance of the GPT-5.6-and-later baseline. No CacheEngine overlay is registered for gpt-6 yet.",
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
    inventoryRef: "§4 Xiaomi MiMo",
  },
  {
    id: "xiaomi.mimo-v2.6-pro-ultraspeed",
    creator: "xiaomi",
    family: "mimo-v2.6",
    kind: "exact",
    exactIds: ["mimo-v2.6-pro-ultraspeed"],
    baseline: "xiaomi.implicit-cache",
    overlays: [],
    legacy: false,
    policyStatus: "documented-series-member-without-registered-overlay",
    note: "Documented as a Pro mode in the same V2.6 series, but the inventory does not establish identical cache controls and CacheEngine registers no overlay for it.",
    inventoryRef: "§4 Xiaomi MiMo",
  },
  {
    id: "deepseek.baseline",
    creator: "deepseek",
    family: "deepseek",
    kind: "creator",
    pattern: /deepseek/i,
    providerPattern: /deepseek/i,
    baseline: "deepseek.kv-cache",
    overlays: [],
    legacy: true,
    inventoryRef: "§2 DeepSeek",
  },
]

// ---------------------------------------------------------------------------
// Explicit aliases identified by the inventory
// ---------------------------------------------------------------------------

export const MODEL_ALIASES = {
  "gpt-5.6": { canonicalId: "gpt-5.6-sol", family: "gpt-5.6", creator: "openai", inventoryRef: "§1 OpenAI" },
  "gpt-daybreak-blue-latest": { canonicalId: "gpt-5.6-sol", family: "gpt-5.6", creator: "openai", inventoryRef: "§1 OpenAI" },
  "gpt-daybreak-red-latest": { canonicalId: "gpt-5.6-cyber", family: "gpt-5.6", creator: "openai", inventoryRef: "§1 OpenAI" },
  "deepseek-v4-flash": { canonicalId: "deepseek-flash", family: "deepseek", creator: "deepseek", status: "retired-legacy-id", inventoryRef: "§2 DeepSeek" },
  "deepseek-chat": { canonicalId: null, family: "deepseek", creator: "deepseek", status: "retired", inventoryRef: "§2 DeepSeek" },
  "deepseek-reasoner": { canonicalId: null, family: "deepseek", creator: "deepseek", status: "retired", inventoryRef: "§2 DeepSeek" },
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

function resultFromEntry(entry, matchType, matchReason, matchedId, transport) {
  return {
    creator: entry.creator,
    family: entry.family,
    baseline: BASELINES[entry.baseline] ?? null,
    overlays: overlaysFor(entry.overlays),
    transport,
    matchType,
    matchReason,
    matchedId: matchedId ?? null,
    inventoryRef: entry.inventoryRef ?? null,
    note: entry.note ?? null,
  }
}

function resultFromFamily(family, creator, matchType, matchReason, matchedId, inventoryRef, note, transport) {
  const entry = POLICY_REGISTRY.find((e) => e.family === family && e.kind !== "exact")
  return {
    creator,
    family,
    baseline: entry ? BASELINES[entry.baseline] ?? null : null,
    overlays: entry ? overlaysFor(entry.overlays) : [],
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
    return resultFromFamily(alias.family, alias.creator, "exact", reason, id, alias.inventoryRef, alias.status ?? null, transport)
  }

  // 2. Exact model ids (documented models).
  for (const entry of POLICY_REGISTRY) {
    if (!entry.exactIds || entry.exactIds.length === 0) continue
    const hit = ids.find((id) => entry.exactIds.includes(id))
    if (hit) return resultFromEntry(entry, "exact", `exact-id:${hit}`, hit, transport)
  }

  // 3. Model family / range patterns.
  for (const entry of POLICY_REGISTRY) {
    if (entry.kind !== "family" || !entry.pattern) continue
    if (!entry.pattern.test(s.slug)) continue
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
      if (!entry.pattern.test(s.slug)) continue
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
