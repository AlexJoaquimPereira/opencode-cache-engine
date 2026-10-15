# Phase 4 — P4-T1: policy inventory and metadata

**Task:** P4-T1 (`TODO.md`) — enumerate every policy the plugin implements and record
per-policy metadata (class, eligible provider/model/routes, mutation, preconditions/no-op,
structural + wire verification, risks, disable path, evidence level). This is the catalog
P4-T2..P4-T5 build on.
**Type:** research — read-only. No request mutated; no provider contacted.
**Baseline inputs:** plan §8; `src/cache-policy-core.mjs` (`POLICY_REGISTRY`, `BASELINES`,
`OVERLAYS`, `TRANSPORTS`); `src/cache-engine-core.mjs` (`defaultPolicies`, `parseConfig`);
`src/cache-engine.ts` (V1 hooks) + `src/cache-engine-v2.mjs` (V2 hooks);
`docs/cache-policy-inventory.md`; `RF-OC-*` / `RF-OR-*`; the `AGENTS.md` provider invariants.

**Policy classes (plan §8):** **passive** (observe only) · **structural** (narrow,
content-preserving transform) · **transport-specific** (cache key / affinity header /
breakpoint on a verified route) · **experimental** (default off until evidence gates pass).

**Evidence levels:** `[D]` documented first-party · `[O]` observed/structurally/wire verified ·
`[I]` inferred · `[U]` unknown/not attributed. **Provider measured: not performed** for all.

---

## 1. Mutation-bearing policies

| # | Policy | Class | Hook / mechanism | Mutation (exact) | Eligible route | No-op / preconditions | Disable path |
|---|---|---|---|---|---|---|---|
| A1 | **GPT-5.6+ cache metadata** (`gpt56`) | **transport-specific** | V1 `chat.params` / V2 `context` (`options`) | add **missing** `promptCacheKey` + `promptCacheOptions` (default `implicit`, `30m`); preserves runtime values | OpenAI/Azure-compatible (`requiresOpenAIish`); GPT-5.6-and-later boundary | no-op if `options` absent/malformed; never overwrites an existing key; compaction uses the `<root>:compact` namespace | `policies.gpt56.enabled=false`; `policies.gpt56.promptCacheKey=false` |
| A2 | **GLM-5.3 `<env>` relocation** (`glm53`) | **structural** | `experimental.chat.system.transform` | relocate the identifiable `<env>` block to the system tail (content-preserving) | GLM-5.3 family (overlay **not** inherited by `glm-5.3-plus`) | exactly one eligible text part, else **no-op**; `<env>` marker guard intact | `policies.glm53.enabled/stabilizeSystem=false` |
| A3 | **GLM-5.3 daily-date relocation** (`glm53`) | **experimental** (default **off**) | same system transform | relocate the standalone `Today's date: …` line to the system tail | GLM-5.3 | missing/duplicate/malformed/ambiguous ⇒ **no-op**; never pins the date | `policies.glm53.stabilizeDate=false` (default) |
| A4 | **MiMo `<env>` relocation** (`mimo26`) | **structural** | system transform | as A2 | MiMo-V2.6 Flash/Pro (overlay **not** inherited by `-plus`/Ultraspeed) | as A2 | `policies.mimo26.enabled/stabilizeSystem=false` |
| A5 | **MiMo daily-date relocation** (`mimo26`) | **experimental** (default **off**) | system transform | as A3 | MiMo-V2.6 | as A3 | `policies.mimo26.stabilizeDate=false` |
| A6 | **OpenRouter session affinity** (GLM-5.3 + MiMo-V2.6) | **transport-specific** | V1 `chat.headers` / V2 `model.request` | add deterministic `x-session-id` **only** when the actual `providerID` is exactly `openrouter`; preserves a case-insensitive pre-existing header | OpenRouter transport only | not `openrouter` ⇒ never add; header present ⇒ preserve | inherent (only fires for those families + `openrouter`); `mimo26.stickySession` gates only the telemetry id, not injection |

## 2. Passive policies (classification + accounting only; **no** request mutation)

| # | Policy | Class | Why passive | Notable route observation | Disable path |
|---|---|---|---|---|---|
| B1 | **DeepSeek** (`deepseek`) | passive | caching is provider-wide; no cache key/flag/breakpoint | `RT` caps neutral | `policies.deepseek.enabled=false` |
| B2 | **Kimi** (`moonshot`) | passive | Moonshot implicit on Chat/Responses; `prompt_cache_options` selects TTL only; explicit breakpoint rejected | Anthropic-Messages `cache_control` shape deliberately not applied | `policies.kimi.enabled=false` |
| B3 | **Claude** (`anthropic`) | passive | OpenCode itself applies Anthropic `cache_control` breakpoints; duplicating risks TTL conflicts | `tokens.cache.{read,write}` normalized by OpenCode | `policies.claude.enabled=false` |
| B4 | **Gemini** (`google`) | passive | provider-managed implicit; no request-side field; OpenCode's `applyCaching` gate excludes Gemini | explicit `cachedContents` is a separate resource (not managed) | `policies.gemini.enabled=false` |
| B5 | **Qwen** (`alibaba`) | passive | implicit automatic; block-level marker unreachable via the V1 hook; OpenCode applies breakpoints on Qwen Messages routes | — | `policies.qwen.enabled=false` |
| B6 | **Grok** (`xai`) | passive (+ route-aware observation) | automatic; OpenCode supplies the Responses affinity key; CacheEngine preserves it | `grokCacheAffinity`/`grokRouteAware` are **descriptive**, not mutations; Chat `x-grok-conv-id` unreachable | `policies.grok.enabled=false` |
| B7 | **Muse** (`meta`) | passive (+ route-aware observation) | automatic positional prefix caching; the key must be application-stable (not per-session) | `museCacheRetention` = `"harness-owned"` (descriptive) | `policies.muse.enabled=false` |
| B8 | **MiniMax** (`minimax`) | passive (+ route-aware) | automatic; OpenCode owns breakpoints on the `@ai-sdk/anthropic` routes | **model-split** baselines: `minimax.m3-cache` (no billed write) vs `minimax.m2-cache` (billed write) — never flattened | `policies.minimax.enabled=false` |
| B9 | **Neutral / unknown** | passive (fail-closed) | unrecognised identity ⇒ nothing applied | `legacy:false` registry entries resolve to `NEUTRAL_RUNTIME` | inherent |

## 3. Transport registry

| Transport | kind | session affinity | sticky routing | Notes |
|---|---|---|---|---|
| `openrouter` | openrouter | `x-session-id` (A6) | yes | the only transport with an affinity header |
| direct / unknown provider | direct/unknown | none | no | falls back to no affinity |

## 4. Non-mutating diagnostics (read-only; never rewrite the request)

| Diagnostic | Where | Scope | Notes |
|---|---|---|---|
| `prefix-change` / `prefix-observation` telemetry | V1 | per session | structural (hash-based), no prompt content |
| `lintSystemVolatility` | V1 (+ V2 system only) | system (V2 passes **no tools**) | advisory; `VOL-CWD-PATH`/`VOL-DATE` are `info` |
| `detectReasoningIssues` (+ `reasoningIssueReasons`) | V1 only, GLM-gated (`thinkingIntegrity` + `preserveThinkingIntegrity`) | reasoning replay | detects duplicate/reordered/modified reasoning; MiMo variant is instrumentation-only |
| `reasoningEffortFromOptions` / `observeReasoningEffort` | V1 | GPT options | observe-only |
| usage accounting (`scanPage`, ratios) | V1 (+ V2 `context`/events) | session history | best-effort; never exactly-once |

## 5. Verification status (what P4-T2..T5 must close)

| Policy | Structural verification | Wire verification | Evidence | Gap |
|---|---|---|---|---|
| A1 GPT cache metadata | assigned in-hook (verified) | **NOT attributed — verified (P4-T2)**: `prompt_cache_key` is OpenCode's session-derived value (present OFF==ON); `prompt_cache_options` is dropped by every inspected schema (`RF-OC-047`) | `[O]`/`[D]` | closed (not wire-effective) |
| A2/A4 `<env>` relocation | tested (unit + corpus) | structural; not a provider-benefit claim | `[O]` | ok |
| A3/A5 date relocation | tested (no-op conditions) | **wire-verified** (G3, `RF-OC-036`) | `[O]` | promotion still open (Phase 2) |
| A6 OpenRouter affinity | logic verified (unit + telemetry) | **NOT attributed — verified (P4-T3)**: OpenCode already sets `x-session-id`; the adapter preserves it (`headerSource:"preexisting"`) and never attaches its own (`RF-OC-048`) | `[O]` | closed (not wire-effective) |
| B1..B9 passive | n/a (no mutation) | must stay passive | `[D]`/`[O]` | confirm none mutate |

## 6. Gaps / inconsistencies found (input to P4-T2..T5)

1. **A1 wire carriage — closed by P4-T2:** the adapter assigns the fields, but there is **no
   attributable wire effect** on the tested live route (`RF-OC-047`).
2. **A6 header attachment — closed by P4-T3:** the wire header is OpenCode's native
   `x-session-id`, not the adapter's (`RF-OC-048`).
3. **The date relocation (A3/A5) is a policy flag, not a registered `OVERLAYS` entry** — it
   shares the system-transform hook. Recorded so the inventory is complete.
4. **V2 parity:** V2 does not port `detectReasoningIssues`, tool fingerprints, or
   `lintSystemVolatility(tools)`; V1-only diagnostics are noted to avoid claiming V2 parity.
5. **Operations:** every mutation-bearing policy already declares a disable path + no-op
   condition (`O-9`) — none lacks one.

---

**Method note:** this inventory is read from the shipped code + the tracked stores; it does
not re-derive provider behavior (that is P4-T2/P4-T3). No managed config was touched.
