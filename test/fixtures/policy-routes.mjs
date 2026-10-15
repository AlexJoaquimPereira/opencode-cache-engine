// Route-specific policy dispositions for Phase 4 (P4-T1..P4-T3).
//
// Pinned so the "assignment != wire success" results cannot silently regress:
// every *mutation-bearing* policy is listed with the route(s) it targets and the
// documented wire disposition, and the pure helpers below are asserted against it.
//
// `wire` is the documented disposition on the TESTED routes (this table is data,
// not a runtime claim):
//   "structural"    — a content-preserving transform reaches the serialized request
//   "stripped"      — the provider-options schema drops the field
//   "harness-owned" — OpenCode already sets it; the adapter preserves it (no change)
//   "unsupported"   — no inspected schema carries it
//   "info"          — passive; no request mutation
//
// Evidence tags/IDs point at the tracked stores. No provider was contacted.

export const MUTATION_POLICIES = [
  {
    policy: "gpt56.cache-options",
    hooks: ["chat.params (V1)", "context.options (V2)"],
    classes: ["transport-specific"],
    fieldNames: {
      openrouter: { key: "prompt_cache_key", options: "prompt_cache_options" },
      default: { key: "promptCacheKey", options: "promptCacheOptions" },
    },
    preserves: "promptCacheKey",
    disable: "policies.gpt56.enabled=false (full) | policies.gpt56.promptCacheKey=false (key only; promptCacheOptions is still injected)",
    routes: [
      { route: "openai-compatible", wire: "stripped", evidence: "RF-OC-030" },
      { route: "openai/azure (Responses)", wire: "harness-owned", evidence: "RF-OC-047" },
      { route: "openrouter (openai/* slug)", wire: "unknown", evidence: "RF-OC-030 (absence: no inspected schema; the OpenRouter provider schema was not directly inspected)" },
    ],
  },
  {
    policy: "openrouter.affinity",
    hooks: ["chat.headers (V1)", "model.request (V2)"],
    classes: ["transport-specific"],
    fieldNames: { header: "x-session-id" },
    preserves: "x-session-id",
    disable: "inherent (openrouter + GLM-5.3/MiMo-V2.6 gate)",
    routes: [{ route: "openrouter + glm53/mimo26", wire: "harness-owned", evidence: "RF-OC-048" }],
  },
  {
    policy: "glm53.env-relocation",
    hooks: ["experimental.chat.system.transform"],
    classes: ["structural"],
    preserves: "non-<env> system bytes",
    disable: "policies.glm53.enabled=false | policies.glm53.stabilizeSystem=false",
    routes: [{ route: "zai.glm-5.3", wire: "structural", evidence: "RF-OC-035" }],
  },
  {
    policy: "glm53.stabilizeDate",
    hooks: ["experimental.chat.system.transform"],
    classes: ["experimental"],
    preserves: "the date value and all non-date bytes",
    disable: "policies.glm53.stabilizeDate=false (default)",
    routes: [{ route: "zai.glm-5.3", wire: "structural", evidence: "RF-OC-036" }],
  },
  {
    policy: "mimo26.env-relocation",
    hooks: ["experimental.chat.system.transform"],
    classes: ["structural"],
    preserves: "non-<env> system bytes",
    disable: "policies.mimo26.enabled=false | policies.mimo26.stabilizeSystem=false",
    routes: [{ route: "xiaomi.mimo-v2.6", wire: "structural", evidence: "RF-OC-035" }],
  },
  {
    policy: "mimo26.stabilizeDate",
    hooks: ["experimental.chat.system.transform"],
    classes: ["experimental"],
    preserves: "the date value and all non-date bytes",
    disable: "policies.mimo26.stabilizeDate=false (default)",
    routes: [{ route: "xiaomi.mimo-v2.6", wire: "structural", evidence: "RF-OC-036" }],
  },
]

// Every other family is passive: classification + accounting only, NO request mutation.
export const PASSIVE_FAMILIES = ["deepseek", "kimi", "claude", "gemini", "qwen", "grok", "muse", "minimax"]

// Capability keys that, if ever true for a passive family, would mean a request
// mutation (a regression). These are the *mutation-implying request* capabilities;
// `thinkingIntegrity` / `cacheRatio` / `providerChange` / `prefixDiagnostics` are
// diagnostics only (`thinkingIntegrity` gates a V1 diagnostic path that never
// rewrites content). Grok/Muse/MiniMax expose *descriptive* route flags, listed
// separately so they are not mistaken for mutations.
export const MUTATION_CAPABILITY_KEYS = [
  "gptCacheMetadata",
  "envRelocation",
  "openRouterAffinity",
]
export const DESCRIPTIVE_ROUTE_FLAGS = [
  "grokCacheAffinity",
  "grokRouteAware",
  "museCacheAffinity",
  "museRouteAware",
  "museCacheRetention",
  "minimaxRouteAware",
  "minimaxCacheWriteBilled",
]
