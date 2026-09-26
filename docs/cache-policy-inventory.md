# CacheEngine Cache-Policy Compatibility Inventory

Release: **v0.4.0 — research and documentation only.**

This document inventories documented cache behavior for the model boundaries that
CacheEngine classifies, and states whether CacheEngine's current treatment is
supported by first-party documentation. It makes **no runtime claims** and does
**not** propose or apply code changes.

- Repository revision for "CacheEngine current treatment": `19b87f2` (`master`).
- All sources were consulted on **2026-09-26**.
- Runtime behavior, model detection, provider configuration, telemetry, and GPT
  limits are unchanged by this release.

## Evidence classification legend

Every substantive statement below is tagged:

| Tag | Meaning |
| --- | --- |
| **[D]** | Documented fact — stated in a first-party source. |
| **[O]** | Observed behavior — observed in this repository (tests or hook logic). |
| **[I]** | Inference — reasoned from documented facts, not stated directly. |
| **[U]** | Unknown — first-party documentation is insufficient or silent. |

Two non-negotiable rules applied throughout:

1. A model being newer is **not** evidence that it inherits an older cache policy.
2. A shared model-name prefix is **not** evidence that two models share cache controls.

Caching behavior is never inferred from pricing alone, from one SDK's type
declarations, or from a third-party blog when first-party documentation exists.
"unknown — first-party docs insufficient" is used instead of a guess.

## CacheEngine current treatment (baseline for the matrix)

Source: `src/cache-engine-core.mjs` (detection, transforms) and
`src/cache-engine.ts` (hooks), revision `19b87f2`.

| Family | Detection (verbatim) | Current treatment | Affinity header |
| --- | --- | --- | --- |
| DeepSeek | `/deepseek/i` on `${apiID} ${modelID}` or `providerID` | Passive; no mutation | none |
| GPT-5.6 | `/gpt-5\.6(?![\d.])/i` on slug **and** `isOpenAIish` (provider `openai`/`azure`, slug `openai/`/`azure/`, or npm `@ai-sdk/openai`/`@ai-sdk/azure`) | Inject missing `promptCacheKey` + `promptCacheOptions` (`implicit`, `30m`) | none |
| GLM-5.3 | `/glm-5\.3(?![\d.])/i` on slug | Relocate identifiable `<env>` block to system tail | `x-session-id` only when `providerID === "openrouter"` |
| MiMo-V2.6 | `/mimo-v2\.6-(flash\|pro)(?![\w-])/i` on slug | Relocate identifiable `<env>` block to system tail; provider-change telemetry | `x-session-id` only when `providerID === "openrouter"` |
| Neutral | everything else | Byte-untouched | none |

Detection consequences worth stating explicitly:

- `gpt-6*` / `gpt-6-*` is **not** matched → neutral. **[O]**
- `deepseek-v5` (or any future `*deepseek*` id) matches the passive DeepSeek
  branch because the regex is a bare substring test. **[O]**
- `mimo-v2.6-pro-ultraspeed` is **not** matched: the `(?![\w-])` lookahead fails
  on the following `-`. Test `MiMo V2.5 and Pro-UltraSpeed do NOT match MiMo policy`
  confirms this. **[O]**
- `mimo-v2.5*` and `glm-5.2`/`glm-4.x` are neutral. **[O]**

---

## 1. OpenAI (GPT-5.6 and later)

OpenAI documents a **generation-boundary** cache policy, literally named
"GPT-5.6 and later", plus a distinct class for "GPT-5.5 and GPT-5.5 Pro" and a
catch-all "earlier models". [D]

| # | Item | Finding | Tag |
| --- | --- | --- | --- |
| 1 | Model names/aliases | GPT-5.6 family: `gpt-5.6-sol` (flagship), `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.6-cyber`; `gpt-5.6` is an alias for `gpt-5.6-sol`. GPT-6 family: `gpt-6-astra` (flagship), `gpt-6-sol`, `gpt-6-luna`. Aliases `gpt-daybreak-blue-latest` → `gpt-5.6-sol`, `gpt-daybreak-red-latest` → `gpt-5.6-cyber`. | [D] |
| 2 | Family identification | Pattern `gpt-<generation>[-<codename>][-<variant>]`; unsuffixed id maps to one tier. The generalized rule is inference; the concrete IDs/aliases are documented. | [D]/[I] |
| 3 | Scope | Generation-boundary-specific ("GPT-5.6 and later" covers GPT-5.6 and GPT-6). Not creator-wide, not exact-model. Cache availability remains a per-model supported feature. | [D] |
| 4 | Automatic vs controls | Enabled by default (implicit). GPT-5.6+ additionally supports explicit opt-in via `prompt_cache_options.mode="explicit"` + per-block `prompt_cache_breakpoint`, and `prewarm`. | [D] |
| 5 | Cacheable-prefix rules | Reuse requires the **entire rendered prefix** to match, including hidden instructions, developer messages, tool definitions (names/descriptions/schemas/order), and history. `model`, `tools`, `parallel_tool_calls`, `text.format`, `reasoning.effort`, `text.verbosity`, `context_management`, `service_tier`, `prompt_cache_key` affect matching. | [D] |
| 6 | Minimum cacheable length | **1,024 visible input tokens** for GPT-5.6 and later (fixed). Pre-5.6 length varies by request settings; exact numbers not enumerated. | [D]/[U] |
| 7 | Implicit vs explicit breakpoints | GPT-5.6+ supports both; explicit mode with no developer breakpoints caches nothing; up to 4 cache writes/request. Breakpoints valid on `input_text`/`input_image`/`input_file` and `function_call_output`, **not** on top-level `instructions` or `additional_tools`. Pre-5.6 is implicit only (e.g. GPT-5.5/Pro at 2,048-token intervals). | [D] |
| 8 | Cache key behavior | `prompt_cache_key` is optional on GPT-5.6+ (routing is automatic; key used for per-customer accounting/anti-probing). On pre-5.6 it is the routing-optimization control. A key influences routing; it does not pin a machine or guarantee a hit. | [D] |
| 9 | Retention/TTL | GPT-5.6+: `prompt_cache_options.ttl`, only supported value `30m` (also default); reuse refreshes TTL with no re-write charge. Pre-5.6: `prompt_cache_retention` = `in_memory` or `24h`. GPT-5.5/Pro: `24h` only. | [D] |
| 10 | Usage fields | Responses: `usage.input_tokens_details.cached_tokens`, `usage.input_tokens_details.cache_write_tokens`, plus `prompt_cache_diagnostics` (`cache_hit`/`cache_miss`, `reason`, `comparison_reusable_tokens`, `cache_missed_tokens`). Chat Completions field naming not confirmed first-party. | [D]/[U] |
| 11 | Generation differences | gpt-4o: 0.5× cached, no write charge. gpt-5/5.1/5.5: 0.1×, no write charge. GPT-5.6+: write 1.25×, read 0.1×, min 1,024, TTL 30m, explicit+both modes, exact (non-rounded) boundary reporting. GPT-6 inherits the GPT-5.6 policy. | [D] |
| 12 | Prefix-stability guidance | Put stable developer instructions first; move timestamps/user-specific content later. Append messages; do not rewrite/compact/truncate earlier turns. Keep tool definitions/order/schemas stable; disable tools via `tool_choice`/`allowed_tools` rather than removing definitions. | [D] |
| 13 | Affinity/routing | Cache entries are machine-local; routing is automatic and depends on machine load and a hash of initial tokens (incl. tool definitions), plus `prompt_cache_key` pre-5.6. Traffic >15 rpm can overflow to other machines; keys do not pin machines. | [D] |
| 14 | Context/limits (cache-relevant) | `gpt-5.6-sol` and GPT-6: 1,050,000 context / 922,000 max input / 128,000 max output. Input >272K tokens priced at 2× input (and 2× cache rates) and 1.5× output for the whole request. | [D] |

**OpenAI sources** (title — URL, consulted 2026-09-26; scope in parentheses):

- OpenAI, *Prompt caching* — https://developers.openai.com/api/docs/guides/prompt-caching (all OpenAI models; the authority for the items above).
- OpenAI, *Prompt cache diagnostics* — https://developers.openai.com/api/docs/guides/prompt-caching/diagnostics.
- OpenAI, *Models* — https://developers.openai.com/api/docs/models; *Compare models* — https://developers.openai.com/api/docs/models/compare.
- OpenAI, *GPT-5.6 Sol* — https://developers.openai.com/api/docs/models/gpt-5.6-sol (exact model page: `gpt-5.6-sol`).
- OpenAI, *GPT-6 Astra* — https://developers.openai.com/api/docs/models/gpt-6-astra (exact model page: `gpt-6-astra`).
- OpenAI, *Using GPT-6* — https://developers.openai.com/api/docs/guides/latest-model (GPT-6 family).
- OpenAI, Responses API reference — https://developers.openai.com/api/reference/resources/responses/methods/create.
- OpenAI, *Pricing* — https://developers.openai.com/api/docs/pricing.

**CacheEngine compatibility:** GPT-5.6 handling is consistent with the documented
baseline: it injects only `promptCacheKey` + `promptCacheOptions{mode:implicit,
ttl:"30m"}`, preserves runtime-supplied values, and never sets context/output
limits. It does not use explicit breakpoints or `prewarm`, which is a subset of
the documented capability. GPT-6 is **not** classified and therefore gets no GPT
cache metadata — a documented-scope gap, not a documented incompatibility.

---

## 2. DeepSeek (V4 and later)

DeepSeek documents context caching as **provider-wide, automatic, implicit disk
caching** with no request control. [D]

| # | Item | Finding | Tag |
| --- | --- | --- | --- |
| 1 | Model names/aliases | Current API ids: `deepseek-flash`, `deepseek-v4-pro`. Legacy (`deepseek-v4-flash`, `deepseek-v4-flash-vision-exp`) retired but still routed to DeepSeek-V4.1-Flash. `deepseek-chat`/`deepseek-reasoner` retired 2026-07-24. `deepseek-v4.1` and a bare `deepseek-v4` are **not** request identifiers ("DeepSeek-V4.1-Flash" is only a MODEL VERSION string). | [D] |
| 2 | Family identification | Human-readable MODEL VERSION row and change-log categories ("V4 model family"). No machine-readable family field is documented; `system_fingerprint` is described only as "backend configuration". | [D]/[U] |
| 3 | Scope | Caching guide is provider-wide ("default for all users"); cache-hit pricing listed for both current models. No doc states V4+/exact-model scoping. | [D]/[U] |
| 4 | Automatic vs controls | "Enabled by default… without needing to modify their code"; no flag/field documented. OpenRouter independently states DeepSeek caching is automated and needs no configuration (transport page). | [D] |
| 5 | Cacheable-prefix rules | Hits require a full match of a **cache prefix unit** (independent, complete units). Units persist at user-input end, model-output end, on detected common prefixes, and at fixed token intervals. Historical rule: only identical prefixes "starting from the 0th token" hit. Post-SWA matching differs from before. | [D] |
| 6 | Minimum cacheable length | "**64 tokens** as a storage unit; content less than 64 tokens will not be cached" — stated on the 2024 announcement page only, not restated on the current guide/pricing page. Possible staleness for V4+. | [D]/[I] |
| 7 | Implicit vs explicit breakpoints | Implicit only. No `cache_control`/breakpoint/cache-creation endpoint appears in the request schema. | [D] |
| 8 | Cache key behavior | No cache-key field. `user_id` is documented for KVCache isolation and scheduling isolation; not a cache key per se. | [D]/[U] |
| 9 | Retention/TTL | "Cleared… usually within a few hours to a few days"; "cache construction takes seconds". No numeric TTL. | [D] |
| 10 | Usage fields | `usage.prompt_cache_hit_tokens`, `usage.prompt_cache_miss_tokens`; `usage.prompt_tokens = hit + miss`; `usage.prompt_tokens_details.cached_tokens` = same as hit tokens. | [D] |
| 11 | Generation differences | V2: MLA caching feasibility. Sliding Window Attention changed prefix storage/matching (transition version not named in the cache guide; change log shows V3.2-Exp as the SWA/DSA point). V4: token-wise compression + DSA, 1M standard. V4.1-Flash: "smallest model in our new architecture family". No doc states cache semantics differ between V4.1-Flash and V4-Pro. | [D]/[I] |
| 12 | Prefix-stability guidance | Mechanism only; no explicit "keep system/tools/order stable" instruction. Documented examples: `A+B`→`A+B+C` hits; `A+B`→`A+C` does not (until common prefix `A` is recognized). | [D]/[U] |
| 13 | Affinity/routing | `user_id` isolates KVCache; no cache-affinity routing guarantee documented. Each user's cache is isolated. | [D] |
| 14 | Direct vs OpenRouter | Direct API: automatic disk caching on both current models. OpenRouter: lists DeepSeek under automated caching, cache reads 0.1× input, `cached_tokens`/`cache_write_tokens` in `prompt_tokens_details`; OpenRouter does not enumerate the current V4 names. | [D] |

**DeepSeek sources** (consulted 2026-09-26; scope in parentheses):

- DeepSeek, *Context Caching* — https://api-docs.deepseek.com/guides/kv_cache (provider-wide; default for all users).
- DeepSeek, *Models & Pricing* — https://api-docs.deepseek.com/quick_start/pricing (`deepseek-flash`, `deepseek-v4-pro`).
- DeepSeek, *Chat Completions API* — https://api-docs.deepseek.com/api/create-chat-completion (request/usage schema).
- DeepSeek, *Rate Limit & Isolation* — https://api-docs.deepseek.com/quick_start/rate_limit (`user_id` isolation).
- DeepSeek, *Change Log* — https://api-docs.deepseek.com/updates; *news260424* — https://api-docs.deepseek.com/news/news260424; *news260910* — https://api-docs.deepseek.com/news/news260910; *news0802* — https://api-docs.deepseek.com/news/news0802 (2024 64-token note; older matching rule).
- OpenRouter, *Prompt Caching* — https://openrouter.ai/docs/features/prompt-caching (transport layer only).

**CacheEngine compatibility:** Passive DeepSeek treatment matches the documented
baseline exactly (automatic, no controls, no key). The `/deepseek/i` substring
detector means any future `deepseek-v5`-style id also becomes passive, which is
the safe direction. No CacheEngine optimization is required for DeepSeek.

---

## 3. Z.AI GLM (5.3 and later)

Z.AI documents **implicit, automatic context caching**; no explicit cache
control, cache key, or numeric TTL is documented. [D]

| # | Item | Finding | Tag |
| --- | --- | --- | --- |
| 1 | Model names/aliases | "GLM-5.3" is documented as current flagship. Enum includes `glm-5.3`, `glm-5.2`, `glm-5.1`, `glm-5`, `glm-4.7`, `glm-4.7-flash`, `glm-4.7-flashx`, `glm-4.6`, `glm-4.5`, `glm-4.5-air/x/airx/flash`, `glm-4-32b-0414-128k`; vision adds `glm-5.3-flashx`, `glm-5.3-flash`, `glm-4.6v*`, `glm-4.5v`. Release order 4.5→4.6→4.7→5→5.1→5.2→5.3. No alias mechanism documented. | [D] |
| 2 | Family identification | Literal `model` id string only; no family field. Param docs group "GLM-5.3/5.2/5.1/5/4.7/4.6 series" vs "GLM-4.5 series". GLM-5.3 shares a base model with GLM-5.2, differing by post-training. | [D] |
| 3 | Scope | Implicit mechanism is service-wide, but cacheability and cached-input price are **exact-model-specific** (e.g. `GLM-4-32B-0414-128K` has no cached-input price). | [D]/[I] |
| 4 | Automatic vs controls | "Automatic Cache Recognition: Implicit caching… without manual configuration." No `cache_control`, `prompt_cache_key`, breakpoint, or TTL parameter in the API. | [D] |
| 5 | Cacheable-prefix rules | Identifies content "identical or highly similar to previous requests"; identical content hits best; "minor formatting differences may affect cache effectiveness". Recommended layout: stable instructions first in the system prompt, variable content last. | [D] |
| 6 | Minimum cacheable length | No hard minimum documented. Soft guideline only: repeated prefix "recommend 500+ tokens"; two or three short system sentences usually will not hit. | [D]/[U] |
| 7 | Implicit vs explicit breakpoints | Implicit only. No explicit breakpoint documented. | [D] |
| 8 | Cache key behavior | No user-supplied or derived cache key documented by Z.AI. | [U] |
| 9 | Retention/TTL | "Cache has reasonable time limits, will recalculate after expiration"; asynchronous effect. No numeric expiry. Cached-input storage listed as limited-time free. | [D]/[U] |
| 10 | Usage fields | `usage.prompt_tokens_details.cached_tokens` ("tokens served from cache"). No cache-write/creation field documented (writes are not billed/reported). | [D] |
| 11 | Generation differences | No cache-semantics difference stated per generation. Differences are pricing (cached-input $0.26 for 5.3/5.2/5.1, $0.2 for 5, $0.11 for 4.7/4.6/4.5, etc.), support (no cache price for `GLM-4-32B-0414-128K`), and unrelated context/output changes. | [D] |
| 12 | Prefix-stability guidance | Use stable system-prompt templates; put long documents as system messages; manage history; avoid frequent content changes; monitor hit rate. Stable rules/knowledge first, variable content last. No tool-order guidance. | [D] |
| 13 | Affinity/routing | Z.AI documents **no** affinity/session/routing parameter; direct-endpoint cache-reuse controls are unknown. (OpenRouter's sticky routing is transport, not Z.AI semantics.) | [D]/[U] |
| 14 | Direct vs OpenRouter | Direct endpoints: cache docs example `api.z.ai/api/paas/v4/chat/completions` and `open.bigmodel.cn/api/paas/v4/chat/completions`, returning `cached_tokens`. OpenRouter route: automated, no configuration, reads reported in `cached_tokens`, plus sticky routing. | [D] |

**Z.AI GLM sources** (consulted 2026-09-26; scope in parentheses):

- Z.AI, *Context Caching* — https://docs.z.ai/guides/capabilities/cache.md (service-wide; GLM families).
- BigModel (Z.AI studio), *上下文缓存* — https://docs.bigmodel.cn/cn/guide/capabilities/cache.md (same feature; 500+ token recommendation; layout advice).
- Z.AI, *Chat Completion* API — https://docs.z.ai/api-reference/llm/chat-completion.md (model enum; `prompt_tokens_details`).
- Z.AI, *Pricing* — https://docs.z.ai/guides/overview/pricing.md (per-model cached-input rates).
- Z.AI, *GLM-5.3* — https://docs.z.ai/guides/llm/glm-5.3.md; *Migrate to GLM-5.3* — https://docs.z.ai/guides/overview/migrate-to-glm-new.md; *New Released* — https://docs.z.ai/release-notes/new-released.md.
- OpenRouter, *Prompt Caching* — https://openrouter.ai/docs/features/prompt-caching (transport only).

**CacheEngine compatibility:** GLM env-block relocation is a CacheEngine
optimization consistent with Z.AI's documented "stable prefix first, variable
content last" guidance, but it is **not** a Z.AI-documented control — it is an
exact-model overlay. `x-session-id` is an OpenRouter transport affordance, not a
Z.AI-documented request parameter.

---

## 4. Xiaomi MiMo (V2.6 and later)

Xiaomi documents per-model "Context Caching" and prefix-hit billing but describes
**no** request control, cache key, minimum length, TTL, or prefix-stability
guidance. [D]/[U]

| # | Item | Finding | Tag |
| --- | --- | --- | --- |
| 1 | Model names/aliases | API ids: `mimo-v2.6-pro`, `mimo-v2.6-flash`, `mimo-v2.6-pro-ultraspeed`, `mimo-v2.5-pro`, `mimo-v2.5`. OpenRouter slugs: `xiaomi/mimo-v2.6-flash`, `xiaomi/mimo-v2.6-pro`, `xiaomi/mimo-v2.6-pro-ultraspeed`. HF checkpoints: `MiMo-V2.6-Pro-RL`, `MiMo-V2.6-Flash-RL`, `MiMo-V2.6-Distill-Qwen-9B`. UltraSpeed is documented as a **mode** of Pro, not a separate checkpoint. | [D] |
| 2 | Family identification | "MiMo-V2.6 series" = Pro + Flash (both native multimodal); Pro also offers UltraSpeed mode. HF collection "MiMo-V2.6". | [D] |
| 3 | Scope | Per-model capability list shows "Context Caching" for v2.6-flash (and indexed model pages for pro/ultraspeed/v2.5). Whether the implementation is shared family-wide vs per exact model is not stated. | [D]/[U] |
| 4 | Automatic vs controls | No cache-control field in any of the three protocols (OpenAI, Anthropic, Responses). Pricing describes cache hits purely from prefix content hitting the cache. Operation is provider-managed/implicit. | [D]/[I] |
| 5 | Cacheable-prefix rules | Only "the requested prefix content" is stated; no prefix-boundary/ordering/role definition. | [D]/[U] |
| 6 | Minimum cacheable length | Not documented. | [U] |
| 7 | Implicit vs explicit breakpoints | No explicit breakpoint mechanism documented in any request schema. | [D]/[U] |
| 8 | Cache key behavior | No user-supplied cache key or derivation rule documented. | [U] |
| 9 | Retention/TTL | No prompt-cache TTL/expiry documented. (The docs' "5-minute cache period" refers to the Web Search plugin toggle — **not** the prompt cache.) | [U] |
| 10 | Usage fields | OpenAI Chat: `usage.prompt_tokens_details.cached_tokens`. Responses: `usage.input_tokens_details.cached_tokens`. Anthropic: `usage.cache_read_input_tokens`. No Xiaomi cache-**write** field (Cache Write is limited-time free). | [D] |
| 11 | Generation differences | v2.5-pro/v2.5 deprecated 2026-10-21; v2.6 current. UltraSpeed exists as a V2.5-Pro limited-time mode and as `mimo-v2.6-pro-ultraspeed` ("up to 20x" speed). Batch API supports only `mimo-v2.6-pro`/`mimo-v2.6-flash`. Cache-hit pricing differs per model. No documented caching-**mechanism** difference across flash/pro/ultraspeed or v2.5/v2.6. | [D]/[U] |
| 12 | Prefix-stability guidance | None found in Xiaomi docs. | [U] |
| 13 | Affinity/routing | Xiaomi documents no session-affinity parameter; only `api-key`/Bearer auth. OpenRouter sticky routing is transport, not Xiaomi semantics. | [D]/[U] |
| 14 | Direct vs OpenRouter | OpenRouter's own Prompt Caching page has per-provider sections for OpenAI/Anthropic/Groq/Grok/Moonshot/Alibaba/DeepSeek/Z.AI/Google — **MiMo is absent**, so OpenRouter documents no MiMo-specific cache semantics. | [D] |

**Xiaomi MiMo sources** (consulted 2026-09-26; scope in parentheses):

- MiMo, *OpenAI Chat Completions API Compatibility* — https://mimo.mi.com/docs/en-US/api/chat/openai-api (all MiMo API ids; usage fields).
- MiMo, *Anthropic Messages API Compatibility* — https://mimo.mi.com/docs/en-US/api/chat/anthropic-api.
- MiMo, *OpenAI Responses API Compatibility* — https://mimo.mi.com/docs/en-US/api/chat/responses.
- MiMo, *API Pricing* — https://mimo.mi.com/docs/en-US/price/pay-as-you-go (per-model cache-hit/write pricing).
- MiMo, *Models* — https://mimo.mi.com/docs/en-US/quick-start/summary/model (v2.5 deprecation; capabilities).
- MiMo, *MiMo-V2.6-Flash* — https://mimo.mi.com/models/en-US/mimo-v2.6-flash ("Context Caching" capability).
- MiMo, *MiMo-V2.6: Scaling Up RL for Self-Improvement* — https://mimo.mi.com/docs/en-US/news/latest/v2-6 (series naming, UltraSpeed mode).
- Hugging Face, `XiaomiMiMo/MiMo-V2.6-Flash-RL` and `MiMo-V2.6-Pro-RL` model cards (checkpoint names).
- OpenRouter, *Prompt Caching* — https://openrouter.ai/docs/features/prompt-caching; *Provider Routing* — https://openrouter.ai/docs/features/provider-routing (transport only).

**CacheEngine compatibility:** MiMo env-block relocation is not supported by any
Xiaomi prefix-stability instruction ([U]); it is an exact-model overlay carried
over from the GLM family. MiMo `cachedTokens/promptTokens` telemetry matches the
documented `cached_tokens`/`prompt_tokens` fields. `x-session-id` is documented
by OpenRouter (transport) but not by Xiaomi.

---

## 5. OpenRouter transport facts (routing only, not model semantics)

These are OpenRouter routing/transport facts. They are **not** evidence of any
creator's cache semantics.

- OpenRouter uses **provider sticky routing** to keep follow-up requests on the
  provider that served a cached request; it activates when cache-read pricing is
  below normal prompt pricing, and falls back if the sticky provider is
  unavailable. [D]
- Sticky granularity is account-level, per model, per conversation. The default
  conversation key is a hash of the first system/developer message plus the first
  non-system message. [D]
- An explicit top-level body `session_id` **or** `x-session-id` header replaces
  the derived key (body wins if both; max 256 chars). Without it, stickiness
  activates only after a cache hit. Sticky sessions expire after **10 minutes of
  inactivity** and are disabled when manual `provider.order` is set. [D]
- Source: OpenRouter, *Prompt Caching* — https://openrouter.ai/docs/features/prompt-caching
  (consulted 2026-09-26).

CacheEngine's `x-session-id` injection is therefore a **transport-specific**
behavior for `providerID === "openrouter"` only, which matches OpenRouter's
documented header name. It is not a creator-documented cache control.

---

## 6. CacheEngine Compatibility Matrix

Legend for "recommended family inheritance": **keep** = current treatment
matches docs; **extend** = docs support broadening scope (a future change, not
made here); **hold** = do not inherit without first-party evidence.

| Creator | Model / example pattern | Cache policy (documented) | CacheEngine current treatment | Recommended family inheritance | Recommended exact-model exception | Confidence | Source | Verified |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| OpenAI | `gpt-5.6`, `gpt-5.6-*` (sol/terra/luna/cyber) | "GPT-5.6 and later": implicit default, optional explicit breakpoints, min 1,024, TTL 30m, write 1.25×/read 0.1× | GPT policy: inject `promptCacheKey` + `promptCacheOptions{implicit,30m}` | keep | none documented; CacheEngine's subset is valid | High (docs) / Medium (treatment) | OpenAI *Prompt caching*; *GPT-5.6 Sol* | 2026-09-26 |
| OpenAI | GPT-6 / current later GPT family: `gpt-6`, `gpt-6-*` (astra/sol/luna) | Inherits the GPT-5.6-and-later policy | **Not matched** → neutral (no GPT metadata) | **extend**: docs classify GPT-6 as "later", so it inherits the same policy | none documented | High (docs) / High (gap) | OpenAI *Using GPT-6*; *GPT-6 Astra*; *Prompt caching* | 2026-09-26 |
| OpenAI | pre-5.6 negative controls: `gpt-5.5`, `gpt-5.4`, `gpt-5.2`, `gpt-5.1`, `gpt-5`, `gpt-4.1`, `gpt-4o` | Implicit only; different min-length class; `in_memory`/`24h` retention; `prompt_cache_key` for routing | neutral | **hold** — do not inherit 5.6 policy | n/a | High | OpenAI *Prompt caching*; *Pricing* | 2026-09-26 |
| DeepSeek | V4: `deepseek-v4-pro`, legacy `deepseek-v4-flash` | Provider-wide automatic disk cache; implicit; prefix-unit matching; hit/miss token fields | Passive (no mutation) | keep | none | High | DeepSeek *Context Caching*; *Models & Pricing* | 2026-09-26 |
| DeepSeek | V4.1 / current V4-family: `deepseek-flash` (MODEL VERSION "DeepSeek-V4.1-Flash") | Same provider-wide automatic policy; cache-hit pricing listed for both current models | Passive | keep (creator/family baseline) | none documented | High | DeepSeek *Models & Pricing*; *news260910* | 2026-09-26 |
| DeepSeek | future-looking V4+ identifiers: `deepseek-v4.1`, `deepseek-v4`, `deepseek-v5` | Not documented as request ids (`deepseek-v4.1`/`deepseek-v4` invalid or version-string only) | Passive via `/deepseek/i` substring (e.g. `deepseek-v5` already passive) | keep passive; treat as unknown-friendly | none | Medium (detection) / Low (future ids) | DeepSeek *Models & Pricing*; *Chat Completions API* | 2026-09-26 |
| DeepSeek | pre-V4 negative controls: `deepseek-chat`, `deepseek-reasoner` | Retired names (retired 2026-07-24); no separate V4+ cache policy claimed | Passive | hold | n/a | High | DeepSeek *Change Log*; *news260424* | 2026-09-26 |
| Z.AI | GLM 5.3: `glm-5.3`, `glm-5.3-flash`, `glm-5.3-flashx` | Implicit automatic caching; `cached_tokens`; stable-prompt-first guidance; no documented min/TTL/key | GLM policy: `<env>` relocation; OpenRouter `x-session-id` | keep (env relocation is an exact overlay, not a Z.AI control) | env relocation is the overlay; keep scoped to GLM-5.3 | Medium | Z.AI *Context Caching*; *Chat Completion*; *Pricing* | 2026-09-26 |
| Z.AI | current later GLM generations (documented): none newer than 5.3; newest below is `glm-5.2`/`glm-5.1`/`glm-5`/`glm-4.7` | Same implicit mechanism documented service-wide; cached-input price per model | neutral (only `glm-5.3` matched) | **hold** — no doc says 5.3 overlay extends upward; none newer documented | n/a | High (no later gens documented) | Z.AI *New Released*; *Pricing* | 2026-09-26 |
| Z.AI | 5.2 and earlier negative controls: `glm-5.2`, `glm-5.1`, `glm-5`, `glm-4.7`, `glm-4.6`, `glm-4.5`, `glm-4-32b-*` | Cacheable (except `glm-4-32b-0414-128k`), different cached-input pricing; no cache-semantics difference documented | neutral | hold | n/a | High | Z.AI *Pricing*; *Chat Completion* (enum) | 2026-09-26 |
| Xiaomi | MiMo V2.6 Flash: `mimo-v2.6-flash` (OR `xiaomi/mimo-v2.6-flash`) | Provider-managed implicit caching; `cached_tokens`; no documented min/TTL/key/prefix rules | MiMo policy: `<env>` relocation; provider-change telemetry; OpenRouter `x-session-id` | keep scoped as exact-model overlay | env relocation unsupported by docs → treat as overlay | Medium | MiMo *Models*; *Pricing*; *openai-api* | 2026-09-26 |
| Xiaomi | MiMo V2.6 Pro: `mimo-v2.6-pro` (OR `xiaomi/mimo-v2.6-pro`) | Same documented per-model implicit caching; per-model pricing | MiMo policy (same as Flash) | keep | none documented | Medium | MiMo *Models*; *Pricing* | 2026-09-26 |
| Xiaomi | MiMo V2.6 Pro UltraSpeed: `mimo-v2.6-pro-ultraspeed` (OR `xiaomi/mimo-v2.6-pro-ultraspeed`) | Documented as a Pro **mode**, same V2.6 series; "Context Caching" listed; no documented mechanism difference from Pro | **Not matched** → neutral (`(?![\w-])` blocks it) | **extend OR document as exception** — docs treat it as the same V2.6 series, but no doc proves identical cache controls | explicit decision needed; current behavior is a de-facto exact-model exception | Medium | MiMo *news/latest/v2-6*; *Models*; *Pricing* | 2026-09-26 |
| Xiaomi | later MiMo generations: none documented beyond V2.6; V2.5 deprecates 2026-10-21 | Not documented | neutral | hold (no docs) | n/a | High (no later gens documented) | MiMo *Models* | 2026-09-26 |
| Xiaomi | V2.5 negative control: `mimo-v2.5`, `mimo-v2.5-pro` | Documented as deprecated 2026-10-21; cache capability listed; no V2.6 policy inheritance claimed | neutral | hold | n/a | High | MiMo *Models*; *news/latest/v2-6* | 2026-09-26 |

---

## 7. Cases where documentation is insufficient to establish inheritance

These are explicit gaps. For each, first-party docs do **not** establish whether
a newer model inherits an older policy. They must not be resolved by guessing.

1. **OpenAI GPT-6 → GPT-5.6 policy inheritance.** The cache guide literally
   groups "GPT-5.6 and later", and the *Using GPT-6* guide treats GPT-6 as the
   current flagship, so inheritance is supported by the generation-boundary
   wording. However, no GPT-6 model page enumerates a cache-behavior delta beyond
   inherited features; the inventory treats inheritance as **[D]** but notes no
   GPT-6-specific cache documentation exists.
2. **DeepSeek V4.1 vs V4-Pro cache-semantics difference.** Not documented. Only
   pricing differs; caching is described provider-wide.
3. **DeepSeek minimum cacheable length for V4+.** The only number (64 tokens) is
   from a 2024 page and is not restated for V4+; treat as **stale/unverified**.
4. **DeepSeek TTL.** "Hours to days" only; no numeric TTL.
5. **Z.AI minimum cacheable length and TTL.** No hard minimum (only a 500+ token
   recommendation); no numeric TTL.
6. **Z.AI cache key.** No key documented.
7. **Z.AI generations newer than 5.3.** None documented; cannot establish
   upward inheritance.
8. **Xiaomi prompt-cache prefix rules, minimum length, key, and TTL.** All
   undocumented.
9. **Xiaomi V2.6 Pro UltraSpeed cache mechanism.** Documented as the same V2.6
   series and a Pro mode, but no first-party statement proves identical cache
   controls to Pro/Flash. This is the one place where CacheEngine's current
   non-match (`mimo-v2.6-pro-ultraspeed` → neutral) is a real scope decision
   rather than a documented fact.
10. **MiMo on OpenRouter.** OpenRouter's Prompt Caching page documents no
    MiMo-specific cache section; only generic sticky-routing behavior applies.
11. **OpenAI Chat Completions usage-field naming** (`prompt_tokens_details` vs
    Responses `input_tokens_details`) was not confirmed first-party.

## 8. What did not change

- No runtime file, test file, configuration, provider config, detection regex,
  policy logic, telemetry field, or GPT context/output limit was modified.
- The existing test suite was run only to confirm the repository remains green
  (116/116).
- This release contains research and documentation only.
