# Phase 5 — usage accounting and telemetry (P5-T1 …)

Consolidated Phase 5 record (grows per task).

---

## P5-T1 — metric-definition catalogue


**Task:** P5-T1 (`TODO.md`) — define the **source and meaning of every telemetry record kind
and field** (V1 + V2), so later Phase-5 tasks can separate layers, test failure modes, and keep
accounting claims honest.
**Type:** research — read-only; offline. No request mutated; no provider contacted.
**Baseline inputs:** plan §9; `src/cache-usage-core.mjs`; `src/cache-engine-core.mjs`
(`createRecorder`, ratio helpers, `volatilityTransition`, ID helpers, `affinityTelemetryFields`);
the V1 (`src/cache-engine.ts`) and V2 (`src/cache-engine-v2.mjs`) emitters.
**Evidence:** extracted from source and verified against the emitters. `[O]` structurally
verified. **Provider measured: not performed.**

Writer: `createRecorder(metricsFile)` (`cache-engine-core.mjs:224`) appends
`JSON.stringify(line)+"\n"`; a write failure is **swallowed** (best-effort — see §6).

## 1. Record kinds

| kind | V1 | V2 | Trigger | One-line meaning |
|---|---|---|---|---|
| `usage` | ✅ `:542` | ✅ `:464` | `session.idle` (V1); `session.usage.updated` / `session.idle` (V2) | Aggregated cache-token accounting for a scan sample |
| `boundary` | ✅ ×10 | ✅ ×3 | `chat.headers` / `chat.params` / `system.transform` / `model.request` | A policy/observation **event** (many `reason`s — see §3) |
| `cache-options` | ✅ `:985` | ✅ `:349` | `chat.params` (V1) / `context` (V2) | GPT cache-metadata injection record |
| `compaction` | ✅ `:1044` | ❌ | `session.compacted` | Compaction bookkeeping (totals + cache root) |
| `policy-resolution` | ✅ `:350` | ❌ | `chat.params` | Why a model resolved to its policy |
| `reasoning-integrity` | ✅ `:509` | ❌ | `session.idle` | GLM reasoning-replay anomaly |
| `prefix-observation` | ✅ `:1221` | ❌ | `system.transform` | First prefix-shape baseline for a session |
| `prefix-change` | ✅ `:1257` | ❌ | `system.transform` | The prefix shape changed |
| `telemetry-error` | ✅ ×11 | ✅ ×4 | any hook catch | A swallowed telemetry/excursion error |

## 2. `usage` — fields and sources

| field | Source | Meaning | Presence |
|---|---|---|---|
| `sid` | session id | session identifier | always |
| `ts` | `Date.now()` | emit time | always |
| `read` | **provider usage** `tokens.cache.read` | cache-read tokens in this sample | always |
| `write` | **provider usage** `tokens.cache.write` | cache-write tokens in this sample | always |
| `input` | **provider usage** `tokens.input` | non-cached prompt input tokens | always |
| `messages` | local scan | assistant messages aggregated | always |
| `sampleHitRate` | `hitRatePct(read, write)` | **generic** ratio for this sample | always |
| `cumulative` | session state | running `{read, write}` (**no `input`**) | always |
| `cumulativeHitRate` | `hitRatePct(s.read, s.write)` | **generic** running ratio | always |
| `cursor` | local | newest processed message id | always |
| `provider` | scanned/observed/latched | provider id | V1 opt |
| `model` | scanned/observed/latched | model id | V1 opt |
| `policy` | resolved family | family name | V1 opt; V2 opt |
| `promptTokens` | **derived** | GLM `read+write+input`; MiMo `read+input` (⚠ same name, two formulas) | per `cacheRatio` |
| `glmHitRate` | `glmHitRatio` | GLM `read/(read+write+input)` | GLM only |
| `cachedTokens` | `read` | MiMo cached prompt tokens | MiMo only |
| `cacheHitRate` | `mimoHitRate` | MiMo `cachedTokens/read+input` | MiMo only |
| `stickySessionId` | `mimoSessionIdFor(sid)` | derived affinity id (telemetry only) | V1 MiMo + `stickySession` |
| `keyStrategy` | config | `cache-root` \| `session` | V1 GPT + injected |
| `mode` / `ttl` | config | GPT cache mode/TTL | V1 GPT + injected |
| `tokenSource` | constant | `"provider"` — `read`/`write`/`input` are provider-reported; the `*HitRate`/`promptTokens` fields are **derived** | always (V1+V2, P5-T2) |

## 3. `boundary` — reasons (the field sets are **heterogeneous**)

| reason | Adapter | Key fields | Layer |
|---|---|---|---|
| *(none — affinity)* | V1 `chat.headers`, V2 `model.request` | `policy, model, provider, reason, eligible, providerIdentityKnown, headerPresent, headerAttached, headerSource` (via `affinityTelemetryFields`) | decision + applied |
| `system_volatility` | V1, V2 | `severity:"high", rules` (+ V1 `provider,model,policy`) | observation |
| `system_date_relocated` | V1, V2 | `policy, provider, model` | applied |
| `mimo_system_env_relocated` | V1 | `policy, provider, model` | applied |
| `mimo_system_prefix_changed` | V1 | `policy, provider, model, changedFields, reasons` | observation |
| `grok_affinity` | V1 | `policy, provider, model, affinitySource, note` | observation |
| `muse_affinity` | V1 | `…, affinitySource, retentionSource, note` | observation |
| `minimax_route` | V1 | `…, route, harnessAnthropicCaching, modelWriteBilledCapable, cacheWriteBilled, note` | observation |
| `mimo_provider_changed` / `glm_provider_changed` | V1 | `policy, from, to, note` (+ `stickySessionId` opt) | observation |
| `gpt_reasoning_effort_changed` | V1 | `provider, model, policy, cacheRoot, cacheRootSource, before, after` | observation |
| `gpt_session_fork` | V1 | `provider, model, policy, cacheRoot, cacheRootSource, cacheRootHops, hops` | decision |
| `gpt_compaction` | V1 | `…, cacheRoot(Ctx), namespace, key` | applied/decision |

## 4. Layer model — implemented as the additive `stage` field (P5-T2)

Every emitted record now carries an **additive** `stage` field, computed centrally in
`createRecorder` (`telemetryStage` / `withTelemetryStage`, `src/cache-engine-core.mjs`), so a
consumer cannot read an applied hook-object change as a wire effect or a provider outcome:

| `stage` | Meaning | Records |
|---|---|---|
| `observation` | local/structural facts (observed bytes, hashes, anomalies) | `prefix-observation`, `prefix-change`, `reasoning-integrity`, `compaction`, `system_volatility`, `*_provider_changed`, `grok`/`muse`/`minimax` flags |
| `decision` | a classification/eligibility/choice with no change made | `policy-resolution`, `gpt_session_fork`, an affinity record with `headerAttached:false` |
| `applied` | the adapter wrote into the **hook object** (never the wire) | `cache-options`, `system_date_relocated`, `mimo_system_env_relocated`, `gpt_compaction`, an affinity record with `headerAttached:true` |
| `outcome` | provider-reported usage | `usage` |
| `error` | a swallowed telemetry/excursion error | `telemetry-error` |

`applied` records **also** carry `wireEffect: "not_observed"` — the serialized request is not
observed here, so an applied change is never a wire claim (P4-T2/T3). An unknown kind is
written unchanged (no `stage`). **V1 `cache-options`** now distinguishes desired vs applied:
`key` is the **desired** key while `keyInjected`/`keyPreserved` say whether the adapter
actually wrote it (`cache-engine.ts`); V2 exposes the same `keyInjected`/`keyPreserved`.

## 5. V1 / V2 parity map

- **V1-only kinds:** `policy-resolution`, `reasoning-integrity`, `prefix-observation`,
  `prefix-change`, `compaction`.
- **V1-only boundary reasons:** `mimo_system_env_relocated`, `mimo_system_prefix_changed`,
  `grok_affinity`, `muse_affinity`, `minimax_route`, `*_provider_changed`,
  `gpt_reasoning_effort_changed`, `gpt_session_fork`, `gpt_compaction`.
- **Shared:** `usage` (core fields), `boundary` (`system_volatility`, `system_date_relocated`,
  affinity), `cache-options`, `telemetry-error`.
- **V2-only:** nothing new; V2 **omits** V1's diagnostics and **lacks** `usage.provider/model`,
  `usage.stickySessionId`, and the V1 GPT `keyStrategy/mode/ttl`. V2 `cache-options` carries
  `key`,`keyInjected`,`keyPreserved`,`transport` (a different shape from V1's).
- **Both adapters (P5-T2):** every record is enriched with `stage` (and `wireEffect` when
  `applied`); `usage` carries `tokenSource: "provider"`.

## 6. Ambiguities / gaps (input to P5-T2..P5-T4)

1. **No wire-effect field** anywhere → P5-T2 must separate "applied" from "wire"; no record
   may be read as proof of a provider effect.
2. **Overloaded names:** `promptTokens`/`cachedTokens`/`cacheHitRate` mean different things for
   GLM vs MiMo (different formulas). Risk of cross-provider misuse.
3. **Generic ratios on provider-specific sessions:** `sampleHitRate`/`cumulativeHitRate` always
   use `read/(read+write)`, even for GLM/MiMo where the authoritative ratio differs.
4. **`cumulative` omits `input`** → GLM/MiMo cumulative ratios cannot be recomputed from it.
5. **`boundary` is a catch-all** kind with heterogeneous fields per `reason` (no discriminator
   beyond `reason`).
6. **No schema/version field** on any record; consumers must tolerate additive change.
7. **Silent write failures:** a lost telemetry line is undetectable (no drop counter).
8. **V1/V2 asymmetry** in `usage` identity fields and `cache-options` shape.

## 7. Helper reference

`hitRatePct(read,write)` `cache-usage-core.mjs:30`; `glmHitRatio(read,write,input)` `:39`;
`mimoHitRate(cached,prompt)` `:65`; `shouldAggregate(count,read,write)` `:75`;
`scanPage(page,cursor,watermark)` `:123`; `nextProcessedCursor(page,cursor)` `:172`;
`shorthash` `:23`. `createRecorder` `cache-engine-core.mjs:224`; `gptCacheOptionsDelta` `:340`;
`volatilityTransition` `:683`; `stableSessionIdFor` `:785`; `isOpenRouterAffinityEligible`
`:793`; `affinityTelemetryFields` `:804`; `mimoSessionIdFor` `:845`.

## 8. Integrity

Read-only; no request mutated; no provider contacted; no prompt/reasoning content or
credentials reproduced.

---

## P5-T2 — layer separation

**Objective:** make every telemetry record state its layer truthfully, so a consumer cannot
read an applied hook-object change as a wire effect or a provider outcome (plan §9 tasks 2 & 5).

**Implemented (additive — no renamed/removed fields):**
- **`stage` field** on every record, computed centrally in `createRecorder`
  (`telemetryStage` / `withTelemetryStage`, `src/cache-engine-core.mjs`):
  `observation` | `decision` | `applied` | `outcome` | `error`. Unknown kinds are written
  unchanged.
- **`wireEffect: "not_observed"`** on every `applied` record — an applied change is never a
  wire claim (P4-T2/T3).
- **V1 `cache-options` truthfulness:** `key` is the **desired** key; new `keyInjected` /
  `keyPreserved` say whether the adapter actually wrote it (a live request with
  `cacheRootKey:false` preserves the existing key). V2 already had `keyInjected`; added
  `keyPreserved` for parity.
- **`usage.tokenSource: "provider"`** (V1+V2) marks `read`/`write`/`input` as provider-reported;
  the `*HitRate` / `promptTokens` fields are derived.

**No-false-success guarantee:** a record is emitted only after the mutation is applied, and a
failed telemetry write yields **no** record at all (never a false success).

**Tests:** `phase5/p5t2:` ×3 — `telemetryStage` classification; `createRecorder` enrichment +
silent write failure; and a V1 `chat.params` probe asserting `keyInjected:false` /
`keyPreserved:true` (desired ≠ applied). `npm test` **376/0**.

**Acceptance:** ✔ every record carries a truthful `stage`; ✔ no record implies an unobserved
wire/provider effect; ✔ V1 `cache-options` distinguishes desired vs applied; ✔ additive (one
existing test expectation updated for the new `stage`); ✔ V1/V2 parity; ✔ a write failure
cannot claim success. The failure-mode matrix (duplicate/missing events, restart, compaction,
eviction) is **P5-T3**.
