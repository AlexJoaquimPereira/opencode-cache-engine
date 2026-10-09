# Implementation Plan for **opencode-cache-engine** (v0.5.x → v1.0)

The **opencode-cache-engine** has completed its v0.4.x maintenance (fixing K1/K2 issues) and is ready to expand to additional providers and support both OpenCode V1 and V2 runtimes in a combined 1.x release line. This document outlines a step-by-step, role-based implementation plan covering:

- **Goals & Scope:** Scope of V1 stability, new provider features, V2 adapter development, and dual-runtime 1.0 release.
- **Branch Strategy:** Exact Git branch names and workflow for parallel V1 and V2 development.
- **Task List:** Detailed tasks with priorities, roles (maintainer, adapter-dev, policy-dev, QA), effort estimates, dependencies, and acceptance criteria.
- **File-Level Refactor Plan:** Which files to create/move/modify, with code snippets for the shared core and runtime adapter interfaces.
- **API Contracts:** Runtime adapter interface methods/types and an example policy registry schema (in JSON/YAML).
- **Testing Matrix:** Unit, integration, and live-model tests (with cost limits), test data and mocks.
- **CI & Packaging Checklist:** Steps for continuous integration and final packaging.
- **V2 Migration Checklist:** Mapping V1 hooks to V2 (`ctx.session.hook("context")`, `model.request`, compaction hooks, header handling).
- **Provider Recipes:** Superseded by §2, which defines the v0.5.x provider-coverage phase (Kimi, Claude, Gemini, Qwen, xAI/Grok, Meta Muse, MiniMax) with per-provider tasks, tests, and acceptance criteria. Mistral remains the only deferred candidate.
- **Observability/Telemetry:** New telemetry fields to add (e.g. cache strategy, identity).
- **Risk Register & Rollback Plan:** Key risks and mitigation strategies.
- **Timeline & Milestones:** Gantt chart (mermaid) and acceptance criteria for 0.5.x–1.0.0 milestones.
- **Harness Commands:** Exact commands (Git, npm, OpenCode) to validate each milestone.

The plan started from the `v0.4.13` baseline on `master` (v0.4.x maintenance complete; all known bugs fixed) and a repository at `https://github.com/AlexJoaquimPereira/opencode-cache-engine`; the v0.5.x provider coverage has since shipped (see §2.0).

```mermaid
flowchart LR
    v04["v0.4.x maintenance<br/>(done)"] --> v05["v0.5.x provider coverage<br/>(shipped)"]
    v05 --> v06["v0.6.0 shared usage/accounting core<br/>(shipped — tag v0.6.0)"]
    v06 --> v07["v0.7.x core contract + session-state spec<br/>+ V2 readiness (PLANNED NEXT)"]
    v07 --> v08["v0.8.x functioning V2 adapter<br/>(future — needs verified V2 API)"]
    v08 --> v09["v0.9.x dual-runtime stabilization<br/>(future)"]
    v09 --> v10["v1.0.0 dual-runtime release<br/>(only when both runtimes validated)"]
    v2b["feature/v2-adapter branch<br/>(protected)"] -.-> v07
    v2b -.-> v08
```

Milestone status (reconciled 2026-10-09; no fixed calendar dates are promised):

| Milestone | Objective | Status |
| --- | --- | --- |
| v0.4.x | Maintenance; K1/K2 fixes | done |
| v0.5.x | Provider coverage (Kimi, Claude, Gemini, Qwen, xAI/Grok, Meta Muse, MiniMax) | shipped (last family MiniMax = 0.5.8) |
| v0.6.x | Shared usage/accounting extraction + provider conformance tests | shipped as **v0.6.0** (tag `v0.6.0` = `c1f3420`; 277-test suite green) |
| v0.7.x | Runtime-independent core contract, session-state model, V2 readiness | **in progress** — v0.7.0 core/adapter contract implemented (docs + tests; see §2B.8); session-state (v0.7.1) and V2 readiness (v0.7.2+) pending |
| v0.8.x | Functioning V2 adapter (runtime-specific integration) | future work — gated on a verified V2 API contract |
| v0.9.x | Dual-runtime stabilization and documentation | future work |
| v1.0.0 | Dual-runtime release | only when V1 and V2 are independently validated |

**Acceptance Criteria (Milestones):** Each milestone has explicit done conditions. **v0.5.x** is a provider-coverage phase: Kimi, Claude, Gemini, Qwen, xAI/Grok, Meta Muse, and MiniMax each land as a separate validated release (see §2 and §2.0). **v0.6.0** consolidates the shared usage/accounting core and conformance tests with no provider prerequisites (see §2.0b). **v0.7.x** establishes and documents a runtime-independent shared-core contract, specifies session-state ownership and lifecycle, and prepares for V2 integration **without changing V1 behavior or claiming dual-runtime support** — it does not build a functioning V2 adapter (see §2B). **v0.8.x** sees a functioning V2 adapter only after the V2 API contract is verified. **v0.9.x** stabilizes the dual-runtime beta. **1.0.0** is release-ready with complete documentation.

## 1. Goals and Scope

- **V1 Maintenance:** Keep `v0.4.x` stable. All v0.4 bug fixes (K1/K2) are done; no regressions allowed. (Existing metrics, accounting, and policy behavior remain unchanged unless explicitly enhanced.)
- **New Provider Strategies:** v0.5.x has added and validated cache strategies for **Kimi, Anthropic/Claude, Google Gemini, Qwen, xAI/Grok, Meta Muse, and MiniMax** as independent, separately released increments (see §2 and §2.0). Mistral remains the only deferred candidate. Each provider strategy is independently researched and tested; provider additions are never bundled with a large architecture refactor.
- **V2 Adapter Development:** Build a parallel OpenCode V2 plugin adapter in its own branch, reusing the shared policy/core logic. This allows supporting both V1 and V2 concurrently by v1.0. (v0.7.x specifies and validates the shared-core contract and V2 readiness only — see §2B; the functioning adapter is v0.8.x.)
- **Dual-Runtime 1.0 Target:** Release 1.0.0 when the plugin works correctly under both OpenCode V1 and V2. The codebase should have a single shared core + two runtime adapters (V1 and V2 entry points) by then.

_Per Scope Constraints:_ Do **not** attempt to rebuild the plugin as a V2-only project or drop V1 support. Focus on cache logic; **pricing/cost thresholds are out of scope** (as per policy). All changes should preserve existing behavior unless refactoring for architecture.

## 2. v0.5.x — Provider coverage phase (Kimi, Claude, Gemini, Qwen, Grok, Muse, MiniMax)

`master` started from the v0.4.13 baseline and `feature/v2-adapter` is branched off
that tag; the v0.5.x provider coverage has since shipped on `master`. **v0.5.x is a
provider-coverage phase, not an architecture phase.** The V2 adapter continues
independently on its own branch. Mistral remains the only deferred candidate, and
provider additions are not combined with a large architecture refactor.

### 2.0 Current status (reconciled 2026-10-07)

| Provider | Status | Release |
| --- | --- | --- |
| Kimi | released — passive, route-scoped | 0.5.x |
| Anthropic / Claude | released — passive | 0.5.x |
| Google Gemini | released — passive | 0.5.x |
| Alibaba Qwen | released — passive | 0.5.x |
| xAI Grok | released — passive | 0.5.6 |
| Meta Muse | released — passive | 0.5.7 |
| MiniMax | released — passive, route-aware (model-split M3 vs M2.x cache-write baselines) | 0.5.8 |

Remaining deferred candidate: **Mistral** (it still requires its own audit-first
evidence note; do not implement from plan text). No provider work has touched
`feature/v2-adapter`, and provider work stays independent of the V2 adapter.

### 2.0b v0.6.x — shared-core consolidation (completed; released as v0.6.0)

- **Usage-accounting extraction (done):** the runtime-independent usage/accounting
  primitives were moved into `src/cache-usage-core.mjs` (`shorthash`, `hitRatePct`,
  `glmHitRatio`, `mimoHitRate`, `shouldAggregate`, `scanPage`, `nextProcessedCursor`);
  `src/cache-engine-core.mjs` re-exports them, so the public surface and the
  accounting semantics are byte-for-byte unchanged. The module has no
  OpenCode-client, hook, routing, or V2 dependency.
- **Cache-identity abstraction (audited — no new abstraction):** the existing
  `stableSessionIdFor` / `mimoSessionIdFor` / `gptCacheKeyFor` helpers already
  provide deterministic, non-secret, per-session identifiers. No speculative
  abstraction was added, and identity is never used to mutate a request where the
  harness already owns the key.
- **Policy conformance/regression tests (done):** a table-driven matrix now covers
  all eleven families — classification, lookalike rejection, the active/passive
  capability distinction, fail-closed unknown handling, disabled behavior,
  non-fabricated usage, and the single-definition re-export contract.
- **Provider work:** already completed in the v0.5.x line; no provider behavior
  changed in this milestone.
- **Provider expansion:** not performed; Mistral remains deferred (audit-first).
- **Release (done):** shipped as **v0.6.0** (commit `c1f3420`, tag `v0.6.0`).
  `npm test` is green (277 tests at the time of writing; the count may grow as
  tests are added); `npm pack --dry-run` lists 8 files at version 0.6.0; no
  provider behavior changed.
- **Out of scope (untouched):** the adapter interface / runtime-adapter contract
  and the functioning V2 adapter. The contract and session-state **specification**
  work is now scoped in **§2B** (v0.7.x); the functioning adapter remains v0.8.x.

Every provider below still goes through the **audit-first** procedure in
`AGENTS.md`. The official links in this section are *starting references to
verify*, not verified evidence: confirm each field name, mechanism, TTL, and
usage mapping from first-party documentation and record it in
`docs/cache-policy-inventory.md` / `docs/research-findings.md` before writing
policy code. If evidence is insufficient, ship a passive/neutral policy.

### 2.1 Order and planning ranges

Estimates are working days for a solo developer and exclude waiting for provider
access or resolving undocumented behavior. Treat them as planning ranges, not
release commitments.

| # | Family           | Approach                                                                     | Estimate                  |
|---|------------------|------------------------------------------------------------------------------|---------------------------|
| 1 | Kimi             | Route-specific policy (Chat Completions / Responses vs Anthropic-compatible)  | 2–4 days after research  |
| 2 | Anthropic/Claude | Cache-marker policy validated against the real V1 request shape              | 3–5 days                  |
| 3 | Gemini           | Passive first: identify family, preserve requests, confirm usage exposure    | 2–4 days                  |
| 4 | Qwen             | Passive first; mutation only if first-party docs + V1 path prove benefit      | 2–4 days                  |

Kimi goes first because the official Moonshot documentation describes cache
behavior for several distinct request shapes, so route identification is the
highest-value early task. Ship fewer providers rather than lowering the evidence
or test standard: a validated passive policy is preferable to an active mutation
based on assumptions.

### 2.2 Phase structure — release incrementally

Each provider has its own tests and acceptance criteria and can ship as soon as
it is validated; the four-provider set does not need to land in one release.

| Milestone         | Scope                   | Exit condition                                              |
|-------------------|-------------------------|-------------------------------------------------------------|
| `0.5.0`           | Kimi                    | API-path-specific policy, tests, usage validation, docs     |
| `0.5.1`           | Kimi maintenance        | Audit fixes and hardening (ratio guard, coverage)           |
| `0.5.2`           | Anthropic / Claude      | Passive policy validated against the V1 request shape (OpenCode owns the `cache_control` breakpoints) |
| `0.5.3`           | Gemini                  | Passive policy and usage-reporting behavior validated       |
| `0.5.4`           | Qwen                    | Passive policy and any justified request controls validated |
| `0.5.x` follow-up | Fixes and consolidation | Regressions fixed; docs and package contents verified       |

These are suggested version slots, not mandatory version numbers. If a provider
needs more investigation, skip it temporarily and continue with another.

### 2.3 Step 0 — Establish the working baseline

Do this on `master` before changing provider behavior.

```bash
git status --short --branch
git log -5 --oneline --decorate
git describe --tags --exact-match
npm test
npm pack --dry-run
```

Verify:

- You are on `master`, starting from the intended v0.4.13 baseline.
- The working tree is clean, or any existing changes are understood.
- All existing tests pass.
- The package tarball includes the intended runtime and documentation files.
- The current policy registry and V1 hooks are understood before editing.

Stop condition: if tests fail on the untouched baseline, establish whether that
is a pre-existing environment issue or a regression before adding features. Do
not mix baseline repair with a provider feature. Do not cherry-pick V2 adapter
changes into `master` just to start provider work; V1 provider work proceeds on
the current V1 architecture.

### 2.4 Step 1 — Kimi (0.5.0–0.5.1)

Official reference to verify: Moonshot AI, *Best practices for context caching*
(`https://www.kimi.ai/academy/best-practices-for-context-caching`).

The documentation describes cache behavior for both the Chat Completions and
Responses APIs, including `prompt_cache_options`, and separately an
Anthropic-compatible Messages path with top-level `cache_control`. These are
different request shapes and must not be collapsed into one universal Kimi
policy.

Implementation tasks:

1. **Identify the supported request path.** Inspect how OpenCode identifies
   provider and model; determine whether the target configuration uses
   Moonshot's native API, an OpenAI-compatible endpoint, an
   Anthropic-compatible endpoint, or a gateway such as OpenRouter. Record which
   request hooks and body shapes are available in the existing V1 plugin.
2. **Write a short evidence note before coding.** Exact provider id and model
   identifiers to match; API endpoint/request format; whether caching is implicit
   or needs an explicit control; supported cache options and TTL values; cache
   read/write usage fields; whether behavior differs by endpoint or model.
3. **Implement the smallest valid policy.** For a verified Chat Completions or
   Responses path, determine whether the documented `prompt_cache_options` is
   useful (the current Moonshot documentation describes implicit mode and `5m`
   or `1h` TTL options). Do **not** add Anthropic-style `cache_control` to the
   OpenAI-compatible request path. Do not apply Kimi-specific options to
   unrelated OpenAI-compatible providers. Preserve existing request options and
   headers.
4. **Validate usage accounting.** Confirm how OpenCode exposes Kimi cache-read
   tokens and whether the existing usage normalization already handles the
   response. If OpenCode normalizes usage into the existing token schema, do not
   add a second provider-specific parser.
5. **Test and document.** Correct provider/model match; no mutation for unknown
   Kimi models or unrelated providers; expected mutation for the verified path;
   existing usage accounting stays correct; document endpoint/model coverage,
   limitations, and evidence.

Acceptance criterion: Kimi-specific behavior is gated to the verified request
path, tests pass, and the implementation does not assume every Kimi endpoint uses
the same caching mechanism.

### 2.5 Step 2 — Anthropic / Claude (0.5.2)

Official reference to verify: Anthropic, *Prompt caching*
(`https://platform.claude.com/docs/en/build-with-claude/prompt-caching`).

Anthropic supports automatic caching via a top-level `cache_control` field and
explicit breakpoints on individual content blocks; the documented usage response
distinguishes cache reads from cache creation.

Implementation tasks:

1. **Inspect the V1 request pipeline** and establish whether Claude requests go
   through Anthropic's native Messages API, an OpenAI-compatible transformation
   layer, or a gateway such as OpenRouter.
2. **Confirm where the V1 hook can safely mutate the request.** Do not assume the
   same request shape is available across routes.
3. **Begin with the smallest safe strategy.** If the native request supports
   automatic caching and the hook can safely add its top-level field, evaluate
   that first. Otherwise investigate whether explicit content-block markers can be
   added without changing message semantics. Do not attach `cache_control` to
   arbitrary message objects or assume a compaction summary is a valid marker
   location.
4. **Verify breakpoint support and prefix stability.** Marker placement decides
   what content is cached; it is not a generic flag.
5. **Confirm usage exposure.** Check cache-read and cache-creation usage via
   OpenCode's normalized representation; do not change the shared accounting
   schema without a demonstrated normalization gap.

Required tests: native Anthropic requests receive only supported mutations;
non-Anthropic requests unchanged; unknown Claude request shapes left unchanged;
system prompts, messages, tools, and content blocks preserved apart from the
intended marker; cache read/write not double-counted; existing policies and V1
regressions stay green.

Acceptance criterion: the policy uses a verified Claude request path and a
documented cache-control mechanism. If the V1 hook cannot safely express the
required shape, document the limitation and defer the mutation rather than
introducing a brittle workaround.

### 2.6 Step 3 — Gemini (0.5.3)

Official reference to verify: Google AI, *Context caching*
(`https://ai.google.dev/gemini-api/docs/caching`).

Google documents implicit caching with model-specific minimum input sizes, and
cache-hit usage exposed through `usage.total_cached_tokens` in the documented
API response. Explicit cache-object management is a separate mechanism.

Implementation tasks:

1. Determine which Gemini API route OpenCode uses and how its response usage is
   normalized.
2. Add a passive policy for verified Gemini model identifiers.
3. Do not add cache keys, markers, or explicit cache objects unless the actual
   endpoint documents and requires them.
4. Verify the existing usage collector sees cache-hit data through OpenCode's
   normalized message representation.
5. If cache-hit data is missing, investigate the normalization boundary first; do
   not build a Gemini-specific parser until you establish OpenCode does not
   already normalize it.
6. Document that passive caching does not guarantee a hit; model eligibility,
   prefix stability, and minimum input requirements still apply.

Required tests: policy resolves for supported model identifiers; the passive
policy does not mutate the request; unrelated Google models and other providers
are unaffected unless explicitly covered; usage counted correctly when
cached-token data is present; missing cache-usage fields handled safely.

Acceptance criterion: Gemini is recognized and its cache usage accounted for
wherever existing OpenCode data makes that possible. No explicit cache-object
lifecycle management in this task.

### 2.7 Step 4 — Qwen (0.5.4)

Official reference to verify: Qwen Cloud, *FAQ — text generation*
(`https://docs.qwencloud.com/resources/faq-text-generation`).

Qwen's documentation describes implicit caching, explicit `cache_control`
markers, and a session-caching option for the Responses API, with differing
minimum token requirements and usage reporting. These strategies must not be
collapsed into one generic Qwen behavior.

Implementation tasks:

1. **Establish the actual Qwen route:** which provider id does OpenCode expose;
   is the endpoint Qwen Cloud, DashScope, OpenRouter, or another gateway; is the
   request Chat Completions, Responses, or something else.
2. Start with passive behavior if the endpoint supports implicit caching and
   requires no request mutation.
3. Add explicit markers or session-caching controls **only** if the official
   documentation covers the exact endpoint, the current V1 hook can express the
   required shape, there is clear benefit over passive behavior, and tests prove
   the mutation is correctly gated.
4. Verify cache-read usage fields through OpenCode's normalized response.
5. Document endpoint-specific differences; do not apply Qwen Cloud controls to
   every model whose name contains `qwen`.

Acceptance criterion: Qwen behavior is scoped to verified models and endpoints,
with no speculative cache-control mutations.

### 2.8 Shared test requirements for every provider

Add provider-specific tests in the existing test layout; there is no need to
reorganize the suite for this phase.

| Test                                       | Expected result                                       |
|--------------------------------------------|-------------------------------------------------------|
| Matching provider and model                | Correct policy resolves                               |
| Unknown model in the same family           | Neutral behavior unless explicitly covered            |
| Different provider with similar model name | No provider-specific mutation                         |
| Existing request options                   | Preserved                                             |
| Existing headers with different casing     | Not duplicated or overwritten unintentionally         |
| Passive caching                            | No unnecessary cache-control mutation                 |
| Usage fields absent                        | Safe handling, no invented cache hits                 |
| Cached-token usage present                 | Counted once through the existing normalization path  |
| Repeated idle / cursor missing             | Existing accounting guarantees preserved              |
| Existing policy regression suite           | All tests continue to pass                            |

For Anthropic and Kimi in particular, add tests for API-route differences: a
provider name alone is not evidence that all endpoints share one request schema.

### 2.9 Architecture: what to change now, and what to defer

Keep architecture work separate from provider additions.

**Do now, only when needed:** narrowly scoped policy entries and tests using the
existing registry and resolver. Add a small field only if a concrete provider
requires it.

**Keep on `feature/v2-adapter`:** V2 plugin loading, V2 hook mapping, and
runtime-specific integration. Provider policies continue to be developed and
tested on `master`.

**Defer:** a generic provider framework, large file moves, a full adapter
abstraction, and explicit cache-object lifecycle management. Do these only when
repeated real requirements justify them.

One architecture task stays in view: before the V2 adapter ports usage
accounting, identify which accounting functions can be extracted as pure,
runtime-neutral logic. Do it as a separately scoped task with tests that
preserve the existing cursor and watermark behavior. It should not block the four
provider tasks.

### 2.10 Branch and release workflow

Use a separate short-lived branch per provider if that fits your workflow:

```bash
git switch master
git pull --ff-only
git switch -c feature/provider-kimi
```

After implementation:

```bash
npm test
npm pack --dry-run
git diff --check
git status --short
git diff
```

Review the diff for unintended request mutations and unrelated refactors, and
merge only after the acceptance criteria pass. Repeat independently for Claude,
Gemini, and Qwen.

Keep `feature/v2-adapter` isolated. When a provider change introduces a genuinely
shared-core improvement that V2 will need, merge or cherry-pick that specific
reviewed change into the V2 branch and run its tests there; avoid routinely
merging half-finished provider branches into V2.

Before publishing each version, update the changelog and version as appropriate,
rerun the full suite, inspect the package contents, and verify documented
behavior matches the implementation.

### 2.11 Suggested schedule

Working days for a solo developer; research and implementation may overlap where
practical.

| Week | Work                                                                                    |
|------|-----------------------------------------------------------------------------------------|
| 1    | Baseline verification; Kimi route research, implementation, and tests                   |
| 2    | Finish Kimi validation and release; implement Claude                                     |
| 3    | Finish Claude; implement Gemini passive policy and usage checks                          |
| 4    | Implement Qwen passive policy; investigate any justified endpoint-specific controls      |
| 5    | Regression pass, documentation consolidation, packaging, release remaining validated work |

If time is limited, ship fewer providers rather than lowering the evidence or
test standard.

### 2.12 Definition of done for v0.5.x

- Kimi, Claude, Gemini, Qwen, xAI/Grok, Meta Muse, and MiniMax each have separate
  evidence notes and scoped policies.
- Each policy matches only the intended provider, model family, and API route.
- Every request mutation is supported by first-party documentation and tested.
- Cache read/write usage uses OpenCode's normalized data wherever available.
- Existing accounting behavior and regression tests remain intact.
- No pricing-boundary or context-limit enforcement has been added.
- No V2 runtime code has leaked into `master`.
- README or provider-policy documentation explains implemented coverage and
  limitations.
- `npm test`, `npm pack --dry-run`, and `git diff --check` pass.
- Each release contains only validated changes.

> **Historical note:** §2.2–§2.12 reflect the v0.5.x provider-coverage phase, which
> has **shipped** (see §2.0/§2.0b). The "recommended immediate task" below is
> retained as historical context only; the current next milestone is **§2B
> (v0.7.x)**.

Recommended immediate task: start with Kimi route research, then implement the
smallest verified Kimi policy on `master`. Keep Claude, Gemini, and Qwen as
separate follow-on tasks, not a single multi-provider patch.

## 2B. v0.7.x — Core contract, session-state model, and V2 readiness (planned)

> **Status: planned, not implemented.** This section specifies the next milestone
> so it can be executed as a sequence of small, independently verifiable tasks.
> Everything is a **proposal** unless labeled *verified*. Reading this section
> changes no code, version, tag, or release state.

### 2B.1 Objective

Establish and validate a **runtime-independent shared-core contract**, document
**session-state ownership and lifecycle**, and prepare for V2 integration
**without changing existing V1 behavior or prematurely claiming dual-runtime
support**.

Guiding rules (from `AGENTS.md`): audit before implementing; a validated
passive/spec outcome beats an unverified abstraction; fail closed on unknown
identity or behavior; keep each change narrow, deterministic, and tested; keep V1
stable on `master`; do not take V2 runtime dependencies on the V1 path; do not
build a generic plugin framework — define only interfaces justified by real
shared behavior.

### 2B.2 Verified starting point (v0.6.0)

Confirm this inventory in WP0 before doing anything else. *Verified* from the
v0.6.0 module exports; the full export lists are the audit subject of WP1.

| Module | Responsibility (verified) | Notable exports |
| --- | --- | --- |
| `src/cache-policy-core.mjs` | Pure policy classification + resolution | matchers `isGpt56OrLater`, `isDeepseekV4OrLater`, `isGlm53OrLater`, `isMimoAfterV26`, `isGemini25OrLater`, `isQwenModel`, `isGrokModel`, `isMuseModel`, `isMiniMaxModel`, `isOpenAIish`, `modelSignals`; `BASELINES`, `OVERLAYS`, `TRANSPORTS`, `POLICY_REGISTRY`, `MODEL_ALIASES`; `resolvePolicy`, `resolveRuntimePolicy`, `overlaysRegisteredForFamily`, `policyMatchCategory`, `explainPolicyResolution`, `resolveLegacyFamily` |
| `src/cache-engine-core.mjs` | Runtime-independent policy helpers, transforms, identity, diagnostics; re-exports the usage core | config (`CONFIG_FILENAME`, `DEFAULT_CONFIG_PATH`, `DEFAULT_METRICS_FILE`, `defaultConfig`, `expandHome`, `parseConfig`, `loadConfig`, `ensureMetricsDir`, `createRecorder`); `POLICY_*`, `GPT56_DEFAULT_TTL/MODE`, `GPT_KEY_MAX_LENGTH`; `canonicalStringify`, `detectPolicy`, `policyEnabled`; GPT helpers (`gptCacheOptionFieldNames`, `gptCacheOptionsDelta`, `resolveCacheRootSync`, `gptCacheKeyFor`); `relocateVolatileEnvBlock`; diagnostics (`commonPrefixLength`, `systemShapeHashes`, `normalizeTool`, `toolFingerprint`, `toolWireFingerprint`, `shapeDiff`, `shapeFieldDiffs`, `prefixChangeReasons`, `digestDecision`); identity/telemetry (`stableSessionIdFor`, `mimoSessionIdFor`, `isOpenRouterAffinityEligible`, `affinityTelemetryFields`, `providerChangeEvent`); reasoning (`detectReasoningIssues`, `reasoningEffortFromOptions`, `observeReasoningEffort`, `reasoningIssueReasons`) |
| `src/cache-usage-core.mjs` | Runtime-independent usage scanning/cursor/aggregation/ratios (`node:crypto` only) | `shorthash`, `hitRatePct`, `glmHitRatio`, `mimoHitRate`, `shouldAggregate`, `scanPage`, `nextProcessedCursor` |
| `src/cache-engine.ts` | **V1 adapter**: OpenCode `Plugin` (`CacheEngine`), client/session state, request mutation, event handling | Hooks: `chat.headers`, `chat.params`, `experimental.chat.system.transform`, `experimental.session.compacting`, `event` (`session.idle`) |
| `src/tui.mjs` | TUI entry (`./tui`); registers the plugin | default plugin object (no CacheEngine-specific UI/server behavior) |

Packaging (verified): `package.json` `files` = `["src/","README.md","LICENSE"]`;
exports = `./server` → `src/cache-engine.ts`, `./tui` → `src/tui.mjs`; no runtime
dependencies.

### 2B.3 Proposed increments

- **v0.7.0 — Core and adapter contract** (WP0 + WP1): inventory exports, define
  runtime boundaries, document inputs/outputs/side-effects, add only justified
  conformance tests.
- **v0.7.1 — Session-state model and lifecycle** (WP2): specify cursor/watermark
  semantics, compaction/pruning, duplicate prevention, session isolation, cleanup.
- **v0.7.2 or later — V2 readiness and compatibility verification** (WP4):
  validate the shared contract against verified V2 API behavior using isolated
  tests/fixtures. Do not label a skeleton as functional V2 support.
- **WP3 (conformance tests)** and **WP5 (docs/packaging)** thread through the
  increments rather than being separate releases.

These patch assignments are **proposals** and may change based on audit findings.
Do not create artificial work to fill release slots.

### 2B.4 Work packages

Each work package below lists: objective/rationale; current-state evidence; ordered
steps; files expected to change (**provisional**); dependencies; required tests;
acceptance criteria; stop conditions/rollback; an effort **estimate** (not a
commitment); and explicit exclusions.

#### WP0 — Baseline and scope lock

- **Objective / rationale:** Fix the starting revision, tests, packaging, and
  compatibility baseline so v0.6.0 work is not repeated and drift is caught early.
- **Current-state evidence / inspect:** `git rev-parse HEAD`, `git describe --tags
  --exact-match`, `git log -5 --oneline --decorate`, `git status --short --branch`,
  `npm test`, `npm pack --dry-run`, `git diff --check`. Expected: tag `v0.6.0` =
  `c1f3420`; `package.json` version `0.6.0`; tree clean except the untracked,
  pre-existing `package-lock.json`.
- **Ordered steps:** run the commands; record the results; confirm no unexplained
  working-tree changes; confirm the §2B.2 module inventory; confirm
  `feature/v2-adapter` is untouched (`git log` it read-only).
- **Files expected to change (provisional):** none — this is a verification gate.
- **Dependencies / sequencing:** first; everything else depends on it.
- **Required tests:** full `npm test`; `npm pack --dry-run`; `git diff --check`.
- **Acceptance criteria:** the commands succeed and the observed commit/tag/tree
  match expectations, or any discrepancy is documented and resolved before
  proceeding (e.g. an authorized post-tag docs commit on `master`).
- **Stop conditions / rollback:** if the baseline is inconsistent or there are
  unexplained changes, stop and report. Do **not** repair unrelated pre-existing
  problems here.
- **Effort estimate:** 0.5–1 day *(estimate)*.
- **Exclusions:** no code changes; no provider work; no release operations.

#### WP1 — Shared-core and runtime-adapter contract

- **Objective / rationale:** Document module responsibilities and boundaries, plus
  the future V2 adapter's translation role, so shared logic has a stable, tested
  contract — without building a framework.
- **Current-state evidence / inspect:** the §2B.2 modules; every `import`/`export`/
  re-export site; the hooks in `src/cache-engine.ts`; the imports in
  `test/cache-engine.test.mjs`.
- **Ordered steps:**
  1. Enumerate every export of the three `.mjs` modules and every caller (search
     `src/` and `test/`).
  2. Classify each export: pure function; stateful helper; constant/registry;
     config/IO helper.
  3. Define, per module, inputs, outputs, side effects, error handling, and
     mutation boundaries.
  4. Define the V1-adapter responsibilities: which OpenCode hooks it registers,
     what runtime state it owns, which requests it may mutate, and which it must
     never mutate.
  5. Define the **future V2 adapter** responsibilities as a translation layer:
     verified V2 events → shared-core inputs; shared-core outputs → V2 request
     mutations. Mark every V2 API name *unverified* until WP4.
  6. Add conformance tests for observable contracts (WP3); where a contract is
     currently implicit, prefer documenting it over adding code.
- **Files expected to change (provisional):** `docs/implementation-plan-v2.md`
  and/or a new `docs/architecture-core-contract.md`; `test/cache-engine.test.mjs`.
  **No source change is expected**; a source change is justified only if the audit
  finds a real shared behavior the current exports cannot express.
- **Dependencies / sequencing:** after WP0; independent of WP2; feeds WP4.
- **Required tests:** the WP3 contract tests; full `npm test`.
- **Acceptance criteria:** the contract is documented with observable, testable
  statements; every shared export is classified; the V1-adapter boundary is
  stated; no unverified V2 API is presented as fact; tests pass.
- **Stop conditions / rollback:** if the audit shows a genuine abstraction is
  required, stop and propose it as its own scoped task rather than implementing it
  mid-milestone; revert to documentation-only if a code change would alter V1
  behavior.
- **Effort estimate:** 2–4 days *(estimate)*.
- **Exclusions:** no generic plugin framework; no file moves/renames; no new
  runtime dependency; no provider behavior change.

#### WP2 — Session-state model and lifecycle

- **Objective / rationale:** Make the stable-identity vs transient-progress
  distinction explicit, preserve verified V1 invariants, and specify cleanup —
  without a new state abstraction unless the audit proves one is needed.
- **Current-state evidence / inspect:** per-session state in `src/cache-engine.ts`
  (cursor/watermark, serialized collection); `src/cache-usage-core.mjs`
  (`scanPage`, `nextProcessedCursor`); identity helpers (`stableSessionIdFor`,
  `mimoSessionIdFor`, `gptCacheKeyFor`); the `session.idle` aggregation path.
- **Verified V1 invariants to preserve (from `AGENTS.md` / observed runtime):**
  - `client.session.messages` returns messages **oldest-first** (chronological;
    `time.created` non-decreasing) — **not** newest-first.
  - Accounting keeps the newest processed message ID (`lastProcessedMessageID`)
    plus a `lastProcessedAt` watermark; it counts assistant messages after the
    cursor and **falls back to the watermark** when the cursor id is
    pruned/reverted.
  - Cursor-based processing avoids double-counting; with no safe boundary it
    undercounts (counts nothing) rather than fabricating a boundary.
  - Compaction must never cause usage to be counted twice.
  - Cache identity and compaction namespaces retain existing semantics
    (`<root>:compact`).
  - Do not reintroduce a newest-first or "stop at the cursor scanning from the
    top" assumption.
- **Ordered steps:**
  1. Document stable session identity vs transient collection progress (two
     concepts, different lifetimes).
  2. Document the cursor/watermark algorithm exactly as implemented, including the
     fallback rule and the undercount-not-fabricate rule.
  3. Document session isolation (per-session state; concurrent `session.idle`
     serialization) and duplicate-prevention guarantees.
  4. Investigate the cleanup lifecycle **separately for V1 and V2**; do not assume
     an event exists because §9 mentions it.
  5. Specify edge cases: empty sessions, repeated scans, missing timestamps,
     pruned/reverted cursors, compacted histories, session isolation.
  6. Only if the audit proves the existing helpers cannot express a required
     contract, specify (do not implement) a minimal new abstraction and its tests.
- **Files expected to change (provisional):** `docs/implementation-plan-v2.md`
  and/or a session-state spec doc; `test/cache-engine.test.mjs`. Source changes
  only if the audit proves necessity.
- **Dependencies / sequencing:** after WP0; may proceed in parallel with WP1; feeds
  WP4.
- **Required tests:** the edge-case set above asserting no double count, safe
  undercount, correct cursor advance, and session isolation.
- **Acceptance criteria:** the model is documented; every listed invariant has a
  test or is marked *unverified*; no new abstraction without an audit
  justification; tests pass.
- **Stop conditions / rollback:** if a proposed abstraction would change accounting
  semantics, stop; do not add it. Rollback = documentation-only.
- **Effort estimate:** 2–4 days *(estimate)*.
- **Exclusions:** no changes to thresholds, context limits, or token budgets; no
  compaction continuation behavior change; no V2 runtime code.

#### WP3 — Shared-core conformance tests

- **Objective / rationale:** Lock observable contracts with tests that would fail
  if behavior drifts.
- **Current-state evidence / inspect:** the existing suite
  (`test/cache-engine.test.mjs`, 277 tests at v0.6.0) and the v0.6.0 conformance
  matrix.
- **Ordered steps:** enumerate contracts; for each, add a test asserting observable
  behavior (not internal structure); keep the existing test-file layout.
- **Required test areas:**
  - Policy resolution and preservation of current policy behavior.
  - Passive/neutral policies leaving requests unchanged.
  - Existing-value preservation and deterministic identity.
  - Missing usage fields remaining missing (never fabricated, never converted to
    zero).
  - Cursor progression and duplicate prevention.
  - Runtime-independent shared-core imports (the usage/policy modules import no
    OpenCode client, hook, routing, or V2 module).
  - Errors failing safely without retries or unintended request mutations.
- **Files expected to change (provisional):** `test/cache-engine.test.mjs`.
- **Dependencies / sequencing:** alongside WP1/WP2.
- **Required tests:** the tests themselves; full `npm test`.
- **Acceptance criteria:** new tests pass and assert observable contracts, not
  implementation internals; `npm test` green.
- **Stop conditions / rollback:** if a test can only pass by changing runtime
  behavior, stop — the test is wrong, not the code (do not fix code to satisfy a
  test in this milestone).
- **Effort estimate:** 2–3 days *(estimate)*.
- **Exclusions:** no new test framework or dependency; no suite reorganization.

#### WP4 — V2 readiness and API verification

- **Objective / rationale:** Verify the V2 contract from authoritative API docs or
  installed-runtime evidence before any V2 code, and map verified events to
  shared-core inputs/outputs.
- **Current-state evidence / inspect:** the protected `feature/v2-adapter` branch
  (read-only; **do not modify, merge, cherry-pick, or rebase**); the historical
  hook references in §6 and §9 (`context`, `model.request`, `compaction`,
  `Plugin.define`, `ctx.location.*`) are **hypotheses** until verified.
- **Ordered steps:**
  1. Identify the authoritative V2 API source (official docs and/or the installed
     runtime's plugin type definitions).
  2. For each candidate event, verify existence, payload shape, and mutation
     semantics.
  3. Document the mapping: verified event → shared-core input; shared-core output
     → V2 request mutation.
  4. Document missing information required for V1/V2 parity and any lifecycle
     limitations.
  5. Build isolated fixtures/mocks and write tests exercising the mapping without
     a live runtime.
  6. If the runtime contract cannot be verified, document the blocker and defer
     the affected implementation.
- **Files expected to change (provisional):** `docs/implementation-plan-v2.md`
  and/or a V2 contract doc; test fixtures/mocks.
- **Dependencies / sequencing:** needs WP1/WP2 outputs; must not touch
  `feature/v2-adapter`.
- **Required tests:** fixture/mock-based mapping tests; an explicit blocker test
  or documented deferral when unverified.
- **Acceptance criteria:** every claimed V2 event is backed by a cited
  authoritative source or installed-runtime evidence, or is explicitly marked
  *unverified/deferred*; the mapping is documented; no "functional V2 adapter"
  claim is made.
- **Stop conditions / rollback:** if the contract cannot be verified, stop and
  defer; never guess field names; never modify the protected branch.
- **Effort estimate:** 3–6 days *(estimate; depends entirely on accessible
  evidence)*.
- **Exclusions:** no V2 adapter implementation; no branch operations; no
  dual-runtime claim.

#### WP5 — Documentation, packaging, and release readiness

- **Objective / rationale:** Keep docs and packaging consistent, and make release a
  separate, authorized step.
- **Current-state evidence / inspect:** `docs/implementation-plan-v2.md`,
  `AGENTS.md`, `README.md`, `package.json` (`files` = `src/`, README, LICENSE;
  exports `./server`, `./tui`).
- **Ordered steps:** update this plan and any contract/session docs; confirm
  `npm pack --dry-run` contents (8 files, `src/` only) are unchanged unless an
  authorized source move occurs; run final validation.
- **Files expected to change (provisional):** documentation only. Any runtime-file
  move/rename must also update `AGENTS.md` "Ownership and runtime" and the
  `package.json` `exports` + `files` in the same change, validated with
  `npm pack --dry-run` (per `AGENTS.md`).
- **Dependencies / sequencing:** last.
- **Required tests:** `npm test`; `npm pack --dry-run`; `git diff --check`;
  working-tree review.
- **Acceptance criteria:** docs consistent with the shipped state; packaging
  validated; **no** version change, commit, tag, push, or publish without separate
  explicit authorization.
- **Stop conditions / rollback:** not applicable — release actions are simply not
  taken in this milestone.
- **Effort estimate:** 1–2 days *(estimate)*.
- **Exclusions:** version bump, tags, publishing, CI systems.

### 2B.5 Scope and non-goals

v0.7.x does **not** include:

- New provider support or speculative provider-policy changes.
- Mistral implementation without a completed audit-first evidence note.
- Pricing or context-limit enforcement.
- Prompt, reasoning, credential, authentication-header, or full request-body
  telemetry.
- A V2-only rewrite or the removal of V1 support.
- A claim of complete dual-runtime support.
- A large generic abstraction/refactor without demonstrated need.
- Any change to the protected `feature/v2-adapter` branch.
- Package-version changes, commits, tags, pushes, or publication without
  authorization.

The **provider invariants** in `AGENTS.md` remain binding: DeepSeek, GPT-5.6,
GLM-5.3, MiMo-V2.6, OpenRouter affinity, Grok, Meta Muse, and MiniMax behavior
must not change.

### 2B.6 Testing and acceptance matrix

| # | Stage | Approach | Exit criterion |
| --- | --- | --- | --- |
| 1 | Baseline test run | `npm test` | All pass; no regression vs v0.6.0 |
| 2 | Focused core-contract tests | Targeted contract tests | Pass |
| 3 | Session-state / cursor / compaction tests | Edge-case tests (WP2) | Pass; invariants hold |
| 4 | Provider regression tests | Existing provider conformance matrix | Pass |
| 5 | Runtime-isolation tests | Assert the usage/policy modules import nothing from OpenCode/V2 | Pass |
| 6 | V2 contract verification | Fixtures + cited evidence, or a documented blocker | Verified-mapped **or** explicitly deferred |
| 7 | `npm pack --dry-run` | Inspect tarball contents | 8 files, `src/` only (unchanged) |
| 8 | `git diff --check` | Whitespace/conflict check | Clean |
| 9 | Final review | Working-tree + diff review | Only intended files changed |

The repository uses Node's built-in test runner and has **no** configured build,
lint, or typecheck scripts. Do **not** introduce a bundler, TypeScript compiler,
dependency, or CI system merely to satisfy a generic checklist.

**Live-model probes are optional and are not a release blocker for this
architecture milestone.** Any live probe must have a verified plugin version, a
clear cost/budget understanding, minimal synthetic inputs, and explicit
authorization where required. Never use long prefixes or repeated requests to
chase cache hits, and never treat a cache-write count as proof of a cache hit.

**Exit criteria:** each increment's acceptance criteria are met. The milestone as
a whole exits when the core contract and session-state model are documented and
tested, V2 readiness is either verified-mapped or explicitly deferred, V1 behavior
is unchanged, and stages 1–9 above are green.

### 2B.7 Dependencies and open questions

Dependency order: WP0 → {WP1, WP2} → WP4 → WP5, with WP3 alongside WP1/WP2. The
milestone precedes the functioning V2 adapter (v0.8.x).

**Unverified / unresolved (do not present as fact):**

- The V2 plugin API surface (`context`, `model.request`, `compaction`,
  `Plugin.define`, `ctx.location.*`) is historical plan text — **unverified**
  against the actual target API. WP4 must confirm it.
- Whether a V2 session-messages equivalent returns messages oldest-first, and
  whether a V2-side cursor/watermark source exists.
- Whether V2 exposes a `session.idle`-equivalent or other lifecycle/cleanup event.
- Whether the installed V1 runtime supplies the exact `promptCacheKey` /
  `promptCacheOptions` shape assumed here (see the `RF-OC-*` findings in
  `docs/research-findings.md`).
- All effort figures are **ranges/estimates**, not commitments.

### 2B.8 v0.7.0 — implemented contract (audit result, 2026-10-09)

**Status:** the v0.7.0 **contract** portion (WP1) is implemented as
**documentation + tests only**. The audit found **no shared-core/runtime-coupling
violation**, so no source change was made (per the rule: if the code already
satisfies the requirement, document it and leave it unchanged). Session-state
lifecycle (WP2) remains **v0.7.1** and V2 readiness (WP4) remains **v0.7.2+**. No
dual-runtime support is claimed.

**Audit result (verified against the v0.6.0 source):**

- `src/cache-policy-core.mjs`, `src/cache-engine-core.mjs`, and
  `src/cache-usage-core.mjs` import only `node:*` builtins and sibling shared
  `.mjs` modules — no `@opencode-ai/*`, no hook registration, no OpenCode
  client/session access, no V2 dependency. (`cache-engine-core.mjs` uses
  `node:fs` for config/metrics IO, which is runtime-independent.)
- No function is defined twice across the modules; the usage functions live only
  in `cache-usage-core.mjs` and are re-exported (identical bindings) by
  `cache-engine-core.mjs`.
- The only OpenCode-runtime code is `src/cache-engine.ts` (the V1 adapter), which
  registers the hooks and performs client calls.
- `cache-policy-core.mjs` `OVERLAYS` entries carry a declarative `hook:` name
  string (e.g. `"chat.params"`); this is **metadata, not coupling** — the adapter
  does not read `overlay.hook` and instead drives behaviour from
  `resolveRuntimePolicy(model)`.

**Contract A — Policy resolution.** Inputs: a model descriptor
`{ providerID, id, api: { id, npm } }`. Owner: `cache-policy-core.mjs`
(`resolvePolicy` → the full result; `resolveRuntimePolicy` → the `runtime`
descriptor). Output: a `policy` family string
(`deepseek|gpt56|glm53|mimo26|kimi|claude|gemini|qwen|grok|muse|minimax|neutral`)
plus the plain-data capability object. Missing/unknown provider identity resolves
to `neutral` (fail-closed — no mutation). The adapter does not re-classify or hold
a second registry; it calls the resolver and branches on the returned
capabilities.

**Contract B — Shared transformations & identity.** Pure helpers:
`canonicalStringify`; the prefix/tool diagnostics (`commonPrefixLength`,
`systemShapeHashes`, `normalizeTool`, `toolFingerprint`, `toolWireFingerprint`,
`shapeDiff`, `shapeFieldDiffs`, `prefixChangeReasons`, `digestDecision`);
`relocateVolatileEnvBlock` (returns a new string; content-preserving); and the GPT
option deltas (`gptCacheOptionFieldNames`, `gptCacheOptionsDelta`) which compute a
*delta* the adapter applies. Identity: `stableSessionIdFor` (`oc-ses-<sha256>`),
`mimoSessionIdFor` (`mimo-ses-<16hex>`), `gptCacheKeyFor` / `resolveCacheRootSync`
— deterministic and non-secret, and they never mutate a harness-owned key.
Eligibility: `isOpenRouterAffinityEligible(policyFamily, providerID)` is `true`
only for GLM/MiMo with `providerID === "openrouter"`; `affinityTelemetryFields`
classifies eligible/attached/bypassed/missing. Ineligible or ambiguous input is
returned unchanged (`<env>` relocation is a no-op unless exactly one eligible
marker block is present). The adapter applies provider mutations at the hook
points; the shared core never registers hooks.

**Contract C — Usage/accounting.** Owner: `cache-usage-core.mjs`.
`scanPage(page, startCursor, sinceCreated)` reads chronological assistant messages
and returns `{ read, write, input, lastCursor, maxCreated }`;
`nextProcessedCursor(page, startCursor)` advances the cursor; `shouldAggregate`,
`hitRatePct`, `glmHitRatio`, `mimoHitRate`, `shorthash` provide eligibility,
ratios, and the shared digest. Missing usage stays missing (never fabricated; no
zero-usage record on idle). Cursor/watermark semantics (newest processed id +
timestamp watermark; undercount-not-fabricate; no double count) are unchanged.
`cache-engine-core.mjs` re-exports these seven functions identically for
compatibility.

**Contract D — Runtime adapter boundary (V1, `cache-engine.ts`).** Owns:
(1) receiving hooks/events (`chat.headers`, `chat.params`,
`experimental.chat.system.transform`, `experimental.session.compacting`, and
`event` / `session.idle`); (2) obtaining runtime data via the OpenCode client
(`client.session.*`); (3) calling shared-core functions; (4) applying verified
mutations at the hook points; (5) collecting provider-reported usage via the
accounting helpers; (6) emitting telemetry under the existing privacy/schema
rules. These cannot move into the shared core because they require the OpenCode
client, session state, and hook registration. No V2 event types are defined here.

**Contract E — Error / unknown input.** Unknown provider/model → neutral (no
mutation). Missing provider identity → fail closed. Missing usage fields → left
missing. Ineligible/malformed transformation input → returned unchanged.
Missing/pruned cursor with no safe boundary → undercount (count nothing), never
fabricate. No retry loops, synthetic records, or assumed cache hits.

**Implemented artifacts (this milestone):** four contract tests in
`test/cache-engine.test.mjs` — shared-core import isolation; adapter
hook-registration ownership; full re-export single-definition contract;
`resolveRuntimePolicy` capability-shape contract. Suite: **277 → 281**. No source
change (audit found no boundary violation).

**Deferred:** session-state lifecycle/cleanup model (**v0.7.1**, WP2);
V2 API verification/mapping (**v0.7.2+**, WP4); functioning V2 adapter
(**v0.8.x**).

**Acceptance (v0.7.0):** boundary documented (above); every contract statement
supported by current code or tests; exports/re-exports compatible; shared usage
core runtime-independent (test); V1 owns hooks/client/state (test); provider
behavior unchanged (existing suite); new tests pass; `npm pack --dry-run` and
`git diff --check` clean.

## 3. Branch Strategy

Use Git branches for parallel development:

- **`main` (alias `master`):** The primary development branch. Contains V1-compatible shared core and policies. Releases (e.g., 0.5.x, 0.6.x, etc.) are merged/tagged here.
- **`feature/v2-adapter`:** Development of the OpenCode V2 adapter. Branch off from `main` at the current v0.4. baseline. Merge changes *from* `main` into `feature/v2-adapter` as needed; do not merge `v2-adapter` *into* `main` until feature complete.
- **`feature/provider-<name>` (optional):** For each major provider (e.g. `feature/provider-kimi`), implement the new cache policy and tests. Once done, merge into `main`.
- **`release/x.y.z` or `main` tags:** Tag release versions after QA.

No V2-related code goes into `main` until the integration phase. V1 maintenance and new provider work proceed on `main`; V2 adapter evolves on its own branch.

## 4. Detailed Task List

> **Historical (v0.4.x–v0.6.x era).** The provider rows are shipped and the 0.6.x
> rows are done; the V2-adapter rows reference an **unverified** API and are
> superseded for milestone scope by **§2B**. Retained for context.

Each task below includes priority, assigned role(s), effort, and dependencies.  Effort is rough (days) per developer.

| Task (Milestone)                                     | Priority | Owner(s)           | Effort | Dependencies                          | Acceptance Criteria                         |
|------------------------------------------------------|---------|--------------------|-------:|---------------------------------------|---------------------------------------------|
| **Provider Strategies (0.5.x & 0.6.x)**              |         |                    |        |                                       |                                             |
| - Integrate **Kimi** (route-scoped: `prompt_cache_options` on Chat/Responses vs `cache_control` on the Anthropic-compatible path) | High | policy-dev | 2–4d after research | none (first task in §2) | Route identified and recorded; policy gated to the verified request path; no `cache_control` on the OpenAI-compatible path; usage accounted; tests pass. |
| - Integrate **Anthropic (Claude)** (top-level `cache_control` / explicit breakpoints) | High | policy-dev | 3–5d | none | Policy uses a verified Claude request path and a documented cache-control mechanism; non-Anthropic requests untouched; read/write usage not double-counted. |
| - Integrate **Google Gemini** (passive/implicit) | Medium | policy-dev | 2–4d | none | Gemini models recognized; no request mutation; cache-hit usage accounted through existing normalization. Tests pass. |
| - Integrate **Qwen** (passive first; markers only if justified) | Medium | policy-dev | 2–4d | none | Qwen behavior scoped to verified models/endpoints; no speculative cache-control mutations. Tests pass. |
| - **Deferred candidate**: Mistral | Low | policy-dev | 2–3d | optional | Tracked for a later phase; requires its own audit-first evidence note. xAI/Grok, Meta Muse, and MiniMax are implemented (§2.0). |
| - **Policy Registry Update:** encode new families, strategies | High    | maintainer/policy-dev | 2d    | above provider tasks complete         | Shared `cache-policy-core` updated with new entries. No compile/test failures. |
| - **Policy Conformance Tests:** Add generic tests (unknown models, no double-count, etc.) | High    | QA                 | 2d    | above policies                        | All provider strategies pass new and existing tests. |
| **Core Refactoring (0.6.x, not 0.5.x)**              |         |                    |        |                                       |                                             |
| - **Cache Identity Abstraction** (AUDITED — no change): existing `stableSessionIdFor`/`mimoSessionIdFor`/`gptCacheKeyFor` suffice | Medium  | adapter-dev/maintainer | 1d | none             | DONE: audited; deterministic per-session ids already exist. No speculative abstraction added, and identity never mutates a harness-owned key. |
| - **Extract Usage Accounting** (DONE — v0.6.x): `cache-usage-core.mjs` created (scanPage/nextProcessedCursor/shouldAggregate/ratios; `shorthash`) | High | adapter-dev        | 2d    | none                                  | DONE: usage logic lives in a pure, runtime-independent module re-exported by `cache-engine-core.mjs`; the V1 adapter and tests are unchanged and pass. |
| - **Define Adapter Interface:** draft TypeScript interface for runtime adapter (hooks, context, messages, etc.) | High  | adapter-dev       | 1d    | none                                  | An interface (or abstract class) like `OpenCodeRuntime` defined; V1 and V2 adapters use it. |
| - **Session State Model:** Define `SessionState` shape, store (Map or storage) | Medium  | adapter-dev        | 2d    | none                                  | Session state fields (lastID, lastAt, etc.) formalized. Memory usage bound checks. |
| **Testing & QA**                                     |         |                    |        |                                       |                                             |
| - **Unit Tests:** Write/extend tests for new policies and refactors | High    | QA                 | 3d    | above tasks                          | `npm test` shows 100% pass, no regressions. Coverage report. |
| - **Integration Tests:** CI pipeline tests for both V1 and V2 (once V2 implemented) | Medium | QA                 | 2d    | V2 adapter base ready                | CI script runs OpenCode harness against both runtimes without errors. |
| - **Live Probes:** Small real OpenCode runs (cold/warm) with a validated provider (e.g. Kimi or Claude) | Low | QA | 1d | that provider merged | Live usage files show expected read/write tokens, provider attribution correct. |
| **V2 Adapter (0.7.x–0.8.x)**                         |         |                    |        |                                       |                                             |
| - **V2 Plugin Setup:** Create `cache-engine-v2.ts` with `Plugin.define({id,setup})`  | High  | adapter-dev        | 2d    | Adapter interface defined            | Builds and loads in V2: logs to console on startup. |
| - **Context Hook (chat.params)**: Port setting of model options (e.g. cache key) to `ctx.session.hook("context", …)` | High  | adapter-dev        | 2d    | policy registry support             | V2 `context` hook sets event.options, e.g. promptCacheKey or provider-specific. |
| - **Model Request Hook (chat.headers)**: Port headers to `ctx.session.hook("model.request")` | High | adapter-dev      | 2d    | above                               | V2 model.request hook adds verified headers (e.g. `x-session-id`) as needed. |
| - **Compaction Hook:** Use `ctx.session.hook("compaction")` for compaction events  | Medium | adapter-dev        | 2d    | session state model defined         | Compaction trigger leads to same accounting behavior as V1. Test simulation works. |
| - **TUI/CLI Integration:** Confirm `./server` and `./tui` exports for both runtimes (V2 CLI plugin) | Low    | maintainer         | 1d    | V2 adapter mostly done             | OpenCode V2 CLI recognizes plugin, without altering V1 usage. |
| **CI / Packaging / Release**                         |         |                    |        |                                       |                                             |
| - **Package Exports:** Update `package.json` exports to include both V1 and V2 entrypoints (e.g. `"./cache-engine"` and `"./cache-engine-v2"` keys) | High    | maintainer         | 1d    | V2 adapter entrypoint done         | `npm pack` yields one tarball with both adapters. No extra files. |
| - **Version Bump & Tags:** Plan for releasing 0.5.x, 0.6.x... leading to 1.0.0. | Medium | maintainer         | 0.5d  | release criteria met                | Tags and changelog prepared. |
| - **CI Pipeline:** Ensure Travis/GitHub Actions runs tests on every branch, and `npm pack --dry-run` on releases. | High    | maintainer/QA      | 1d    | none                               | Automated CI passes; no bundling errors; version consistency check. |

*Role Legend:*
- **Maintainer:** Oversees code reviews, infrastructure, releases.
- **Adapter-dev:** Focuses on runtime adapter code (both V1 hooks and new V2 adapter).
- **Policy-dev:** Implements provider-specific cache strategies.
- **QA:** Creates tests, runs live validations, and ensures overall quality.

**Dependencies:** Most provider tasks depend only on research and existing core logic. Core refactors should await initial provider policy definitions to know what needs extracting. The V2 work depends on adapter interface and the new context/request hook mappings being defined. Release tasks require all feature tasks complete.

## 5. File-Level Refactor Plan

> **Historical/illustrative.** The `cache-engine-v1.ts` / `cache-engine-v2.ts`
> names and snippets are proposals, not current files, and are **unverified**. The
> runtime-adapter contract is now scoped in **§2B**. The only part already done is
> the accounting move into `src/cache-usage-core.mjs`.

Organize files to separate the shared policy/logic from runtime-specific code:

- **`src/cache-policy-core.mjs`:** *Unchanged.* Contains provider policy registry and resolution. Update to add the v0.5.x providers (Kimi, Anthropic/Claude, Gemini, Qwen) as each is validated.
- **`src/cache-engine-core.mjs`:** *Modify.* Extracted shared logic (accounting, aggregation, session state helpers). Introduce clear exports for core functions (e.g. `collectUsage`, `resolvePolicy`).
- **New `src/cache-usage-core.mjs`:** Migrate all usage/aggregation routines here (formerly in cache-engine-core). Expose functions like `scanPage(page, startCursor, sinceCreated)`, returning {read, write, input, lastCursor, maxCreated}.
- **`src/cache-engine-v1.ts` (rename):** Convert existing `cache-engine.ts` into a V1 adapter module. This becomes the entrypoint for OpenCode V1 (exported under `"./server"` in package.json). It calls shared core functions and uses `client.session.*` V1 APIs.
- **`src/cache-engine-v2.ts` (new):** V2 adapter module. Example snippet:

```typescript
import { Plugin } from "@opencode/plugin";
import { onSessionContext, onModelRequest, onCompaction } from "./cache-engine-core.mjs";

export default Plugin.define({
  id: "cache-engine",
  async setup(ctx) {
    // Hook into session context (similar to V1 chat.params)
    ctx.session.hook("context", (event) => {
      // e.g. set event.options.cacheRootKey or reasoning params
      // Use shared functions from core, e.g. resolvePolicy(event)
      onSessionContext(event, ctx.location.sessionId, ctx);
    });
    // Hook into model.request headers (V1 chat.headers)
    ctx.session.hook("model.request", (event) => {
      onModelRequest(event, ctx.location.sessionId);
    });
    // Hook into compaction (if supported)
    ctx.session.hook("compaction", (event) => {
      onCompaction(event, ctx.location.sessionId);
    });
  }
});
```

*(Above is illustrative; finalize methods/names as per core exports.)*

- **`src/tui.ts`**: *Verify.* Ensure TUI (console) behavior remains compatible and calls into shared core the same way for either runtime (likely unchanged).
- **`test/`**: Extend with new files:
  - Provider tests in the existing `test/cache-engine.test.mjs` layout (per §2.8); do not reorganize the suite for this phase.
  - Add tests simulating V2 context and model.request hooks if possible (using the OpenCode testing harness or mocking `ctx`).

Changes summary:
- **Move (DONE — v0.6.x)**: accounting pulled out of `cache-engine-core.mjs` into `cache-usage-core.mjs` (re-exported for compatibility).
- **Create**: `cache-engine-v2.ts`.
- **Modify**: Export adapter interface from `cache-engine-core.mjs` so both adapters can use it.
- **Snippet (policy lookup example):**

```js
// In cache-policy-core.mjs
export const cachePolicies = {
  // Field names below are ILLUSTRATIVE placeholders. Real values must come from
  // first-party provider docs and be recorded before implementation (see §2).
  // As shipped on master (v0.5.x), kimi and anthropic are PASSIVE: OpenCode /
  // Moonshot own the cache behavior, so CacheEngine only classifies + accounts.
  kimi:    { strategy: "passive", field: null },
  anthropic: { strategy: "passive", field: null },
  // ...
};
// Usage:
function resolvePolicy(provider, model) {
  // return the matching policy object
}
```

- **Adapter interface (example methods in core):**

```ts
// In cache-engine-core.mjs
export function resolvePolicy(client, model) {
  // determine policy based on client.provider or similar
}
export function collectUsage(messages, state) {
  // as currently implemented (cursor handling)
}
export function scanPage(page, startCursor, since) { ... }
```

Both V1 and V2 adapters will import and call these.

## 6. Runtime Adapter Interface and Policy Schema

> **Illustrative/unverified.** The `context` / `model.request` / `compaction` hook
> names and `ctx.*` shapes are hypotheses until **WP4** verifies them against the
> actual V2 API. Do not implement from this section. See **§2B**.

Define interfaces for the shared core and how adapters use them:

```ts
// AdapterRuntime (pseudo-interface):
interface AdapterRuntime {
  session: {
    hook(event: "context"|"compaction"|"model.request", handler: (event: any) => void): void;
    messages(opts: {path: {id: string}}): Promise<{data: Message[]}>;
  };
  storage: StorageAPI;
  // Other needed domains (e.g. console, location)
}

// Usage event for context hook:
interface SessionContextEvent {
  system: Array<{type:"text", text: string}>;  // system prompt blocks
  messages: Array<{role:string, content:string}>; // chat history
  options: { headers?: Record<string,string>, [key:string]: any };
  location: { sessionId: string };
}
```

Policy registry schema example (YAML-like):

```yaml
policies:
  kimi:
    matcher: "<verified model pattern>"
    # strategy + fields decided per API route in §2; do not pre-assume.
    telemetry:
      usageField: "<verified field>"
  anthropic:
    matcher: "claude-.*"
    strategy: active-marker
    controlField: "cache_control"
    telemetry:
      usageField: "input_tokens_details.cached_tokens"
  gemini:
    matcher: "gemini-.*"
    strategy: passive  # v0.5.x: recognize + observe, no mutation
  qwen:
    matcher: "qwen-.*"
    strategy: active-marker
    # control and TTL defined per Qwen docs (e.g. min tokens 1024, block tokens)
```

*(These are illustrative. Use JSON or actual config format as needed. Ensure patterns match actual model names.)*

## 7. Testing Matrix

**Unit Tests:** For each core function and policy:

- **Cache identity resolution:** test various `sessionId` strings produce expected keys.
- **Usage aggregation:** simulate pages of messages (with/without `time.created`) to test no-duplication, compaction case, empty pages, etc.
- **Policy selection:** given fake `provider` and `model` inputs, ensure correct strategy and fields.

**Integration Tests:** Mock the OpenCode runtime:

- Use a *fake-client* pattern (like jest spies on `client.session.messages`) to simulate V1 calls. For V2, simulate calling the setup hooks with a dummy `ctx` object to ensure they invoke core functions correctly.
- For each provider policy, create a synthetic conversation and verify that caching logic produces expected read/write counts and sets appropriate request fields.

**Live-Model Probes:** Use real API keys (with the cheapest available dev endpoint for the provider under test) to run minimal two-turn sessions:

- Cold run: prime with a known prompt/prefix.
- Warm run: same prompt, ensure `tokens.cached` > 0 as expected.
- Tools: run `opencode run -m <provider>/<model>` for the provider under test to capture a metrics file.
- Respect cost limits: use short prompts, cheapest models. Do **not** exceed personal 272K boundary.

**Test Data:** Include sample prompts in `test/fixtures/`, covering:
- Long prefix vs new suffix.
- Compacted history vs non-compacted.
- Different providers (simulate via setting provider name in dummy context).

**Mocks:** If needed, mock provider responses to simulate cached vs non-cached tokens (e.g. `response.usage.prompt_tokens_details.cached_tokens = 10`).

**CI Steps:**

- `npm test` on all branches.
- Linting and type checks (if TS).
- `npm pack --dry-run` to validate packaging.
- (Optional) `npm publish --dry-run` to inspect final tarball contents.

## 8. CI and Packaging Checklist

Before each release:

- [ ] Update `package.json` version.
- [ ] Ensure `main` and adapters are included. Example `package.json` exports:
  ```json
  "exports": {
    ".": "./cache-engine-v1.js",
    "./v2": "./cache-engine-v2.js"
  },
  "types": {
    "server": "./cache-engine-v1.ts",
    "plugin": "./cache-engine-v2.ts"
  },
  "files": ["cache-engine-core.mjs","cache-policy-core.mjs","cache-usage-core.mjs","cache-engine-v1.js","cache-engine-v2.js","README.md","LICENSE"]
  ```
- [ ] Run `npm pack --dry-run`; inspect contents:
  - Must *not* include tests, docs (AGENTS.md, audit reports), or dev files.
  - Should include core `.mjs` files, JS outputs, README, LICENSE.
- [ ] Verify entrypoints:
  - In a temp project, install the packaged tarball and require both `cache-engine` (V1) and `cache-engine/v2` (V2) to ensure they load.
- [ ] CI: On merge to `main`, ensure all tests pass. On tag, rerun full suite.

## 9. V2 Migration Checklist

> **Unverified/aspirational.** Every V2 hook/API name below (`Plugin.define`,
> `ctx.session.hook("context"/"model.request"/"compaction")`, `ctx.location.*`) is
> a hypothesis to verify in **WP4** (§2B), not verified evidence. Do not implement
> or claim functionality from it.

- **Plugin Entry:** Use `export default Plugin.define({id, setup})` instead of V1 `export const CachePlugin: Plugin = async ({...})`.
- **Context Mapping:**
  - V1 `directory` → `ctx.location.directory`.
  - V1 `client` → `ctx` domains (e.g. `ctx.session`, `ctx.shell`).
- **Hooks:**
  - Replace V1 `"chat.params"` hook with `ctx.session.hook("context", (event) => {...})`. Map output options (e.g. `event.options.temperature`, `event.options.promptCacheKey`).
  - Replace V1 `"chat.headers"` with `ctx.session.hook("model.request", (event) => {...})`. Use this to set HTTP headers (`event.headers[...]`).
  - V1 `"experimental.session.compacting"` → `ctx.session.hook("compaction", ...)`.
  - If using V1 `"tool.*"` or `"shell.*"` hooks, use `ctx.tool.hook` or `ctx.shell.hook` accordingly (less relevant for CacheEngine).
- **HTTP vs Model Request:** Use `model.request` for adding headers (e.g. the OpenRouter `x-session-id`, or any verified provider routing header). Use `http.request` only if needing raw HTTP (usually not required for cache keys).
- **x-session-id Handling:** Continue sending `x-session-id` on V2 by adding it in `model.request` headers when provider=OpenRouter (case-insensitive match). No change needed to semantics.
- **Compaction:** OpenCode V2 compaction hook provides a summary block similarly to V1. Use `ctx.session.hook("compaction")` to detect and resume accounting.
- **Multiple Request Kinds:** V2 supports "context", "compaction", "title", "generate". For cache logic, hook at `"context"` and `"compaction"` only, as per usage.
- **Testing V2:** Write tests that mock `ctx.session.hook` invocations. For example, simulate `ctx` with minimal interface (`session.hook` calls your handlers directly).
- **Documentation:** Update README to mention compatibility with both runtimes.

## 10. Provider Integration Recipes

Superseded by §2. The v0.5.x provider-coverage phase (Kimi, Anthropic/Claude,
Gemini, Qwen, xAI/Grok, Meta Muse, MiniMax) carries the per-provider recipes,
official references to verify, implementation tasks, required tests, and
acceptance criteria. Read §2 and §2.0 before starting any provider work.

The earlier illustrative Mistral and xAI/Grok recipes were removed on purpose:
their field names and headers were placeholders, not verified evidence, and
AGENTS.md forbids implementing provider behavior from plan text. xAI/Grok is now
implemented from first-party evidence (§2.0); Mistral remains the only deferred
candidate — if it is picked up, research it from first-party documentation and
record the evidence before writing policy code.

## 11. Observability & Telemetry

Enhance telemetry to clarify cache behavior:

- **Cache Strategy Field:** e.g. `"cacheStrategy":"active-key"` or `"passive"`. Helps debug which branch ran.
- **Cache Key/ID:** e.g. `"cacheRootId": "<sessionID>"` to confirm identity used.
- **Cache Write Hits:** Already reported as `usage.tokens.cached` by providers. Ensure these map in existing schema.
- **Provider/Model Labels:** Already in telemetry; confirm they propagate from policy.
- **Metrics File:** Already records read/write/input per session. Consider adding a field in output JSON for `strategy` if not heavy.
- **Logging:** In debug mode, log why a policy was chosen or not applied (for QA).
- **Schema:** Maintain compatibility (do not break v0.4.8 format).

## 12. Risk Register & Rollback Plan

| Risk | Likelihood | Impact | Mitigation | Rollback Plan |
|------|------------|--------|------------|---------------|
| New provider APIs behave differently (e.g. Gemini cache works differently) | Medium | Medium | Test each in isolation; document assumptions. If unclear, revert strategy to passive only. | Remove offending provider code (comment/disable) and republish a patch release. |
| V2 adapter not functioning fully | Low | High | Keep V1 stable. Merge V2 only after thorough integration testing. | Revert merge of `v2-adapter` branch; maintain 0.x while fixing V2. |
| Session state growth / memory leak | Medium | Medium | Implement bounded cleanup (e.g. remove state after session end/timeout). Monitor memory. | If severe, disable long-lived caching (reset cursor each time) as a stop-gap. |
| Shared core refactor bugs | Low | High | Write extensive unit tests. Peer review refactors. | Keep backups (feature branches) and roll back if tests fail. |
| Packaging errors (missed files) | Low | Medium | Use `npm pack --dry-run` to catch missing files. | Fix `files` whitelist, republish patch. |
| Conflicts merging V2 branch | Medium | Low | Regularly sync `feature/v2-adapter` with `main`. Resolve conflicts early. | If stuck, freeze merges and focus on small fixes, then reintegrate carefully. |
| Provider cost/limits | Low | Low | Use cheapest test models. Respect usage caps. | Do not execute expensive runs; rely on mocks if needed. |
| Version mismatch (OpenCode SDK) | Low | Medium | Pin plugin API versions; verify against Opencode v1.18.x and v2.x. | Lock version or temporary patch code to adapt to SDK changes. |

Regular code reviews and CI monitoring will catch issues early. Always ensure a public release only when all acceptance criteria are met.

## 13. Timeline and Milestones

The roadmap diagram in the header presents the milestone dependency order (no
fixed calendar dates are promised). Milestone-specific acceptance criteria:

- **0.5.x:** Provider-coverage phase complete — Kimi, Claude, Gemini, Qwen, xAI/Grok, Meta Muse, and MiniMax each landed as a separate validated release (§2, §2.0). `npm test` passes at every increment.
- **0.6.0 (DONE):** usage/accounting extracted to `cache-usage-core.mjs`; identity audited (no new abstraction); table-driven provider conformance/regression tests added; no provider behavior changed; shipped with a green 277-test suite. See §2.0b.
- **0.7.x (IN PROGRESS — see §2B and §2B.8):** the v0.7.0 core/adapter contract is implemented (boundary audited; documentation + 4 contract tests; no source change was required). The session-state model/lifecycle (v0.7.1) and V2 readiness/verification (v0.7.2+) remain; V2 readiness must be verified-mapped or explicitly deferred. V1 behavior is unchanged. This milestone does **not** build a functioning V2 adapter and makes no dual-runtime claim.
- **0.8.x (future, gated on a verified V2 API contract):** a functioning V2 adapter is implemented and its hook mapping tested.
- **0.9.x (future):** dual-runtime stabilization and documentation.
- **1.0.0 (future):** released only when V1 and V2 support are independently validated, all tests are green, and packaging is finalized.

## 14. Harness Validation Commands

Use these commands to validate each milestone as you proceed:

```bash
# Ensure on correct branch and up-to-date
git checkout main
git pull

# Run full test suite (unit + integration)
npm test

# Check packaging contents
npm pack --dry-run

# (Optional) Smoke test on a cheap model via OpenCode
# First, link or pack+install the plugin, then run:
opencode run --plugin . -m <provider>/<small-model> -c "console.log('hi')"
# or simulate session:
opencode run --plugin . -m openai/gpt-3.5-turbo -p  Hello
```

For feature branches (e.g. `feature/v2-adapter`):

```bash
git checkout feature/v2-adapter
git merge main   # incorporate latest shared changes
npm test         # run adapted tests (mock session, etc.)
npm pack --dry-run
```

For provider feature:

```bash
git checkout main
git checkout -b feature/provider-kimi
# implement the provider policy...
npm test
```

Finalize each milestone by merging to `main` only after all CI checks pass (including `npm pack` and any integration tests).

**Summary:** This implementation plan provides step-by-step guidance for the CacheEngine project to expand its functionality and runtime support. Each task is scoped, assigned, and has clear criteria. The testing matrix and timelines ensure that all changes are validated and release-ready. Follow this guide as a checklist to ensure nothing is missed.
