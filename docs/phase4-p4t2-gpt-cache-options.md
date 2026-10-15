# Phase 4 — P4-T2: GPT cache-option wire verification

**Task:** P4-T2 (`TODO.md`) — verify the GPT cache options through the full chain:
**adapter assignment → OpenCode schema → provider serialization → intended route →
provider-supported semantics → measured outcome.** Do not report "enabled" solely because a
property was assigned.
**Type:** research + wire (offline/mock). No real provider contacted.
**Depends on:** P4-T1 (policy inventory).
**Evidence basis:** OpenCode 2.0.26; the offline capture harness; a direct V2-hook probe; the
tracked stores (`RF-OC-030`, `RF-OC-031`).

Evidence labels: *Structurally verified* / *Offline-wire verified* / *Documented* / *Unknown*.
**Provider measured: not performed.**

## Objective / target field set

The GPT-5.6 policy (`gpt56`, inventory row **A1**) assigns, for OpenAI/Azure-compatible
GPT-5.6+ models: `promptCacheKey` (only when absent) and `promptCacheOptions`
(`{ mode: implicit|explicit, ttl: 30m }`, only when absent). Field names are camelCase for
non-OpenRouter, snake_case (`prompt_cache_key` / `prompt_cache_options`) for OpenRouter.

## Chain verification (each link, with evidence)

| Link | Result | Evidence |
|---|---|---|
| **1. Adapter assignment** | ✅ **Verified.** Direct V2-hook probe (`model gpt-5.6-sol/providerID openai`): empty `options` → `{promptCacheKey:"ses_a", promptCacheOptions:{mode:"implicit",ttl:"30m"}}`; pre-existing key → key **preserved** + options added; **no `options` object → no-op**; non-GPT model → `{}` (nothing). | offline probe (this report) |
| **2. OpenCode schema** | **Route-dependent.** `openai-compatible` decodes provider options through schema `A = {user, reasoningEffort, textVerbosity, strictJsonSchema}` → **strips** all four cache fields. The OpenAI/Responses schema accepts `promptCacheKey` (camel) only; **no** located schema accepts `promptCacheOptions`. | `RF-OC-030` (source) |
| **3. Provider serialization** | `promptCacheKey` → wire `prompt_cache_key` (when the schema accepts it); `promptCacheOptions` → **no schema** → not serialized. | `RF-OC-030`; wire capture below |
| **4. Intended route** | GPT-5.6+ resolves only when `isOpenAIish` (providerID `openai`/`azure`, slug `openai/…`, or npm `@ai-sdk/openai`/`@ai-sdk/azure`). Offline this is triggerable with `npm: "@ai-sdk/openai"` (route used: **`/v1/responses`**). | this report |
| **5. Measured outcome** | **Not attributable.** On the OpenAI/Responses route, `prompt_cache_key` is present **with and without** the adapter — valued as OpenCode's **session-derived** key (`ses_…`) — and `prompt_cache_options` is **absent in both**. | wire capture below |

### Wire capture (offline, discriminating OFF/ON)

With `npm: "@ai-sdk/openai"` → loopback mock, model `gpt-5.6-sol`:

| Case | `prompt_cache_key` | `prompt_cache_options` |
|---|---|---|
| adapter **OFF** | `ses_ec03d253…` (session-derived) | **absent** |
| adapter **ON** | `ses_ec03d1ff…` (session-derived) | **absent** |

The key value is OpenCode's per-session value (it differs only because OFF/ON are different
sessions); it is **present regardless of the adapter**. The adapter's distinct field
(`promptCacheOptions`) never appears on the wire.

## Verdict

**The GPT-5.6 cache-option policy is NOT wire-attributed on the tested live route.** Its
request mutation has **no observable wire effect**:
- `promptCacheKey`: OpenCode pre-populates the key on the OpenAI/Azure route (`RF-OC-031`),
  and the adapter deliberately **preserves** it on **live** requests (write only when
  absent; with `cacheRootKey` default `false` the desired value equals the session id
  anyway). **V1 exception:** on a **compaction** request with `compactionCacheIsolation` on
  (default), V1 **overwrites** the key with `<root>:compact` — a V1-only branch (V2 has
  none), not exercised offline.
- `promptCacheOptions`: **no inspected schema carries it** — dropped on both the
  openai-compatible and the OpenAI/Responses routes.

**Gate 4 remains NOT PASS** (attribution unresolved). **No adapter defect is claimed.**

## Residual / next

- The **only** potential attributable GPT mutation is V1 **compaction isolation**: for a
  compaction request with `compactionCacheIsolation` on, V1 **overwrites** the key with
  `<root>:compact` (an *attributable* change); V2 has **no** compaction branch and always
  preserves. Not exercised offline (a separate agent kind). Candidate for a future,
  separately-authorized experiment; it does not change the live-route verdict.
- A genuinely discriminating measurement still requires a route where OpenCode does **not**
  pre-populate `promptCacheKey` **and** a provider-options schema that accepts
  `promptCacheOptions` (none found) — see `RF-OC-031`.

## Recommendation

Record the policy as **not wire-effective on tested live routes**; keep it as-is (it is
harmless and preserves rather than overwrites), and state the attribution status honestly in
the inventory. `promptCacheOptions` is **unsupported** on the inspected routes.

## Integrity

No managed config/service touched; disposable temp HOME/project + loopback mock. No
credentials, prompt content, or full bodies recorded or committed.
