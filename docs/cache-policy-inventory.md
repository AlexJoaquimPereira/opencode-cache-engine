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

## Runtime integration

This inventory is the research input for the policy registry in
`src/cache-policy-core.mjs`. As of **v0.4.1** the runtime hooks consume
`resolveRuntimePolicy(model)` and gate behavior on the registry's explicit
capabilities, so the "CacheEngine current treatment" column below describes
resolver-driven behavior.

Two guarantees follow from that migration:

- `resolveRuntimePolicy(model).policy` equals the legacy `detectPolicy(model)`
  string, so telemetry and gating are unchanged for every model supported in
  v0.3.6.
- Registry entries marked non-`legacy` (for example
  `mimo-v2.6-pro-ultraspeed`) and all unknown models resolve to a neutral
  runtime, so no documented-but-unwired model gains a current model's mutation.

The runtime reads the registry at classification time only; there are no network
calls and no runtime documentation lookups.

## CacheEngine current treatment (baseline for the matrix)

Source: the pure registry/resolver (`src/cache-policy-core.mjs`) and the hook
entry (`src/cache-engine.ts`), as wired in v0.4.1. The behavior described here is
the same as at the pre-resolver revision `19b87f2`; only the classification
source changed.

| Family | Detection (verbatim) | Current treatment | Affinity header |
| --- | --- | --- | --- |
| DeepSeek | `/deepseek/i` on `${apiID} ${modelID}` or `providerID` | Passive; no mutation | none |
| GPT-5.6 | version boundary `gpt-<major>[.<minor>] ≥ 5.6` on slug **and** `isOpenAIish` (provider `openai`/`azure`, slug `openai/`/`azure/`, or npm `@ai-sdk/openai`/`@ai-sdk/azure`); since v0.4.2 covers GPT-6 and later | Inject missing `promptCacheKey` + `promptCacheOptions` (`implicit`, `30m`) | none |
| GLM-5.3 | `/glm-5\.3(?![\d.])/i` on slug | Relocate identifiable `<env>` block to system tail | `x-session-id` only when `providerID === "openrouter"` |
| MiMo-V2.6 | `/mimo-v2\.6-(flash\|pro)(?![\w-])/i` on slug | Relocate identifiable `<env>` block to system tail; provider-change telemetry | `x-session-id` only when `providerID === "openrouter"` |
| Neutral | everything else | Byte-untouched | none |

Detection consequences worth stating explicitly:

- `gpt-6` / `gpt-6-*` (and any future 5.6+/6+/7+ version) is matched by the
  documented GPT-5.6-and-later boundary → GPT policy. **[O]** (v0.4.2)
- `gpt-5.5`, `gpt-5.2`, `gpt-4o`, and the malformed `gpt-5.60` are **not**
  matched → neutral. **[O]**
- `deepseek-v5` (or any future `*deepseek*` id) matches the passive DeepSeek
  branch because the regex is a bare substring test. **[O]**
- `mimo-v2.6-pro-ultraspeed` is matched by its own explicit entry since v0.4.5
  (MiMo family baseline, no `<env>` overlay). **[O]**
- Undocumented V2.6 variants such as `mimo-v2.6-flashx` remain neutral, and
  `mimo-v2.5*` and `glm-5.2`/`glm-4.x` are neutral. **[O]**

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
the documented capability. Since v0.4.2 the policy resolves by the documented
"GPT-5.6 and later" boundary, so GPT-6 (astra/sol/luna) receives the same
baseline; no GPT-6 cache-control exception is documented (OpenAI *Prompt
caching* guide, re-verified 2026-09-27), and none is coded.

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

## 5. Moonshot Kimi (K2.6 / K2.7-code / K3)

Moonshot/Kimi exposes **three different request shapes** with different cache
controls; they must not be collapsed. CacheEngine implements the **passive**
OpenAI-compatible path only. Verification date **2026-10-04**.

| # | Question | Finding | Evidence |
| --- | --- | --- | --- |
| 1 | Model names/aliases | Current ids: `kimi-k3` (1M ctx), `kimi-k2.7-code`, `kimi-k2.7-code-highspeed`, `kimi-k2.6` (256K). Deprecated: `kimi-k2.5` and all `moonshot-v1-*` (2026-08-31), the K2 series (`kimi-k2`, `kimi-k2-0905-preview`, `kimi-k2-0711-preview`, `kimi-k2-turbo-preview`, `kimi-k2-thinking*`; 2026-05-25), `kimi-latest` (2026-01-28), `kimi-thinking-preview` (2025-11-11). Global API base `https://api.moonshot.ai`; China `https://api.moonshot.cn`. Docs host moved to `platform.kimi.ai` / `platform.kimi.com`. | [D] |
| 2 | Family identification | Literal request `model` id only; no family field. Generations are K2.6 / K2.7 / K3. | [D]/[I] |
| 3 | Scope (route) | Chat Completions and Responses (both OpenAI-compatible) accept all current ids; the Responses API and the Anthropic-compatible Messages API currently accept **`kimi-k3` only**. | [D] |
| 4 | Automatic vs controls | **Automatic/implicit** on the OpenAI-compatible path. Optional `prompt_cache_options: { mode: "implicit", ttl: "5m"\|"1h" }` selects only the write TTL (default `5m`); `mode` accepts only `"implicit"`; it is **not required** for caching and is not an on/off switch — omitting it auto-writes the prefix at the `5m` tier (Cache Write charges apply). `prompt_cache_breakpoint` in content is rejected (HTTP 400). | [D] |
| 5 | Cacheable-prefix rules | Prefix-content matching; changing any part of a prefix forfeits reuse of everything after it. Org-scoped; manual clearing unsupported. | [D] |
| 6 | Minimum cacheable length | "Cache is stored in blocks"; a portion smaller than a block is a miss. **No numeric minimum documented.** | [D]/[U] |
| 7 | Implicit vs explicit breakpoints | Implicit only on the OpenAI-compatible path; explicit per-block breakpoints are rejected. The Anthropic-compatible path instead uses a **top-level** `cache_control { type: "ephemeral", ttl: "5m"\|"1h" }` (per-message markers are ignored); omitting it means the request is read-only at `5m` with no write and no write charge. | [D] |
| 8 | Cache key behavior | Optional `prompt_cache_key` (string) on Chat/Responses for session/task affinity; `metadata.user_id` on the Anthropic path. Matching is fundamentally by prefix content; the key's exact partitioning semantics are undocumented. | [D]/[U] |
| 9 | Retention/TTL | `5m` (default) and `1h` tiers, independent. TTL is locked at first write; a hit renews under the original TTL; a fully expired prefix may be rewritten with a new TTL. | [D] |
| 10 | Usage fields | Chat: `usage.prompt_tokens_details.cached_tokens` (read) and `.cache_write_tokens` (write). Responses: `usage.input_tokens_details.cached_tokens` / `.cache_write_tokens`. Anthropic: `usage.cache_read_input_tokens` / `usage.cache_creation_input_tokens`. Streaming needs `stream_options.include_usage=true`. Cache-write is also surfaced in response headers `Msh-Usage-Cache-Write-Tokens-5m` / `-1h`. | [D] |
| 11 | Generation differences | Cache Write (separate billing + TTL choice) is documented for **`kimi-k3` only**; `kimi-k2.7*`/`kimi-k2.6` support implicit reads only. | [D] |
| 12 | Prefix-stability guidance | Stable system prompts, tool definitions and reference material first; per-turn/user content last; keep fixed content byte-identical within a session; no timestamps/random ids in the prefix. K3 `reasoning_effort` switching invalidates prefix hits. | [D] |
| 13 | Affinity/routing | No provider affinity parameter documented on the native API; `prompt_cache_key` / `metadata.user_id` are session-affinity aids. | [D]/[U] |
| 14 | Gateway (OpenRouter) | OpenRouter lists Moonshot AI as automatic caching (reads 0.25×, writes free) and reports `prompt_tokens_details.cached_tokens` / `cache_write_tokens`. Slugs: `moonshotai/kimi-k3`, `moonshotai/kimi-k2.7-code`, `moonshotai/kimi-k2.6`, `moonshotai/kimi-k2.5`, `moonshotai/kimi-k2-thinking`, `moonshotai/kimi-k2-0905`, `moonshotai/kimi-k2`. Every `moonshotai/*` endpoint fetched reports `supports_implicit_caching: false` while listing `input_cache_read` pricing — the same metadata contradiction seen for MiMo; whether the flag is stale is **UNKNOWN**. OpenRouter sticky routing is transport, best-effort. | [D]/[O]/[U] |

**Conflicting first-party evidence (recorded, unresolved).**

- *K2.x cache-write schema vs FAQ.* The Chat Completions OpenAPI
  (`ChatRequestBase`) declares `prompt_cache_key`/`prompt_cache_options` for the
  K2.x models, while the context-caching FAQ says Cache Write is `kimi-k3` only.
  CacheEngine treats the K3-gated reading as authoritative and the K2.x schema
  entries as generic/unused; the discrepancy is **UNRESOLVED** and is a reason to
  keep the policy passive.
- *Model-name spelling.* The caching academy page names `kimi-k2.7` /
  `kimi-k2.7-highspeed`, whereas the authoritative Models page lists
  `kimi-k2.7-code` / `kimi-k2.7-code-highspeed`. CacheEngine matches the Models
  page ids.

**CacheEngine treatment: passive.** Because caching is automatic on the
OpenAI-compatible path, and `prompt_cache_options` only selects a write TTL (and
Cache Write is K3-only), CacheEngine does **not** mutate the request. It
classifies the documented current ids into the `kimi` family for telemetry and
relies on OpenCode's usage normalization for cache accounting. The
Anthropic-compatible `cache_control` path is **not** implemented (a different
request shape; deferred to a future release). The OpenAI path's optional
`prompt_cache_key`/`prompt_cache_options` are deliberately not sent, because
caching does not require them and the task's rule is "no mutation without a
documented, tested benefit".

Sources (accessed 2026-10-04): Moonshot/Kimi *Best practices for context caching*
(https://www.kimi.ai/academy/best-practices-for-context-caching, updated
2026-09-28) and its mirror https://platform.kimi.ai/docs/guide/context-caching;
API docs https://platform.kimi.ai/docs/api/{chat,responses,messages,models};
OpenRouter *Prompt Caching* (https://openrouter.ai/docs/features/prompt-caching)
and the model endpoints API.

---

## 6. Anthropic Claude (Messages API)

Anthropic caching is **explicit**: a request must carry `cache_control` markers
(top-level automatic caching or per-block breakpoints). **OpenCode 1.18.34 already
applies the breakpoints itself**, so CacheEngine is passive here. Verification date
**2026-10-04**.

| # | Question | Finding | Evidence |
| --- | --- | --- | --- |
| 1 | Model names/aliases | Current ids: `claude-fable-5-1`, `claude-mythos-5-1`, `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-opus-5`, `claude-sonnet-5`, `claude-fable-5`, `claude-mythos-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5` (+`-20251001`), `claude-opus-4-5` (+`-20251101`), `claude-sonnet-4-5` (+`-20250929`); older `claude-3-*`; deprecated `claude-mythos-preview`. | [D] |
| 2 | Family identification | Literal `model` id; families opus/sonnet/haiku/fable/mythos (+ legacy `claude-3-*`). | [D]/[I] |
| 3 | Scope (route) | Native Messages API (`/v1/messages`) and Claude-compatible routes (Bedrock `cachePoint`, Vertex, OpenRouter, Foundry). | [D] |
| 4 | Automatic vs controls | Caching is **not** provider-managed without a marker: top-level `cache_control: {type:"ephemeral"}` (automatic; applies to the last cacheable block) or per-block `cache_control`. OpenCode uses per-block breakpoints. | [D] |
| 5 | Cacheable-prefix rules | Prefix order `tools -> system -> messages`; a change at a level invalidates that level and all later levels. Reads look back up to 20 blocks. | [D] |
| 6 | Minimum cacheable length | Varies by model: 512 tok (fable/mythos 5.x, opus 5.x, sonnet 5.x), 1,024 (opus 4.x, sonnet 4.x/4, opus 4.1), 2,048 (opus 4.7, haiku 3.5, mythos-preview), 4,096 (opus 4.6/4.5, haiku 4.5). | [D] |
| 7 | Breakpoints | Max **4**. Automatic + explicit share the slots; same block + same TTL is a no-op; different TTL or >4 slots = HTTP 400. `cache_control` is valid on text/image/document content blocks, `system[]` blocks, and `tools[]`, not on thinking blocks. | [D] |
| 8 | Cache key behavior | No user cache key; matching is by prefix content. | [D] |
| 9 | Retention/TTL | `5m` default (write 1.25x) or `ttl:"1h"` per breakpoint (write 2x); reads 0.1x. Longer TTL must precede shorter when mixed. OpenCode uses the default 5m. | [D] |
| 10 | Usage fields | `usage.cache_read_input_tokens` (read) and `usage.cache_creation_input_tokens` (write); TTL breakdown `cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens` sums to the total. | [D] |
| 11 | Generation differences | Per-model minimum cacheable length and cache pricing differ; the mechanism is the same. | [D] |
| 12 | Prefix-stability guidance | Stable, reusable content first; volatile content last; do not reorder tools/system/history; a breakpoint should mark a recurring prefix. | [D] |
| 13 | Affinity/routing | No cache-affinity/session parameter. | [D] |
| 14 | Platforms | Automatic top-level caching works everywhere except **legacy Amazon Bedrock (Opus 4.6 and earlier)**, which requires explicit breakpoints. Cache isolation differs (per-workspace on Claude API/AWS/Foundry; per-org on Bedrock/Google Cloud). | [D] |

**OpenCode behavior (decisive).** `ProviderTransform.applyCaching` (v1.18.34)
marks the first two `system` messages and the last two non-system messages
(≤4 breakpoints, default 5m TTL) for Claude/Anthropic transports; on
native/Bedrock it uses message-level provider options, elsewhere the last content
block. It is bypassed when a top-level `options.cacheControl` is supplied.

**CacheEngine treatment: passive (no mutation).** Because OpenCode already applies
breakpoints, CacheEngine classifies Claude into the `claude` family for telemetry
and relies on OpenCode's usage normalization. It deliberately does **not** send
`cacheControl`, `cache_control`, a cache key, or a TTL; doing so would switch
OpenCode to top-level automatic caching and could produce duplicate or
TTL-conflicting markers (→ HTTP 400).

Sources (accessed 2026-10-04): Anthropic *Prompt caching*
(https://platform.claude.com/docs/en/build-with-claude/prompt-caching) and
*Messages* (https://platform.claude.com/docs/en/api/messages); OpenCode
`provider/transform.ts` + `session/session.ts` at tag `v1.18.34`.

**Route support (CacheEngine stays passive on all of these; OpenCode owns the
breakpoints).**

| Route | Protocol / endpoint | Cache-control | Field preservation | Cache scope / routing | Usage reporting | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| Direct Anthropic API | Messages `/v1/messages` | supported | n/a (OpenCode injects) | per-workspace | `cache_read_input_tokens` / `cache_creation_input_tokens` | [D] |
| Claude subscription (OAuth) | not built into OpenCode 1.18.34 (bundled plugin removed; Anthropic prohibits third-party use) | unknown | n/a | unknown | unknown | [D]/[U] |
| OpenCode Zen (`opencode`) | `opencode.ai/zen/v1/messages`, `@ai-sdk/anthropic` | supported (Cached Read/Write pricing) | n/a | service-scoped | provider usage | [D] |
| OpenCode Go (`opencode-go`) | hosted gateway; **serves no Claude models** (MiniMax/Qwen only) | n/a for Claude | n/a | n/a | n/a | [D] |
| OpenRouter → Claude | OpenAI-shaped `/api/v1/chat/completions` | supported (`cacheControl` -> `cache_control`) | preserved by `@openrouter/ai-sdk-provider` | sticky, best-effort, 10-min | `prompt_tokens_details.cached_tokens` / `cache_write_tokens` | [D] |
| Amazon Bedrock Claude | Converse `cachePoint:{type:"default"}` | supported (legacy Opus <=4.6: explicit only) | n/a | per-workspace (AWS) | `cacheReadInputTokens` / `cacheWriteInputTokens` | [D] |
| Google Vertex Claude | Messages `cache_control` | supported | n/a | per-org | `cache_read_input_tokens` / `cache_creation_input_tokens` | [D] |
| OpenAI-compatible gateway serving Claude | Chat Completions | **conditional/unknown** (Anthropic `cache_control` is not in the OpenAI schema) | depends on the gateway | unknown | `prompt_tokens_details.cached_tokens` when present | [D]/[U] |

**OpenCode `applyCaching` gate (v1.18.34).** Fires when
`(providerID === "anthropic" || providerID === "google-vertex-anthropic" ||
api.id OR model.id includes "anthropic"/"claude" || api.npm === "@ai-sdk/anthropic"
|| api.npm === "@ai-sdk/alibaba") && api.npm !== "@ai-sdk/gateway"`. The
`@ai-sdk/gateway` exclusion targets the **Vercel AI Gateway**; OpenCode Zen/Go use
per-model native npm, so they are not excluded.

**Resolved (was UNVERIFIED).** `@openrouter/ai-sdk-provider` converts
`providerOptions.openrouter.cacheControl` to wire `cache_control` (its README),
so OpenRouter Claude caching is supported. The AI SDK turning top-level
`options.cacheControl` into a literal `cache_control` remains inferred from
OpenCode's `usesAnthropicAutomaticCaching` gate. **CacheEngine injects nothing on
any of these routes**, so it cannot make an incompatible endpoint reject a request;
where a gateway drops cache fields, that is a gateway limitation, not a
CacheEngine mutation.

---

## 7. OpenRouter transport facts (routing only, not model semantics)

These are OpenRouter routing/transport facts. They are **not** evidence of any
creator's cache semantics.

- OpenRouter uses **provider sticky routing** to keep follow-up requests on the
  provider that served a cached request; it activates when cache-read pricing is
  below normal prompt pricing. **This is best-effort, not a continuity
  guarantee**: "If the sticky provider becomes unavailable, OpenRouter
  automatically falls back to the next-best provider", and on a provider error
  the cache is not updated so the next request can be re-routed. No first-party
  wording promises the same upstream provider for the session lifetime. [D]
  (best-effort)
- Sticky granularity is account-level, per model, per conversation. The default
  conversation key is a hash of the first system/developer message plus the first
  non-system message. [D]
- An explicit top-level body `session_id` **or** `x-session-id` header replaces
  the derived key (body wins if both; max 256 chars). Without it, stickiness
  activates only after a cache hit. Sticky sessions expire after **10 minutes of
  inactivity** and are disabled when manual `provider.order` is set. Whether
  `provider.sort`/`provider.only` also disable stickiness is undocumented. [D]/[U]
- **Xiaomi/MiMo metadata contradiction (UNKNOWN).** Every `xiaomi/mimo-v2.6-*`
  endpoint reports `supports_implicit_caching: false`, yet every endpoint lists
  `input_cache_read` pricing, MiMo's own docs document context caching and
  `cached_tokens`, and live requests through OpenRouter have returned cached
  tokens. OpenRouter's Prompt Caching page does not list Xiaomi/MiMo as a
  caching provider and does not define the flag's exact semantics, so whether the
  metadata is stale or merely endpoint-scoped is **UNKNOWN**. [O]/[U]
- Source: OpenRouter, *Prompt Caching* — https://openrouter.ai/docs/features/prompt-caching
  and the model endpoints API (`/api/v1/models/xiaomi/mimo-v2.6-{pro,flash,pro-ultraspeed}/endpoints`),
  consulted 2026-10-02 (affinity facts originally 2026-09-26).

CacheEngine's `x-session-id` injection is therefore a **transport-specific,
best-effort** behavior for `providerID === "openrouter"` only, which matches
OpenRouter's documented header name. It is not a creator-documented cache
control and does not guarantee provider continuity.

### 7a. OpenCode usage normalization (verified 2026-10-02)

OpenCode V1 (1.18.34) normalizes provider cache usage into the SDK shape
`Message.info.tokens = { input, output, reasoning, cache: { read, write } }`.
Bundled provider adapters parse each provider's raw fields and OpenCode's session
layer writes `cache.read` / `cache.write`:

- OpenAI Chat Completions / OpenRouter: `prompt_tokens_details.cached_tokens` →
  `cache.read`, `prompt_tokens_details.cache_write_tokens` → `cache.write`.
- OpenAI Responses: `input_tokens_details.cached_tokens` → `cache.read`,
  `input_tokens_details.cache_write_tokens` → `cache.write`.
- Anthropic: `cache_read_input_tokens` → `cache.read`,
  `cache_creation_input_tokens` → `cache.write`.
- DeepSeek: `prompt_cache_hit_tokens` → `cache.read`; `prompt_cache_miss_tokens`
  is retained only in provider metadata (no normalized field), and DeepSeek has
  no write accounting so `cache.write` is 0.

`tokens.input` is **non-cached** input, so total prompt tokens =
`input + cache.read + cache.write`. **CacheEngine therefore needs no
provider-specific parsing**; it reads only the normalized fields.
[DOCUMENTED BY OPENCODE + OBSERVED]
- Sources: `@opencode-ai/sdk` types (1.18.34); OpenCode source tag `v1.18.34`
  (`packages/opencode/src/session/llm/ai-sdk.ts`, `session/session.ts` getUsage);
  installed `opencode` binary strings.

---

## 8. CacheEngine Compatibility Matrix

Legend for "recommended family inheritance": **keep** = current treatment
matches docs; **extend** = docs support broadening scope (a future change, not
made here); **hold** = do not inherit without first-party evidence.

| Creator | Model / example pattern | Cache policy (documented) | CacheEngine current treatment | Recommended family inheritance | Recommended exact-model exception | Confidence | Source | Verified |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| OpenAI | `gpt-5.6`, `gpt-5.6-*` (sol/terra/luna/cyber) | "GPT-5.6 and later": implicit default, optional explicit breakpoints, min 1,024, TTL 30m, write 1.25×/read 0.1× | GPT policy: inject `promptCacheKey` + `promptCacheOptions{implicit,30m}` | keep | none documented; CacheEngine's subset is valid | High (docs) / Medium (treatment) | OpenAI *Prompt caching*; *GPT-5.6 Sol* | 2026-09-26 |
| OpenAI | GPT-6 / current later GPT family: `gpt-6`, `gpt-6-*` (astra/sol/luna) | Inherits the GPT-5.6-and-later policy | **GPT policy** via the GPT-5.6-and-later boundary (v0.4.2) | **keep** — covered by the boundary predicate; no exact-model entry needed | none documented | High (docs) / High (treatment) | OpenAI *Using GPT-6*; *GPT-6 Astra*; *Prompt caching* | 2026-09-27 |
| OpenAI | pre-5.6 negative controls: `gpt-5.5`, `gpt-5.4`, `gpt-5.2`, `gpt-5.1`, `gpt-5`, `gpt-4.1`, `gpt-4o` | Implicit only; different min-length class; `in_memory`/`24h` retention; `prompt_cache_key` for routing | neutral | **hold** — do not inherit 5.6 policy | n/a | High | OpenAI *Prompt caching*; *Pricing* | 2026-09-26 |
| DeepSeek | V4: `deepseek-v4-pro`, legacy `deepseek-v4-flash` | Provider-wide automatic disk cache; implicit; prefix-unit matching; hit/miss token fields | Passive (no mutation) | keep | none | High | DeepSeek *Context Caching*; *Models & Pricing* | 2026-09-26 |
| DeepSeek | V4.1 / current V4-family: `deepseek-flash` (MODEL VERSION "DeepSeek-V4.1-Flash") | Same provider-wide automatic policy; cache-hit pricing listed for both current models | Passive | keep (creator/family baseline) | none documented | High | DeepSeek *Models & Pricing*; *news260910* | 2026-09-26 |
| DeepSeek | future-looking V4+ identifiers: `deepseek-v4.1`, `deepseek-v4`, `deepseek-v5` | Not documented as request ids (`deepseek-v4.1`/`deepseek-v4` invalid or version-string only) | Passive via the V4-and-later family predicate or the safe creator fallback (v0.4.3); no mutation | keep passive; treat as unknown-friendly | none | Medium (detection) / Low (future ids) | DeepSeek *Models & Pricing*; *Chat Completions API* | 2026-09-27 |
| DeepSeek | pre-V4 negative controls: `deepseek-chat`, `deepseek-reasoner` | Retired names (retired 2026-07-24); no separate V4+ cache policy claimed | Passive | hold | n/a | High | DeepSeek *Change Log*; *news260424* | 2026-09-26 |
| Z.AI | GLM 5.3: `glm-5.3`, `glm-5.3-flash`, `glm-5.3-flashx` | Implicit automatic caching; `cached_tokens`; stable-prompt-first guidance; no documented min/TTL/key | GLM policy: `<env>` relocation; OpenRouter `x-session-id` | keep (env relocation is an exact overlay, not a Z.AI control) | env relocation is the overlay; keep scoped to GLM-5.3 | Medium | Z.AI *Context Caching*; *Chat Completion*; *Pricing* | 2026-09-26 |
| Z.AI | current later GLM generations (documented): none newer than 5.3; newest below is `glm-5.2`/`glm-5.1`/`glm-5`/`glm-4.7` | Same implicit mechanism documented service-wide; cached-input price per model | GLM-5.3 family baseline via the 5.3-and-later boundary; **no** `<env>` overlay (v0.4.4) | **baseline only** — overlay stays 5.3-explicit | none documented | High (no later gens documented) | Z.AI *New Released*; *Pricing* | 2026-09-27 |
| Z.AI | 5.2 and earlier negative controls: `glm-5.2`, `glm-5.1`, `glm-5`, `glm-4.7`, `glm-4.6`, `glm-4.5`, `glm-4-32b-*` | Cacheable (except `glm-4-32b-0414-128k`), different cached-input pricing; no cache-semantics difference documented | neutral | hold | n/a | High | Z.AI *Pricing*; *Chat Completion* (enum) | 2026-09-26 |
| Xiaomi | MiMo V2.6 Flash: `mimo-v2.6-flash` (OR `xiaomi/mimo-v2.6-flash`) | Provider-managed implicit caching; `cached_tokens`; no documented min/TTL/key/prefix rules | MiMo policy: `<env>` relocation; provider-change telemetry; OpenRouter `x-session-id` | keep scoped as exact-model overlay | env relocation unsupported by docs → treat as overlay | Medium | MiMo *Models*; *Pricing*; *openai-api* | 2026-09-26 |
| Xiaomi | MiMo V2.6 Pro: `mimo-v2.6-pro` (OR `xiaomi/mimo-v2.6-pro`) | Same documented per-model implicit caching; per-model pricing | MiMo policy (same as Flash) | keep | none documented | Medium | MiMo *Models*; *Pricing* | 2026-09-26 |
| Xiaomi | MiMo V2.6 Pro UltraSpeed: `mimo-v2.6-pro-ultraspeed` (OR `xiaomi/mimo-v2.6-pro-ultraspeed`) | Documented as a Pro **mode**, same V2.6 series; "Context Caching" listed; no documented mechanism difference from Pro | MiMo family baseline only (cached-token telemetry, provider-change/prefix diagnostics, OpenRouter affinity); **no** `<env>` overlay (v0.4.5) | family baseline; overlay stays Flash/Pro-explicit | none — baseline only | Medium | MiMo *news/latest/v2-6*; *Models*; *Pricing* | 2026-09-27 |
| Xiaomi | later MiMo generations: none documented beyond V2.6; V2.5 deprecates 2026-10-21 | Not documented; no inheritance rule | Passive family baseline for any future >V2.6 id (v0.4.5); no `<env>` overlay | keep passive, baseline only | none | High (no later gens documented) | MiMo *Models*; *updates/model* | 2026-09-27 |
| Xiaomi | V2.5 negative control: `mimo-v2.5`, `mimo-v2.5-pro` | Documented as deprecated 2026-10-21; cache capability listed; no V2.6 policy inheritance claimed | neutral | hold | n/a | High | MiMo *Models*; *news/latest/v2-6* | 2026-09-26 |
| Moonshot | Kimi current ids: `kimi-k3`, `kimi-k2.6`, `kimi-k2.7-code`, `kimi-k2.7-code-highspeed` (bare or gateway-prefixed) | OpenAI-compatible Chat/Responses: automatic implicit caching; optional `prompt_cache_options` write TTL (5m/1h, default 5m); Cache Write is k3-only; read/write usage fields | Passive Kimi policy (v0.5.0): no mutation, generic `read/(read+write)` accounting, no OpenRouter affinity | keep | none — passive only (no overlay) | High (docs) / Medium (treatment) | Moonshot *Best practices for context caching*; *api/chat* | 2026-10-04 |
| Moonshot | retired/renamed: `kimi-k2*`, `kimi-k2.5`, `moonshot-v1-*`, `kimi-thinking-preview`, `kimi-latest`, `kimi-for-coding`, `k3` | Deprecated or not first-party cache-documented; no Kimi policy claimed | neutral | hold | n/a | High | Moonshot *Models* (deprecations) | 2026-10-04 |
| Anthropic | Claude current ids: `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-4-5`, `claude-sonnet-4-5`, `claude-opus-4-8`/`4.7`/`4.6`, `claude-fable-5*`, `claude-mythos-5*`, older `claude-3-*` (bare or gateway-prefixed) | Messages API: explicit `cache_control` breakpoints (max 4; 5m default / 1h TTL); usage `cache_read_input_tokens`/`cache_creation_input_tokens`; per-model minimum prefix | Passive Claude policy (v0.5.2): no mutation — OpenCode already applies the breakpoints; generic `read/(read+write)` accounting | keep | none — passive only (OpenCode owns the breakpoints) | High (docs + OpenCode source) | Anthropic *Prompt caching*; OpenCode `provider/transform.ts` @ v1.18.34 | 2026-10-04 |
| Anthropic | look-alikes / unsupported: `claude-opus-clone`, `myclaude-opus-5`, `claude-2`, `claude-instant` | Not a current Claude Messages id | neutral | hold | n/a | High | Anthropic *Messages* (model enum) | 2026-10-04 |

---

## 9. Cases where documentation is insufficient to establish inheritance

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
   controls to Pro/Flash. v0.4.5 resolves this as a CacheEngine scope decision:
   UltraSpeed gets the family **baseline only** (no `<env>` overlay).
10. **MiMo on OpenRouter.** OpenRouter's Prompt Caching page documents no
    MiMo-specific cache section (only generic sticky routing), and every Xiaomi
    endpoint reports `supports_implicit_caching: false` while still listing
    cache-read pricing and while MiMo docs and live requests show cached tokens.
    The metadata's exact semantics are undefined → **UNKNOWN** (see §7).
11. **OpenAI Chat Completions usage-field naming.** Confirmed first-party: Chat
    uses `usage.prompt_tokens_details.cached_tokens`/`cache_write_tokens`;
    Responses uses `usage.input_tokens_details.*`. OpenCode normalizes both
    (see §7a).
12. **Moonshot/Kimi minimum cacheable prefix length.** Docs state only that the
    cache is stored in blocks; no numeric minimum is published → **UNKNOWN**.
13. **Moonshot/Kimi cache-key semantics.** `prompt_cache_key` (Chat/Responses)
    and `metadata.user_id` (Anthropic path) exist, but how they partition cache
    entries beyond "session affinity" is undocumented → **UNKNOWN**. CacheEngine
    sends neither (passive policy).
14. **Moonshot/Kimi Anthropic-compatible `cache_control` route.** Documented
    (top-level `cache_control`, `kimi-k3` only) but **not implemented** in
    v0.5.0: it is a separate request shape, and the task scope is the
    OpenAI-compatible path. A future release may add it with route-scoped tests.
15. **Anthropic per-model minimum cacheable length.** Documented by model family
    (512 / 1,024 / 2,048 / 4,096 tokens) but not exposed to the plugin, and the
    rendered prompt size is not observable here — so CacheEngine cannot enforce it.
16. **OpenRouter serialization of Anthropic cache markers.** Whether
    `providerOptions.openrouter.cacheControl` becomes Anthropic-style
    `cache_control` on the wire through OpenRouter is **UNVERIFIED**; the AI SDK
    turning top-level `options.cacheControl` into a literal `cache_control` is
    inferred from OpenCode's `usesAnthropicAutomaticCaching` gate.
17. **Anthropic automatic vs explicit breakpoints.** Both are documented;
    OpenCode 1.18.34 chooses explicit per-block breakpoints. CacheEngine does not
    override this, so the choice of automatic vs explicit for a given route is
    **OpenCode-owned**, not a CacheEngine policy.

## 10. What did not change (v0.4.0 baseline, historical)

- No runtime file, test file, configuration, provider config, detection regex,
  policy logic, telemetry field, or GPT context/output limit was modified.
- The existing test suite was run only to confirm the repository remains green
  (116/116).
- This release contains research and documentation only.

### Follow-up: v0.4.1 runtime integration

- v0.4.0 added the registry (`src/cache-policy-core.mjs`) without wiring it.
- v0.4.1 wired the runtime to `resolveRuntimePolicy()` and preserved behavior:
  every model supported in v0.3.6 keeps its prior treatment, and non-legacy or
  unknown models remain neutral.
- The v0.4.0 research statements above are unchanged; only the runtime now reads
  this registry as its single source of policy classification.

### Follow-up: v0.4.2 GPT-5.6-and-later boundary

- OpenAI's documented "GPT-5.6 and later" boundary was re-verified against the
  first-party *Prompt caching* guide and *Using GPT-6* guide on **2026-09-27**.
  GPT-6 (astra/sol/luna) is documented in the same cache regime with no
  cache-control exception.
- v0.4.2 replaces the exact `gpt-5.6` string match with a version-boundary
  predicate (`gpt-<major>[.<minor>] ≥ 5.6`), still gated on the OpenAI-ish
  provider check. GPT-6 and future 5.6+/6+/7+ models therefore need no
  exact-model registry entry, while `gpt-5.5` and earlier and malformed ids such
  as `gpt-5.60` stay neutral.
- The only OpenAI cache controls injected remain `promptCacheKey` +
  `promptCacheOptions{implicit,30m}`; no breakpoint or prewarm behavior was
  added. DeepSeek, GLM, MiMo, and OpenRouter affinity behavior are unchanged.

### Follow-up: v0.4.3 DeepSeek V4-and-later passive coverage

- DeepSeek first-party docs were re-verified on **2026-09-27**. Confirmed:
  context caching is provider-wide and passive — no `prompt_cache_key`, flag, or
  breakpoint exists, and Anthropic-style `cache_control` is documented as
  **ignored**. Only `user_id` is cache-relevant (KVCache isolation). Usage fields
  are `prompt_cache_hit_tokens`, `prompt_cache_miss_tokens`, and
  `prompt_tokens_details.cached_tokens`.
- Canonical request ids are `deepseek-flash` (= DeepSeek-V4.1-Flash) and
  `deepseek-v4-pro`; `deepseek-v4-flash`/`deepseek-v4-flash-vision-exp` are
  accepted retired aliases, and `deepseek-chat`/`deepseek-reasoner` are
  discontinued. First-party docs publish **no** generational naming rule, and the
  V4.1 codename id `deepseek-flash` carries no version token.
- v0.4.3 adds a passive `deepseek.v4-plus` family entry: canonical ids match by
  exact id, `deepseek-v<major≥4>` version tokens match by predicate, and
  pre-V4 / retired / unknown future `*deepseek*` ids fall through to the passive
  creator baseline. No cache-control field, cache key, prompt rewrite, or
  OpenRouter affinity is introduced for DeepSeek.
- Evidence caveat: first-party pages conflict on whether `deepseek-v4-pro` still
  routes as a distinct model in late 2026; this does not affect the passive
  policy, which carries no mutation either way.

### Follow-up: v0.4.4 GLM-5.3-and-later baseline vs GLM-5.3 overlay

- Z.AI docs were re-verified on **2026-09-27**. GLM-5.3 is the newest documented
  text generation (no `glm-5.4`/`glm-6`); GLM-5.3 is explicitly "the same base
  model as GLM-5.2" with post-training differences. Caching is implicit with no
  `cache_control`/`prompt_cache_key`/breakpoint/TTL field; `cached_tokens` is the
  reported field. Z.AI publishes **no** generational-inheritance rule.
- The `<env>` relocation has **no first-party basis** — it is a CacheEngine
  implementation overlay. v0.4.4 therefore separates the concepts:
  - **Family baseline** (`zai.glm-5.3-plus`, predicate `glm >= 5.3`): implicit
    caching plus the non-mutating GLM diagnostics/transport (thinking-integrity
    telemetry, GLM cache ratio, provider-change telemetry, OpenRouter
    `x-session-id`). No prompt rewrite.
  - **GLM-5.3 overlay**: the `<env>` relocation stays registered only on the
    GLM-5.3 family entry, so a later GLM does **not** inherit it.
- GLM-5.2 and earlier remain neutral. No new GLM cache-control field is added,
  and GLM-5.3 behavior is unchanged.
- Evidence caveat: because no later GLM generation is documented, the
  "GLM-5.3 and later" boundary is a CacheEngine inference about a passive
  baseline, not a Z.AI contract; it is safe because it introduces no mutation.

### Follow-up: v0.4.5 MiMo V2.6+ baseline vs the validated MiMo overlay

- Xiaomi MiMo docs were re-verified on **2026-09-27**. The V2.6 series is Pro +
  Flash, with UltraSpeed documented as a Pro **mode** exposed as
  `mimo-v2.6-pro-ultraspeed`. No generation newer than V2.6 is documented, and
  no generational-inheritance rule is published. Caching is provider-managed
  implicit with no cache-control field in any compat schema; usage fields are
  per-protocol `cached_tokens`/`cache_read_input_tokens`. V2.5 deprecates
  2026-10-21.
- The `<env>` relocation has **no first-party basis** — it is a CacheEngine
  overlay. v0.4.5 therefore separates:
  - **Family baseline** (documented V2.6 Flash/Pro, the UltraSpeed mode entry,
    and any future >V2.6 id via `isMimoAfterV26`): cached-token telemetry,
    provider-change/prefix diagnostics, OpenRouter `x-session-id`. No prompt
    rewrite.
  - **Validated overlay**: the `<env>` relocation stays registered only on the
    V2.6 Flash/Pro entry.
- UltraSpeed moves from neutral to the family baseline (no overlay). V2.5 and
  earlier stay neutral; undocumented V2.6 variants such as `mimo-v2.6-flashx`
  also stay neutral (narrow detection preserved).
- No MiMo cache-control field is invented. Evidence caveat: since no >V2.6
  generation is documented, future coverage is a CacheEngine inference about a
  passive baseline (safe: no mutation), not a Xiaomi contract.

### Follow-up: v0.4.9 verification and OpenRouter GPT serialization fix (2026-10-02)

The verification work below is documentation-only and changed no runtime
behavior. The same release also includes one transport fix, recorded at the end
of this section.

- **P-D — OpenRouter affinity is best-effort** (was implicitly treated as
  reliable). First-party docs state sticky routing falls back to the next-best
  provider when the sticky provider is unavailable, and does not update the cache
  on a provider error; nothing guarantees the same upstream for the session
  lifetime. `provider.order` disables stickiness. CacheEngine's `x-session-id`
  use is classified **best-effort** (supported mechanism, no continuity
  guarantee). No code change.
- **P-H — MiMo `supports_implicit_caching` contradiction remains UNKNOWN.**
  All `xiaomi/mimo-v2.6-*` endpoints report `false` while listing cache-read
  pricing; MiMo docs document context caching and `cached_tokens`; live requests
  returned cached tokens. OpenRouter does not define the flag's semantics and
  omits Xiaomi from its caching-provider list. Documented as contradictory, not
  resolved. No MiMo behavior change.
- **P-G — OpenCode normalizes cache-token fields.** OpenCode V1 (1.18.34) maps
  OpenAI Chat/Responses, Anthropic, and DeepSeek cache-usage fields into
  `Message.info.tokens.cache.{read,write}` (see §7a). CacheEngine reads only the
  normalized fields, so **no provider-specific parsing is required** and no v0.5.x
  mapping change is specified. `tokens.input` is non-cached input; DeepSeek
  `cache.write` is 0.
- **OpenRouter GPT prompt-cache serialization (fix).** OpenCode wraps the plugin
  `chat.params` options under the provider SDK key, and
  `@openrouter/ai-sdk-provider` forwards `providerOptions.openrouter` **verbatim**
  into the request body (it does not translate camelCase). A captured request
  body confirmed OpenRouter received `promptCacheKey` / `promptCacheOptions`,
  which it ignores. The fix emits the snake_case wire names
  `prompt_cache_key` / `prompt_cache_options` for OpenRouter only; direct
  OpenAI/Azure keep the camelCase options that their SDK serializes correctly.
  Verified against `@openrouter/ai-sdk-provider@2.9.0`, `@ai-sdk/openai@3.0.88`,
  `@ai-sdk/azure@3.0.93`, `ai@6.0.168`.

### Follow-up: v0.4.10 `<env>` relocation validation (2026-10-02)

- **Correctness (FACT).** `relocateVolatileEnvBlock` preserves all text and the
  env-block bytes, is deterministic and idempotent, and now requires exactly one
  `START`/`<env>`/`</env>` marker in order. Ambiguous, multiple-marker, missing,
  and malformed cases are left byte-identical. It is applied only for the
  validated `zai.glm-5.3` and `xiaomi.mimo-v2.6` entries (the `*-plus` baseline
  entries have no `envRelocation`) and only when the single system element is
  eligible.
- **Cache benefit (UNVERIFIED).** A controlled A/B through OpenRouter (ordinary
  short prompts ~6.3K; env block early vs relocated to the tail; a date change
  between a warm and a test request) did **not** show a position-dependent cache
  benefit. GLM cached ~6.2K regardless of layout (tail −880 vs early, i.e.
  noise/negative) and the identical-repeat control varied by ~750 tokens; MiMo
  reported the same cached count either way. Upstream implicit-cache semantics
  cannot be controlled from the plugin, and OpenRouter routing is best-effort, so
  the relocation's cache improvement is **not established**. Provider-reported
  usage remains authoritative.
- No policy-scope change was made; the only runtime change is the
  unambiguous-only guard (a defect fix, covered by regression tests).

### Follow-up: v0.4.11 GPT key ownership and compaction isolation (2026-10-02)

Key ownership by transport and configuration (OpenCode pre-sets
`promptCacheKey = sessionID` for direct OpenAI/Azure via its provider `options()`,
and sets nothing for OpenRouter):

| Transport | Live, `cacheRootKey: false` (default) | Live, `cacheRootKey: true` | Compaction, `compactionCacheIsolation: true` |
| --- | --- | --- | --- |
| OpenAI / Azure (camelCase) | preserve OpenCode's key | override with resolved-root key | override with `<base>:compact` |
| OpenRouter (snake_case) | set session-derived key | set resolved-root key | set `<base>:compact` |

**Defect (fixed).** The compaction-isolation key was written only when cache-root
affinity was enabled (`applyRoot`). Under the default (`cacheRootKey: false`),
a direct OpenAI/Azure compaction request kept OpenCode's pre-set live key and
therefore **shared the live-session namespace**, silently disabling
`compactionCacheIsolation`. Fix: write the desired key when `applyRoot || isolated`,
so isolation is enforced over a pre-set key. Live requests under the default still
preserve an existing key. Regression: `v0.4.11` tests (existing/no key, root mode
on/off, compaction override, repeated requests, separate sessions, transport field
names). A prompt-cache key provides namespace stability/isolation, not a
guaranteed cache hit.
