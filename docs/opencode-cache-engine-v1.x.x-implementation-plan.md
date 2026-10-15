# OpenCode Cache Engine — Post-1.0.0 Implementation Plan

**Document type:** Harness implementation plan  
**Status:** Phase 1 complete (2026-10-14); Phase 2 complete (P2-T1..P2-T5; P2-T4 real-rollover optional); Phase 3 complete (P3-T1..P3-T6, 2026-10-15; P3-T6 NO-GO on P3-T7); Phase 4 in progress (P4-T1..P4-T3 complete); further implementation requires explicit authorization
**Baseline:** `opencode-cache-engine` 1.0.0; V1 and V2 entry points load  
**Planning date:** 2026-10-13  
**Primary objective:** Improve prompt-cache stability through conservative, provider-aware interventions that are structurally verified and, where possible, proven to improve provider-reported cache reuse.

**Revision:** 2 — engineering hardening (implementation mapping, harness contract, phase metadata, risk register).  
**Input:** `docs/competitor-prompt-cache-plugins-research-report.md` (local-only / gitignored; durable conclusions inlined in §2, §6, §13)  
**Companion context:** `docs/implementation-plan-v2.md` (shipped V2 milestone record, Phases A–D), `docs/research-findings.md`, `docs/cache-policy-inventory.md`

## 1. Purpose

This plan turns the competitor research and current project findings into ordered, reviewable harness tasks. It is not blanket authorization to implement every item.

The intended workflow is:

1. Observe the rendered request.
2. Identify a specific source of avoidable instability.
3. Verify that the hook can safely observe and change it.
4. Make the smallest justified transformation.
5. Verify the serialized request.
6. Measure provider-reported cache behavior where supported.
7. Keep, revise, disable, or reject the intervention based on evidence.

### How to read this plan

Each phase is summarized by **Type / Target / Depends on / Artifacts / Kill
criteria** in §3B. Treat each phase as either **research** (read-only; may add
tests/docs) or **implementation** (mutates request structure; needs explicit
authorization). A phase is not promoted by completion — only by the gate evidence
in §14/§15.

### Product goals

- Improve reuse of stable prompt prefixes without freezing information that should change.
- Preserve prompt semantics and unrelated request fields.
- Maintain V1 compatibility while evolving V2 independently.
- Use provider-, model-, and route-aware policies.
- Distinguish policy decisions, wire effects, and provider outcomes.
- Keep claims reproducible and proportional to evidence.

### Non-goals

Unless separately approved, this plan does not authorize broad prompt/tool reordering, stale-date pinning, keepalive or warming calls, general-purpose memory/pruning, managed OpenCode configuration changes, real provider requests or paid experiments, incidental V1 behavior changes, commits/pushes/tags/publication/version changes, or claims of exactly-once usage accounting.

## 2. Baseline findings

Reconfirm repository state before implementation; these notes are not a substitute for inspection.

- Package version is reported as `1.0.0`; V1 and V2 entry points load.
- V1 and V2 must remain additive and independently testable.
- V2 registers `context` and `model.request` via `ctx.session.hook(...)` and
  subscribes to `session.idle` via `ctx.event.subscribe()` (`src/cache-engine-v2.mjs`;
  `RF-OC-025`/`RF-OC-032`). V1 uses `experimental.chat.system.transform`,
  `chat.headers`, `chat.params`, `experimental.session.compacting`, and `event`.
- V2 discovery, `setup(ctx)`, and hook dispatch are verified for the tested
  project-local shim route (`RF-OC-024`/`RF-OC-025`); the direct
  `plugins: ["opencode-cache-engine/v2"]` subpath config entry **FAILs** on
  OpenCode 2.0.26 (`RF-OC-023`). Any offline harness must use a supported loading
  path.
- GPT cache-option mutation has not been proven to survive every relevant schema/serialization route (Gate 4 **NOT PASS**; `RF-OC-030`/`RF-OC-031`).
- OpenRouter affinity decisions and actual header attachment are separate facts (`RF-OC-026`/`RF-OC-027`).
- Usage accounting is best-effort: event loss, cursor restarts, compaction, timestamp ties, eviction/expiry, and telemetry-write failure can cause undercounting or recounting (`docs/implementation-plan-v2.md` §2D.12; `RF-OC-017`–`RF-OC-021`).
- The existing GLM/MiMo `<env>` relocation does **not** reach the wire on the captured OpenCode 2.0.26 prompt: the helper now accepts the structural shape, but the `<env>` block is already terminal in the eligible `event.system` part (part 2 of 4), so the within-part relocation is a no-op (`RF-OC-035`, superseding the stale *reason* in `RF-OC-033`).
- The captured prompt contained a daily date line before `<env>`. Equivalent same-session requests within a day had byte-identical system text.
- A fixture-only date relocation preserved non-date lines and their relative order. It did not prove provider cache benefit.
- Date-relocation provider benefit remains unproven.
- **Date-anchor discrepancy by version:** the competitor `C5`
  (`opencode-consistent`) documents the date *inside* the `<env>` block in
  OpenCode 1.18.27, whereas the captured 2.0.26 prompt carried a separate date
  line before `<env>`. Record the exact anchor per version before writing a
  matcher, and define how the date transform interacts with the existing
  `<env>` relocation overlay (`relocateVolatileEnvBlock`).

Competitor research suggests that cache-key injection does not fix an unstable prefix; broad reordering has semantic risk; date/memory pinning can create stale context; keepalive incurs spend; and public performance claims are often not independently reproduced. These are research conclusions, not proof that every competitor has every limitation.

## 3. Harness operating rules

### Inspect before acting

At task start, report branch/HEAD, tracked modifications and untracked files, package version/scripts, relevant source/tests, and any baseline discrepancy. Do not reset, stash, overwrite, or clean up unrelated work.

### Safety and integrity

- Never commit, push, amend, rebase, tag, publish, or bump versions unless explicitly authorized.
- Do not modify managed OpenCode config, installed plugins, user cache/state, or running services without explicit authorization.
- Do not use `opencode plugin add/remove/update` or unsupported `opencode run --plugin`.
- Never access, print, copy, or log real credentials.
- No real provider requests or paid calls without explicit authorization.
- Do not kill ambiguous processes; identify ownership and ask first.
- Preserve the untracked `package-lock.json` byte-for-byte if it remains present. Previous expected SHA1: `bcf39bba1806d74418eedb4decdb97aefd43c409`. If it differs, report and do not repair it.
- The user manually verifies and commits.

### Evidence labels

Use these labels in reports and documentation:

- **Documented:** first-party/upstream source read directly (provider docs, OpenCode source/issues/specs). Authoritative on *mechanics*, not on any third party's results.
- **Observed:** directly captured or measured.
- **Structurally verified:** deterministic tests prove the transformation.
- **Wire verified:** the **serialized** request contains the intended change — captured after OpenCode's schema decoding (see the harness and capture contract in §3), not from a hook payload.
- **Provider measured:** provider-reported cache metrics change in a controlled experiment.
- **Inferred:** plausible but unproven.
- **Author reported:** third-party claim not independently reproduced.
- **Inconclusive:** evidence does not support a reliable pass/fail conclusion.

These labels refine the two tracked stores' tags
(`docs/research-findings.md`, `docs/cache-policy-inventory.md`): `[D]` =
**Documented** (the competitor report's `(official)`/`(upstream-spec)`), `[O]` =
Observed / Structurally / Wire / Provider-measured, `[I]` = Inferred, `[U]` =
unknown. A third-party claim is **Author reported** (the report's `(report)`),
never `[D]` or measured. Store every newly verified fact in the tracked stores
with an ID.

### Harness and capture contract

Read-only capture is the substrate for every later claim, so it must observe the
**serialized** provider request rather than a hook payload:

- **Capture point.** A loopback mock endpoint receives the outgoing request after
  OpenCode's own schema decoding. Capturing the `context`-hook payload instead
  would false-positive: the OpenAI-compatible schema strips the GPT cache fields
  (`RF-OC-030`), and hook mutations surface as generic `providerOptions`
  (`RF-OC-032`).
- **Isolation.** Reuse the established procedure
  (`docs/implementation-plan-v2.md` §2D.0–§2D.6): `bwrap --unshare-net`, private
  HOME/XDG, a local disposable npm registry plus a loopback mock
  (`RF-OC-019`–`RF-OC-025`).
- **Loading path.** Use only a supported path — the package name or a
  project-local shim. The direct `plugins: ["opencode-cache-engine/v2"]` subpath
  entry does not resolve (`RF-OC-023`).
- **Privacy and retention.** Hash defined sections; never log credentials or
  authorization headers; full-body capture is opt-in, local-only, gitignored, and
  TTL'd; never inject diagnostics, IDs, or fingerprints into the prompt.
- **Per-runtime entry points.** V1 capture exercises
  `experimental.chat.system.transform`; V2 capture exercises `context` /
  `model.request` and `ctx.event.subscribe()`.

Each task report must state objective, initial state, findings, files changed, tests, unresolved risks, whether provider calls occurred, cleanup/integrity, and a pass/fail/inconclusive recommendation.

## 3A. Current implementation mapping

Much of the plan's Phase 1 already ships in `src/cache-engine-core.mjs` and
`src/cache-engine.ts`. Extend these primitives; do not re-implement them.

| Plan capability | Existing implementation | Gap to close |
|---|---|---|
| Section fingerprints | `systemShapeHashes` (`fullSystemHash`, `stableSystemPrefixHash`, `volatileSystemSuffixHash`), `commonPrefixLength` | none — reuse |
| Tool fingerprints | `toolFingerprint` (order-insensitive), `toolWireFingerprint` (order-sensitive), `normalizeTool` | none — reuse |
| First-difference reporting | `shapeDiff`, `shapeFieldDiffs`, `prefixChangeReasons`; telemetry `prefix-change` (`dimensions`, `changedFields`, `reasons`, `before`/`after`, `semanticToolsChanged`, `wireToolsChanged`) | persist a first-differing **byte offset**; add a human-readable "what changed" store |
| Baseline observation | telemetry `prefix-observation` (`note:"initial"`) | none — reuse |
| Silent-invalidator linter | *none* | **new** — a pure `lintSystemVolatility()` in `cache-engine-core.mjs` |
| Offline capture harness | the isolated procedure (`RF-OC-019`–`RF-OC-025`; v2 plan §2D) | **new** — a reusable, checked-in harness (§3, harness contract) |
| Identity vs stability | `policy-resolution` (`matchCategory`) + `prefix-change` | **new** — a combined diagnostic (opportunity `O-5`) |
| Usage/accounting | `hitRatePct`, `glmHitRatio`, `mimoHitRate`, `shouldAggregate`, `scanPage`, `nextProcessedCursor`; records `usage`/`boundary`/`compaction` | reuse and document; do not mint a universal ratio |
| Compaction | telemetry `compaction`, `digestDecision`, `DIGEST_TEMPLATE`; one-insert invariant | build `O-4` re-prefill measure on these |

## 3B. Phase map — type, target, dependencies, artifacts, kill criteria

| Phase | Type | Target | Depends on | Primary artifacts | Kill / stop criteria |
|---|---|---|---|---|---|
| 0 Baseline | research | V1 + V2 | — | baseline report, compatibility checklist, policy matrix, test list | baseline red and unrepairable |
| 1 Diagnostics | research | V1 + V2 | G0 | capture harness, first-diff report, `lintSystemVolatility`, byte-offset telemetry | cannot relocate a known changed byte |
| 2 Date relocation | research → implementation (gated) | V1 + V2 | Phase 1 (G1) | anchor-per-version report, helper + tests, date-shift harness, provider A/B report | no reproducible `cache.read` delta over ≥2 rollovers ⇒ inconclusive |
| 3 Other volatility | research | V1 + V2 | Phase 1 | ranked volatility inventory | no recurring, avoidable, safely-correctable cause |
| 4 Policy/transport | research + verification | per route | G3 | route-specific wire tests, policy metadata | field stripped/unsupported ⇒ stay passive |
| 5 Accounting/telemetry | implementation | V1 + V2 | Phase 1 | metric-definition doc, failure-mode tests | any metric source undefined |
| 6 Compaction research | research | V1 + V2 | Phase 5 | compaction-cost report (initial re-prefill vs reuse) | hook lacks sufficient data |
| 7 Observability | implementation (gated) | V1 + V2 | Phase 5 | compact report view (`./tui` surface) | metrics untrustworthy |
| 8 Benchmark/docs | implementation | V1 + V2 | Phases 0–7 | reproducible harness, benchmark report, policy matrix | not reproducible by a third party |

## 3C. Quantitative acceptance thresholds

Default, measurable thresholds. A phase that misses a threshold does not advance
(the gate fails) unless the miss is documented and explicitly accepted.

| Phase | Metric | Threshold |
|---|---|---|
| 1 | First-difference localisation | exact first-differing byte offset on 100% of ≥5 synthetic perturbations; 0 false changes on an identical-replay fixture |
| 1 | Diagnostics non-mutation | a diagnostics-only run leaves the serialized request byte-identical (0 changed bytes) |
| 1 | Linter | 0 `high` findings on the intentional-volatility allowlist; every `high` rule has a failing fixture |
| 2 | Transform invariants | date occurs exactly once; every non-date byte identical; no-op on missing/duplicate/malformed |
| 2 | Provider benefit | a reproducible `cache.read` increase vs baseline, directionally consistent (no sign flip), across ≥2 rollovers |
| 4 | Wire | the intended field is present in the serialized body on the verified route, and unrelated fields are unchanged |
| 5 | Accounting | every record field traces to a documented provider usage field; ≥1 failure-mode test per documented caveat |
| 5 | Ratios | generic `read/(read+write)`; GLM `read/(read+write+input)`; MiMo `cachedTokens/(read+input)` — asserted per provider, never universalised |
| 7 | Observability | shows policy mode + last change + wire status without exposing prompt content; adds 0 bytes to the prompt |
| 8 | Reproducibility | a third party reproduces the harness with the documented command and obtains the same structural result |

## 4. Phase 0 — Establish the 1.0.0 baseline

**Objective:** Protect the released architecture before changing prompt behavior.

### Tasks
1. Inspect package exports, plugin entry points, policy registry, telemetry definitions, and test commands.
2. Verify V1/V2 loadability using existing safe tests or offline fixtures.
3. Record baseline test results and package dry-run contents.
4. Identify shared modules/helpers that could couple V2 changes to V1.
5. Document active, passive, and experimental policies.
6. Record schema/serialization limitations and usage-accounting caveats.
7. Add only missing regression tests justified by the existing code; avoid unrelated refactors.

### Deliverables
- Baseline report.
- V1/V2 compatibility checklist.
- Current policy/status matrix.
- Safe test command list.

### Acceptance criteria
- Both entry points remain loadable.
- Existing tests pass or baseline failures are documented.
- Package contents match intended exports.
- No managed config changes, credentials, or provider requests.
- No unrelated files changed.

**Gate 0:** Do not proceed until baseline behavior and regression boundaries are clear.

## 5. Phase 1 — Structural diagnostics and offline capture

**Status: COMPLETE** (Phase 1 closure, 2026-10-14; suite 362/0). Delivered the
`lintSystemVolatility` linter, `firstSystemDifference`, baseline-relative
`systemStablePrefixLength` telemetry, V1/V2 diagnostic integration, and the
offline/mock capture harness. Phase 2 (date relocation) is not started and remains
gated on provider-side rollover evidence and explicit authorization.

**Objective:** Detect and explain instability without mutating requests.

### Capture harness
Build or extend an offline harness using a local mock endpoint and network isolation. Capture at least two equivalent requests, including:

- Provider/model route.
- System parts and text.
- Tool definitions, order, and serialized shape.
- Message roles/content/order.
- Cache-related options and headers.
- Other fields needed to detect unintended mutation.

### First-difference reporting
Report request equality, first differing section/byte offset, before/after lengths, tool-order/schema differences, message-structure differences, changed options/headers, and whether a fixture difference is expected. Do not assume every difference causes a cache miss.

### Fingerprints and privacy
- Hash defined prompt sections rather than persist full content by default.
- Keep full-body capture opt-in and local.
- Never log credentials or authorization headers.
- Do not inject diagnostic IDs, fingerprints, or telemetry into the prompt.

### Silent-invalidator linter

Add a read-only linter, `lintSystemVolatility(parts, tools)` (a pure function in
`cache-engine-core.mjs`), that returns advisory findings keyed by a stable rule
ID. It must never trigger automatic rewrites and must run without touching the
request. Each rule carries a severity and a detection basis:

| Rule ID | Pattern | Severity |
|---|---|---|
| `VOL-TIMESTAMP` | Wall-clock timestamp/counter in system, esp. sub-second (`C7` case study) | high |
| `VOL-SESSION-ID` | Random/per-user/session-specific ID in early system content | high |
| `VOL-TOOL-SET` | Tool added/removed mid-session | high |
| `VOL-TOOL-ORDER` | Registry/wire tool order changes across equivalent turns | medium |
| `VOL-CONDITIONAL` | Conditional system sections | medium |
| `VOL-NONDET-JSON` | Non-deterministic serialization (unsorted keys/maps) in serialized fields | medium |
| `VOL-DYNAMIC-BEFORE-STABLE` | Dynamic content ahead of stable content | medium |
| `VOL-DATE` | A daily date line (expected; a relocation candidate, not a defect) | info |
| `VOL-CWD-PATH` | Absolute cwd/worktree path (stable within a session, changes on resume) | info |

**Intentional-volatility allowlist.** `VOL-DATE` (the daily rollover),
skills/`AGENTS.md` updates, and compaction boundaries are *expected* volatility;
the linter surfaces them at `info`, never at `high`. A `high`-severity finding
raised on allowlisted content is a bug.

**Rule provenance.** `VOL-TIMESTAMP` / `VOL-SESSION-ID` / `VOL-TOOL-ORDER` /
`VOL-CONDITIONAL` / `VOL-NONDET-JSON` / `VOL-DYNAMIC-BEFORE-STABLE` mirror the
first-party silent-invalidator list (report §5); `VOL-DATE` and `VOL-CWD-PATH`
are our own known-neutral patterns.

### Tests and acceptance
- Identical fixtures produce no diff.
- A known changed byte is located correctly.
- Tool-order, option, and header changes are detected.
- Sensitive values are redacted by default.
- Diagnostics do not mutate requests.
- Diagnostic failures do not break ordinary plugin operation.
- Every `high` linter rule has a failing fixture; the intentional-volatility
  allowlist produces no `high` finding.
- The numeric thresholds in §3C hold.

**Gate 1:** Automatic corrections wait until the target instability is reliably identifiable.

## 6. Phase 2 — Date relocation investigation

**Status: COMPLETE** (2026-10-14; P2-T1..P2-T5). The date-line relocation is
implemented (default off), wire-verified (G3), and the provider A/B showed directional
support only (G4 not promoted). See `docs/phase2-p2t5-acceptance-decision.md`.

**Objective:** Determine whether moving the daily date line is safe and improves cache reuse.

### Verify hook shape
For each intended route, record the number/types of `event.system` parts, whether the date and surrounding text share a mutable text part, date format/location, GLM-5.3 versus MiMo-V2.6 differences, and whether hook input matches final serialized content. Use disposable projects and a local mock; no credentials or provider requests.

### Candidate transformation
If the shape permits it, move only the date line to the end of the containing system text.

Required invariants:
- Date value/format unchanged and occurs exactly once.
- All non-date content remains byte-for-byte identical.
- Relative order of non-date lines remains unchanged.
- Tools, messages, model, options, and unrelated headers are unchanged.
- Missing, duplicate, malformed, or ambiguous date structures are a no-op.
- Policy can be disabled independently.
- Do not loosen the old `<env>` marker guard without a separate safety case.
- Do not pin the date; current date information must remain current.

### Offline tests
Cover the captured OpenCode 2.0.26 shape, missing/duplicate date, whitespace/line endings, date in a different part, unexpected part types, older marker-bearing shape, GLM/MiMo differences, and V1 isolation. Verify the actual serialized mock request, not only helper output.

### Provider-side A/B
Only with explicit authorization:
- Compare baseline/candidate using equivalent workloads and matched sessions.
- Prime before a date rollover and measure after the date changes.
- Record cached input tokens, cache write/creation tokens, total input tokens, request sizes, model, and route where available.
- Repeat across at least two rollovers where practical.
- Report variance and confounders.
- Synthetic date injection is useful for transform tests but cannot replace provider-side evidence.

### Acceptance and gate
Hook shape and wire behavior must be documented; invariants must pass; no stale date is introduced; and the provider-side evidence must show repeatable benefit before promotion. Otherwise keep experimental, revise, or reject. Structural correctness alone is not a cache-benefit claim.

## 7. Phase 3 — Investigate other volatility sources

**Status: P3-T1..P3-T3 COMPLETE** (2026-10-15) — P3-T1: offline capture groundwork,
fixtures, go/no-go (`RF-OC-040`/`RF-OC-041`); P3-T2: tool ordering **no-op**
(`RF-OC-042`); P3-T3: startup/MCP **no-op/watch item** (`RF-OC-044`, superseding `RF-OC-043`); P3-T4:
dynamic instructions/project context **no-op** (`RF-OC-045`); P3-T5: reasoning/thinking
**no-op / insufficient evidence** (`RF-OC-046`); P3-T6: **NO-GO on P3-T7** (no recurring +
avoidable + safely-correctable cause). **Phase 3 COMPLETE** — reports in `docs/phase3-*`.

**Objective:** Rank additional causes based on actual captures rather than competitor feature lists.

### Tool ordering
Compare tool names/order and serialized definitions across equivalent turns and startup. Determine whether upstream already sorts tools and whether changes are legitimate. Only consider sorting after demonstrating avoidable nondeterminism and semantic safety.

### Startup/MCP readiness
Compare first request after startup with subsequent requests. Record pending/connected/missing tool differences if observable. Determine whether the hook sees readiness. Start with diagnostics; do not block requests. Any bounded-wait feature requires separate approval and latency/hang analysis.

### Dynamic instructions and project context
Classify changes as unintentional volatility, intentional updates, or potentially stale frozen content. Do not freeze project instructions, skills, workspace state, or tools simply to preserve a cache prefix.

### Reasoning/thinking blocks
Investigate route-specific interaction with cache boundaries. Do not generalize fixes without captured evidence.

### Deliverable and gate
Produce a ranked volatility inventory with observed/inferred status, frequency, expected impact, risk, and next experiment. Only recurring, avoidable, safely correctable causes advance.

## 8. Phase 4 — Provider-policy and transport verification

**Status: IN PROGRESS** (2026-10-15) — P4-T1 (policy inventory + metadata) complete;
P4-T2 complete — **not wire-attributed** (`RF-OC-047`); P4-T3 complete — **not
wire-attributed** (`RF-OC-048`). P4-T4..P4-T5 pending. See `TODO.md`.

**Objective:** Make every policy route-aware and independently testable.

### Policy classes
- **Passive:** observes without request mutation.
- **Structural:** narrow, content-preserving transformation.
- **Transport-specific:** cache key, affinity header, or breakpoint on a verified route.
- **Experimental:** disabled by default until evidence gates pass.

### Policy metadata
For every policy, document eligible provider/model/routes, intended failure mode, mutation, preconditions/no-op behavior, structural and wire verification, provider metrics, correctness/privacy/latency/cost/staleness risks, disable path, and evidence level.

### GPT cache options
Verify each intended field through: adapter assignment → OpenCode schema → provider serialization → intended route → provider-supported semantics → measured outcome. Do not report “enabled” solely because a property was assigned.

### OpenRouter affinity
Verify route eligibility, header precedence, preservation of user-supplied headers, serialized attachment, route semantics, and whether reuse improves independently of prompt stability. A stable key does not repair unstable bytes.

### Acceptance and gate
Every active policy has route-specific tests; stripped/unsupported fields are not reported as wire success; passive policies remain passive; identity and prefix stability remain distinct. No policy is promoted based on attempted mutation alone.

## 9. Phase 5 — Usage accounting and telemetry

**Objective:** Improve diagnostics while keeping accounting claims honest.

Tasks:
1. Define the source and meaning of every metric.
2. Separate decisions, attempts, applied transformations, wire effects, and provider outcomes.
3. Test duplicate/missing events, restarts, compaction, same-timestamp records, eviction, and telemetry-write failures.
4. Document expected undercount/recount scenarios.
5. Ensure telemetry failure cannot falsely claim transformation success.
6. Keep telemetry outside prompt content.
7. Use provider-specific formulas; do not force a universal ratio across incompatible providers.

Usage accounting remains best-effort. Never claim exactly-once accounting. Prefer precise terms such as `cache_read_tokens`, `cache_write_tokens`, `input_tokens`, `observed_cache_read_ratio`, and `estimated_cost_delta`. Missing metrics mean unavailable, not zero.

### Acceptance
Metric definitions are documented; failure modes are tested or explicitly documented; telemetry does not alter requests; estimates are not presented as actual savings.

## 10. Phase 6 — Compaction and memory-boundary research

**Objective:** Understand compaction cache cost before changing context rewriting.

Tasks:
1. Capture requests before and after compaction.
2. Identify unchanged prefix regions.
3. Measure cache reads/writes around compaction.
4. Estimate one-time cost of establishing a new prefix.
5. Compare with reuse on later requests.
6. Document summary correctness and staleness risks.
7. Confirm supported hooks expose sufficient information.

Do not change on-disk session history, add general-purpose memory/pruning, or implement active compaction rewriting during this research phase. Do not add a separate summarization call without accounting for its cache cost.

**Acceptance:** A report distinguishes initial re-prefill cost from later reuse and describes semantic risks. Active compaction rewriting requires a separate decision.

## 11. Phase 7 — Minimal user-facing observability

Start with a compact report/view showing policy mode, last structural change, first differing section, transformation attempt/application status, wire verification, provider cache metrics when available, accounting limitations, and estimated cost impact only when assumptions are explicit.

Do not build a large dashboard before metrics are trustworthy. UI/telemetry must not alter prompt content. Do not show a ratio when provider data is insufficient.

**Acceptance:** Users can tell what changed and what evidence supports it without exposing full prompt content or secrets.

## 12. Phase 8 — Reproducible benchmark and public documentation

### Harness capabilities
- Baseline/candidate policy selection.
- Offline capture and first-difference reporting.
- Repeated equivalent turns and rollover tests.
- Route/model/version metadata.
- Provider metrics when available.
- Error, latency, and extra-call recording.
- Redaction and local-only defaults.

### Benchmark report
Include OpenCode/plugin versions, provider/model route, policy conditions, workload/repetition count, structural diff, wire verification, provider metrics, result distribution, errors/confounders, and whether conclusions are structural, provider-measured, or estimated.

Publish the provider-family policy matrix, supported routes/version limits, distinction between identity and stability, telemetry limitations, and evidence level behind each performance claim. Label competitor numbers as author-reported unless independently reproduced.

**Acceptance:** A third party can reproduce the method and understand what the evidence does and does not establish.

## 13. Deferred backlog

| Item | Why deferred | Revisit when |
|---|---|---|
| Keepalive/warming | Adds spend and depends on TTL/cost assumptions. | Route-specific break-even model demonstrates value. |
| Broad system-block reordering | Semantic risk and large blast radius. | Diagnostics prove a recurring defect and a safe narrow rule exists. |
| Automatic tool sorting | May duplicate upstream or change semantics. | Captures prove avoidable ordering instability. |
| Blocking on MCP readiness | Latency/hang risk. | Startup instability is measured and bounded waiting justified. |
| Frozen date/memory | Can expose stale information. | Explicit use case accepts a staleness window. |
| General-purpose pruning | Broader than cache stability. | Concrete cache-specific need is demonstrated. |
| Automatic policy learning | Opaque and vulnerable to noisy observations. | Diagnostics and policy evaluation are mature. |
| Large TUI/dashboard | Premature before metrics are reliable. | Core diagnostics and outcome data are trustworthy. |

## 14. Testing ladder

Every intervention follows the same ladder:

- **A — Unit:** eligibility, transformation invariants, no-op behavior, malformed inputs.
- **B — Integration:** hook shape, policy selection, state boundaries, V1/V2 isolation.
- **C — Offline wire:** local mock verifies serialized request and unrelated-field preservation.
- **D — Provider experiment:** only with explicit authorization; matched workloads and provider metrics.
- **E — Release qualification:** packaging, documented entry points, regression tests, rollback, claims aligned to evidence.

Passing one level does not imply passing the next. Unit and wire tests cannot prove provider cache benefit.

## 15. Release gates

| Gate | Requirement | Failure outcome |
|---|---|---|
| G0 — Baseline | V1/V2 compatibility and regression baseline healthy. | Stop and repair baseline. |
| G1 — Observation | Structural changes reproducibly detected without mutation. | Improve diagnostics. |
| G2 — Safety | Invariants and no-op conditions pass. | Narrow or reject transform. |
| G3 — Wire | Serialized request contains intended change only. | Fix route path or reject. |
| G4 — Outcome | Provider evidence supports claimed benefit. | Keep experimental, revise, or reject. |
| G5 — Operations | Privacy, failure handling, rollback, limits documented. | Do not enable by default. |
| G6 — Publication | Docs and claims match tested routes/evidence. | Do not publish claim. |

Negative or inconclusive results are valid outcomes. Completion of implementation is not itself a promotion criterion.

These gates are numbered independently of the gate ladder in
`docs/implementation-plan-v2.md` §2D. In particular, this plan's **G0–G6 are
not** the v2 plan's Gate 4 (which closed **NOT PASS**). Cross-reference; do not
conflate the two ladders.

## 16. Priority order

1. Baseline and V1/V2 regression protection.
2. Offline capture, first-difference diagnostics, fingerprints, and linter.
3. Hook-shape and serialization verification for date relocation.
4. Date relocation only if structurally safe; test offline first.
5. Authorized provider rollover experiment before any benefit claim.
6. Route-specific GPT option and OpenRouter affinity verification.
7. Ranked investigation of tool ordering, startup/MCP, dynamic instructions, and reasoning boundaries.
8. Telemetry definitions and best-effort accounting documentation.
9. Compaction economics research.
10. Minimal observability and reproducible public benchmark.

## 17. Harness task completion template

```markdown
## Task result

### Objective
One question/deliverable addressed.

### Initial state
- Branch / HEAD:
- Worktree:
- Package version:
- Test baseline:
- Lockfile integrity:

### Findings
- Documented (source):
- Observed:
- Structurally verified:
- Wire verified:
- Provider measured:
- Inferred / unresolved:

### Changes
- Files changed:
- Behavior changed:
- Behavior intentionally unchanged:

### Validation
- Commands and tests:
- Offline isolation:
- Provider requests made: yes/no
- Credentials accessed: no

### Acceptance criteria
- [ ] Criterion 1
- [ ] Criterion 2

### Risks and limitations
What remains unproven?

### Cleanup and integrity
- Temporary artifacts/processes:
- Worktree status:
- Lockfile hash:
- Managed config/services untouched:

### Recommendation
Pass / fail / inconclusive, with supporting evidence.
```

## 17A. Risk register and rollback

| Risk | Phase | Mitigation | Rollback / disable path |
|---|---|---|---|
| Matcher false-positive rewrites content | 2 | narrow, version-anchored anchor; exact-match invariants; malformed ⇒ no-op | disable the policy flag (additive transform) |
| Stale date shown to the model | 2 | **relocate**, never pin; date value/format unchanged | disable the date policy |
| Date interior to `<env>` or multi-part shape | 2 | record the anchor per version; no-op unless exactly one eligible block | disable; keep the `<env>` guard intact |
| Harness false-positive (hook payload ≠ wire) | 1 | capture the serialized body (§3) | n/a (read-only) |
| Diagnostics/telemetry alters the prompt | 1, 5, 7 | pure functions; no prompt injection; additive records only | revert the diagnostic |
| Overclaimed accounting | 5 | provider-specific formulas; best-effort only | correct or deprecate the record |
| Version-coupled hook drift | 2, 4 | verify the hook shape per version before enabling | disable per version |
| Competitor-number contamination | all | label author-reported; no dependency on unverified numbers | remove the claim |

Every policy declares a **staleness window** and a **disable path** in one line
(opportunity `O-9`).

## 18. Governing decision rule

> Do not ship a cache intervention because it looks reasonable, because another plugin uses it, or because the adapter executed it. Ship it only when the instability is observed, the transformation is safe, the wire effect is verified, and the claimed benefit is supported by appropriate evidence.

This keeps the program focused on prompt-cache stability while borrowing useful ecosystem ideas and avoiding unsupported assumptions, broad rewrites, unnecessary provider spend, and overstated performance claims.
