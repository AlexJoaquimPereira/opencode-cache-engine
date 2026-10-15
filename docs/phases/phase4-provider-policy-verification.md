# Phase 4 — provider-policy and transport verification (P4-T1 … P4-T5)

Consolidated Phase 4 record: policy inventory (T1), GPT cache-option wire verification (T2),
OpenRouter affinity verification (T3), route-specific test scaffolding (T4), and the acceptance
decision (T5).

---

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
| A1 | **GPT-5.6+ cache metadata** (`gpt56`) | **transport-specific** (**not wire-effective** on tested routes) | V1 `chat.params` / V2 `context` (`options`) | add **missing** `promptCacheKey` + `promptCacheOptions` (default `implicit`, `30m`) on **live** requests (preserve an existing key); **on a V1 compaction request with `compactionCacheIsolation` on (default) it overwrites the key with `<root>:compact`** (V1-only; V2 has no such branch) | OpenAI/Azure-compatible (`requiresOpenAIish`); GPT-5.6-and-later boundary | no-op if `options` absent/malformed | `policies.gpt56.enabled=false` (**full**); `policies.gpt56.promptCacheKey=false` (**key only** — `promptCacheOptions` is still injected) |
| A2 | **GLM-5.3 `<env>` relocation** (`glm53`) | **structural** | `experimental.chat.system.transform` | relocate the identifiable `<env>` block to the system tail (content-preserving) | GLM-5.3 family (overlay **not** inherited by `glm-5.3-plus`) | exactly one eligible text part, else **no-op**; `<env>` marker guard intact | `policies.glm53.enabled/stabilizeSystem=false` |
| A3 | **GLM-5.3 daily-date relocation** (`glm53`) | **experimental** (default **off**) | same system transform | relocate the standalone `Today's date: …` line to the system tail | GLM-5.3 | missing/duplicate/malformed/ambiguous ⇒ **no-op**; never pins the date | `policies.glm53.stabilizeDate=false` (default) |
| A4 | **MiMo `<env>` relocation** (`mimo26`) | **structural** | system transform | as A2 | MiMo-V2.6 Flash/Pro (overlay **not** inherited by `-plus`/Ultraspeed) | as A2 | `policies.mimo26.enabled/stabilizeSystem=false` |
| A5 | **MiMo daily-date relocation** (`mimo26`) | **experimental** (default **off**) | system transform | as A3 | MiMo-V2.6 | as A3 | `policies.mimo26.stabilizeDate=false` |
| A6 | **OpenRouter session affinity** (GLM-5.3 + MiMo-V2.6) | **transport-specific** | V1 `chat.headers` / V2 `model.request` | add deterministic `x-session-id` **only** when the actual `providerID` is exactly `openrouter`; preserves a case-insensitive pre-existing header | OpenRouter transport only — **not wire-effective** (harness-owned; `RF-OC-048`) | not `openrouter` ⇒ never add; header present ⇒ preserve | inherent (only fires for those families + `openrouter`); `mimo26.stickySession` gates only the telemetry id, not injection |

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
6. **V2 field-name npm branch is dead code:** V2 calls
   `gptCacheOptionFieldNames({ providerID, npm: undefined })`, so the npm-based snake_case
   branch is V1-only; V2 selects snake_case only via `providerID === "openrouter"`. Latent —
   no evidenced route differs (no change made).
7. **`PASSIVE_FAMILIES` means "zero mutation capabilities".** The `glm-5.3-plus` /
   `mimo-v2.6-plus` / `mimo-v2.6-pro-ultraspeed` entries share the `glm53` / `mimo26` family
   names and carry `openRouterAffinity` but **no** `envRelocation`; they are correctly absent
   from the passive list, and P4-T4 test 2 does not iterate them.

---

**Method note:** this inventory is read from the shipped code + the tracked stores; it does
not re-derive provider behavior (that is P4-T2/P4-T3). No managed config was touched.


---

## P4-T2 — GPT cache-option wire verification

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


---

## P4-T3 — OpenRouter affinity verification

# Phase 4 — P4-T3: OpenRouter affinity verification

**Task:** P4-T3 (`TODO.md`) — verify the OpenRouter session-affinity policy: route
eligibility, header precedence, user-header preservation, serialized attachment, and route
semantics (plan §8).
**Type:** research + wire (offline/mock). No real provider contacted.
**Depends on:** P4-T1 (policy inventory).
**Evidence basis:** OpenCode 2.0.26; the offline capture harness; the V2 adapter telemetry;
the existing V2 `model.request` unit test.

Evidence labels: *Structurally verified* / *Offline-wire verified* / *Telemetry-verified*.
**Provider measured: not performed.**

## What the policy does (inventory row A6)

For the GLM-5.3 / MiMo-V2.6 families with `providerID === "openrouter"`, the adapter adds a
deterministic `x-session-id` (V1 `chat.headers`; V2 `model.request`), **only when no
`x-session-id` is already present** (case-insensitive), and never for direct/unknown
providers. The derived value is `mimo-ses-<shorthash(sessionID)>` (`mimoSessionIdFor`).

## Findings (each requested aspect)

| Aspect | Result | Evidence |
|---|---|---|
| **Eligibility** | ✅ **Verified (logic).** The hook fires and classifies OpenRouter GLM as eligible; non-eligible cases do not inject. | V2 `model.request` unit test; telemetry below |
| **Header precedence / user-header preservation** | ✅ **Verified.** With a pre-existing `x-session-id` the adapter **preserves** it: telemetry `headerPresent:true, headerAttached:false, headerSource:"preexisting"`. | telemetry record (below) |
| **Serialized attachment** | ✅ **The header IS on the wire** — but it is **OpenCode's** value (`x-session-id: ses_…`), not the adapter's (`mimo-ses-…`). | wire capture |
| **Attribution to the adapter** | ❌ **Not attributable.** The wire header is present **with the adapter disabled** and on a **neutral** model — so OpenCode sets it natively; the adapter never attaches its own value. | OFF control + neutral-route capture |
| **Route semantics (does reuse improve?)** | **Not measurable offline**, and moot while the adapter is not the header setter. | — |

### Telemetry (adapter ON, `openrouter/glm-5.3-flash`)

```json
{"kind":"boundary","policy":"glm53","model":"glm-5.3-flash","reason":"openrouter_affinity_eligible",
 "eligible":true,"providerIdentityKnown":true,"provider":"openrouter",
 "headerPresent":true,"headerAttached":false,"headerSource":"preexisting"}
```

The hook ran, judged the route eligible, saw an existing header, and **did not attach** one.

### Wire evidence (offline, `@ai-sdk/openai-compatible` → loopback mock)

| Case | adapter | model | `x-session-id` on the wire |
|---|---|---|---|
| A | ON | `openrouter/glm-5.3-flash` | `ses_ec0371…` (session id) |
| E | **OFF** (`enabled:false`) | `openrouter/glm-5.3-flash` | `ses_ec0371…` (session id) |
| — | OFF/neutral | `mock/synthetic` | `ses_…` (session id) |

`x-session-id` is present in **all** cases → it is **OpenCode's**, not the adapter's. (The
adapter's own value shape `mimo-ses-…` was **never** observed.)

## Verdict

**The OpenRouter affinity header is NOT wire-attributable on the tested route.** On the
**tested openai-compatible route** (offline capture only; **no source confirmation**),
`x-session-id = <sessionID>` is set by the **harness**, not the adapter, so the adapter's
eligibility-gated injection has **no observable wire effect** (it preserves the pre-existing
header and stays silent). **No adapter defect is claimed** — the logic is correct; the
harness simply provides the header itself. Scope: the V1 `chat.headers` path was **not**
wire-captured (logic only).

> This mirrors P4-T2: on the routes we can test, **OpenCode's harness already supplies the
> session affinity** (the GPT `prompt_cache_key` and the OpenRouter `x-session-id`). The
> CacheEngine overlay is redundant on the wire there.

## Residual / next

- Whether a route exists where OpenCode does **not** set `x-session-id` (so the adapter's
  injection would be attributable) is **unknown**; on the tested offline route it is present.
- The V1 `chat.headers` path is unit-tested but was not wire-captured here (the harness loads
  the V2 adapter).
- Route semantics (whether affinity reuse improves hits) requires a provider experiment and
  is moot while the adapter is not the setter.

## Recommendation

Record the affinity policy as **not wire-effective on the tested route**; keep it as-is
(preserves rather than overwrites; harmless). Note the OpenCode-native `x-session-id` as the
route's actual affinity source (new finding, `RF-OC-048`).

## Integrity

No managed config/service touched; disposable temp HOME/project + loopback mock. No
credentials, prompt content, or full bodies recorded or committed.


---

## P4-T4 — route-specific policy test scaffolding

# Phase 4 — P4-T4: route-specific policy test scaffolding

**Task:** P4-T4 (`TODO.md`) — add route-specific tests for the policies, encoding the
"stripped/unsupported field ≠ wire success" discipline so the P4-T2/P4-T3 results cannot
silently regress (plan §8 acceptance).
**Type:** implementation (offline tests). No request mutated; no provider contacted.
**Depends on:** P4-T2, P4-T3.
**Baseline inputs:** P4-T1 inventory; P4-T2/P4-T3 reports; `RF-OC-030/031/047/048`;
`test/cache-engine.test.mjs`; the V1/V2 hook surface.

## Added

- **`test/fixtures/policy-routes.mjs`** — a data table of every **mutation-bearing** policy:
  hooks, classes, route-conditioned **field names**, the value it **preserves**, its
  **disable path**, and per-route **wire disposition** (`structural` / `stripped` /
  `harness-owned` / `unsupported`) with the evidence ID. Also the **passive-family** list and
  the capability keys that would signal a mutation regression.
- **Three tests** in `test/cache-engine.test.mjs` (run by `npm test`):
  1. **Route-correct GPT field names** — camelCase for `openai`/`azure`/other; snake_case for
     `openrouter` (including via the OpenRouter SDK npm).
  2. **Dispositions + passivity** — every mutation policy declares a disable path and
     route+evidence; each passive family resolves to a policy with **no** mutation
     capability (`gptCacheMetadata`/`envRelocation`/`openRouterAffinity` all falsy); an
     unknown provider fails closed (`isNeutral`).
  3. **V2 hook behavior (assignment ≠ wire)** — a hook probe asserting: GPT adds the key only
     when absent, **preserves** a pre-existing `promptCacheKey`, and **no-ops** without an
     `options` object; affinity attaches `mimo-ses-…` only when absent, **preserves** a
     user-supplied `x-session-id`, and does **nothing** for a non-`openrouter` provider or a
     non-affinity family; a passive family mutates nothing.

## Coverage vs plan §8 acceptance

| Acceptance clause | Covered by |
|---|---|
| Every active policy has route-specific tests | fixture rows + tests 1–3 |
| **Stripped/unsupported fields are not reported as wire success** | fixture `wire` dispositions (`stripped`/`harness-owned`/`unsupported`) + the assignment-only assertions (no test claims wire success) |
| Passive policies remain passive | test 2 (no mutation capability per family) + test 3 (passive mutation-free) |
| Identity and prefix stability remain distinct | the P4-T4 test asserts every mutation policy documents a non-empty `preserves` value, separately from policy matching |
| No promotion on attempted mutation alone | the fixture records disposition per route; the tests pin **preservation**, not injection, on the tested routes |

## Not covered (documented, not silently assumed)

- **Runtime wire lanes** for these routes would require the provider SDKs + a
  Responses-capable mock; the wire facts live in `RF-OC-047`/`RF-OC-048` and the P4-T2/P4-T3
  reports, not in an automated lane. The unit tests pin the **adapter** side (assignment,
  preservation, no-op) which is what can regress locally.
- **Provider-supported semantics / measured outcome** (does the cache actually hit) is out of
  scope offline.
- The V1 `chat.headers`/`chat.params` paths are covered **at the logic level only** (pure
  helpers + existing V1 tests); the new hook probe drives the **V2** adapter, and there is
  no V1 wire capture.

## Result

`npm test` → **373/0 at time of writing** (3 new tests). No runtime source changed. The route-specific
dispositions and the negative (not-wire-effective) results are now pinned in-repo.

## Integrity

No managed config/service touched; the hook probe uses a disposable temp `HOME`. No
credentials, prompt content, or full bodies recorded or committed.


---

## P4-T5 — acceptance decision

# Phase 4 — P4-T5: acceptance decision (provider-policy and transport verification)

**Task:** P4-T5 (`TODO.md`) — apply the plan §8 acceptance criteria, record a per-policy /
route disposition, and state the Phase-4 outcome.
**Type:** gate (research/decision) — read-only. No request mutated; no provider contacted.
**Depends on:** P4-T2, P4-T3, P4-T4.
**Evidence:** P4-T1 inventory; P4-T2/P4-T3 wire verdicts; P4-T4 tests;
`RF-OC-030/031/047/048`.

## Acceptance criteria (plan §8) — checked

| Criterion | Result | Basis |
|---|---|---|
| Every **active** policy has **route-specific tests** | **MET** | P4-T4 fixture rows + 3 tests; per-policy/route dispositions pinned |
| **Stripped / unsupported** fields are **not** reported as wire success | **MET** | the fixture records `stripped`/`harness-owned`/`unsupported` per route; tests assert **preservation/no-op**, never a wire-success claim |
| **Passive** policies remain passive | **MET** | P4-T4 test 2 (no mutation capability per passive family) + test 3 (mutation-free) |
| **Identity** and **prefix stability** remain distinct | **MET** | the P4-T4 test asserts every mutation policy documents a non-empty `preserves` value, separately from policy matching |
| No policy **promoted** on attempted mutation alone | **MET** | **no promotion** (see below); two overlays explicitly recorded as **not wire-effective** |

## Per-policy disposition (Phase-4 outcome)

### Mutation-bearing

| Policy | Route(s) tested | Wire disposition | Verdict |
|---|---|---|---|
| **GPT-5.6 cache options** (`gpt56`) | `openai-compatible` | **stripped** (`RF-OC-030`) | **not wire-effective** |
| | `openai`/`azure` (Responses) | key **harness-owned**; options **unsupported** (`RF-OC-047`) | **not wire-effective** |
| | `openrouter` (`openai/*` slug) | options **unknown** (no inspected schema; not directly inspected); key harness-owned | **not wire-effective** |
| **GLM-5.3 `<env>` relocation** | `zai.glm-5.3` | **structural** (content-preserving) | unchanged (shipped) |
| **GLM-5.3 date relocation** | `zai.glm-5.3` | **structural**, **experimental (default off)** | unchanged (Phase 2) |
| **MiMo `<env>` relocation** | `xiaomi.mimo-v2.6` | **structural** | unchanged (shipped) |
| **MiMo date relocation** | `xiaomi.mimo-v2.6` | **structural**, **experimental (default off)** | unchanged (Phase 2) |
| **OpenRouter affinity** (`x-session-id`) | `openrouter` + GLM-5.3/MiMo-V2.6 | **harness-owned** — on the tested openai-compatible route (capture-only) the harness sets the header; adapter preserves (`RF-OC-048`) | **not wire-effective** |

### Passive (classification + accounting only)

`deepseek`, `kimi`, `claude`, `gemini`, `qwen`, `grok`, `muse`, `minimax`, and neutral/unknown
— **all remain passive** (no mutation capability; P4-T4 test 2).

## Promotion decision

**NONE.** No policy is newly enabled or promoted. Phase 4 made **no runtime code change**:
its outcome is that two *transport-specific* overlays (GPT cache options, OpenRouter affinity)
are **not wire-effective on the tested routes** — the harness already provides the session
affinity there (the GPT `prompt_cache_key` and the OpenRouter `x-session-id`, both
capture-observed), and the
provider-options schemas do not carry the adapter's fields. Per plan §8, "enabled" is **not**
claimed from assignment.

## Residual / backlog (authorization-gated; not Phase-4 work)

1. **A1/A6 attribution** needs a route where OpenCode does **not** pre-set the key/header, or
   a provider-options schema that accepts `prompt_cache_options` (**none found**).
2. **V1 compaction isolation** (`compactionCacheIsolation`, `<root>:compact`) is the only
   potentially *attributable* GPT mutation — a separate agent kind, **not exercised**, and
   **not implemented in the V2 adapter**. Candidate experiment (needs authorization).
3. **Provider-measured semantics** (does the cache actually hit) is out of scope offline.
4. **Optional cleanup (code change → its own case):** the `promptCacheOptions` injection is
   dead on every inspected route; dropping it would remove an ineffective mutation. Not done
   here (authorization + a safety case).

## Outcome

Phase 4 is a **verification-only** phase: policies are route-aware and independently tested;
the honest disposition of every policy is recorded; nothing ships or changes at runtime. The
Phase-2 capabilities (`stabilizeSystem`; `stabilizeDate`, off) are unchanged.

## Integrity

No managed config/service touched; disposable temp HOME/project + loopback mock. No
credentials, prompt content, or full bodies recorded or committed.
