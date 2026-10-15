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
