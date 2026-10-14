# Repository instructions

OpenCode plugin for provider-aware prompt-cache behavior and telemetry. Change
request structure only for verified provider behavior, and keep each mutation
narrow, deterministic, and tested; otherwise preserve the request and observe
provider-reported usage.

**Current state:** v1.2.0 has shipped — one package loads on OpenCode V1
(`./server`) and V2 (`./v2`), with `./tui` for registration, atop the v0.5.x
provider line (DeepSeek, GPT‑5.6+, GLM‑5.3, MiMo‑V2.6, Kimi, Claude, Gemini,
Qwen, xAI/Grok, Meta Muse, MiniMax) and the v0.6.0 shared-core consolidation.
`docs/implementation-plan-v2.md` is the **shipped record** of the V2 milestone
(Phases A–D below; capability matrix; release gates). The **current, post-1.0.0
phase** is planned in `docs/opencode-cache-engine-v1.x.x-implementation-plan.md`
(see the phase section at the end of this file), derived from
`docs/competitor-prompt-cache-plugins-research-report.md`; read the new plan
before starting work — it is **proposed** and requires explicit authorization.
Keep runtime claims narrow: V2 discovery, `setup(ctx)`, and
`context`/`model.request` dispatch are verified for the tested project-local shim
route (`RF-OC-024`/`RF-OC-025`); the direct
`plugins: ["opencode-cache-engine/v2"]` subpath entry **FAILs** (`RF-OC-023`);
GPT cache-field wire carriage is **not attributed** to the adapter (Gate 4
**NOT PASS**, `RF-OC-030`/`RF-OC-031`); usage accounting is best-effort, never
exactly-once (`RF-OC-017`–`RF-OC-021`). Never claim a route or provider effect
without runtime evidence. Per-model evidence lives in
`docs/cache-policy-inventory.md`; harness/transport/API evidence in
`docs/research-findings.md`.

## Commands

```bash
npm test
npm run test:harness
node --test --test-name-pattern='OpenRouter|affinity' test/cache-engine.test.mjs
node --experimental-strip-types -e "import('./src/cache-engine.ts').then(m=>console.log(Object.keys(m)))"
npm pack --dry-run
```

- Node 22.23.2 and OpenCode 1.18.34 are the verified toolchain. Re-check runtime
  assumptions when OpenCode changes.
- The root package has no dependencies or build/lint/typecheck scripts. Tests
  use Node's built-in runner and import the plain-JS core; the server entry can
  be loaded with `--experimental-strip-types`. Don't add a bundler or `tsc` just
  to satisfy a harness.
- `npm run test:harness` runs the hermetic capture-harness suites
  (`test/harness/capture/`: exit-contract, retention, port-parity, and the
  date-relocation wire-verifier contract); they need no sandbox or provider. The
  harness itself (`run.sh`) captures serialized requests inside a `bwrap` sandbox
  against a loopback mock; `OC_CAPTURE_MODEL` selects the model and
  `OC_CAPTURE_ENGINE_CONFIG` injects an inline CacheEngine config.
- `postpublish` creates and pushes a `v<version>` Git tag. Never publish as a
  test; publish only when explicitly requested.

## Ownership and runtime

- `src/cache-engine.ts` owns OpenCode hooks, client/session state, request
  mutation, and plugin wiring. `src/cache-engine-core.mjs` is dependency-light
  pure JS for config, classification, transforms, IDs, and diagnostics.
  `src/cache-usage-core.mjs` is the runtime-independent usage/accounting core
  (message scanning/cursor, cache ratios, the shared digest); it must stay free
  of OpenCode-client, hook, routing, and V2 dependencies. Put new provider-
  agnostic accounting logic there and re-export it from `cache-engine-core.mjs`;
  keep other new testable logic in `cache-engine-core.mjs`. `src/tui.mjs` only
  registers the plugin; it has no CacheEngine-specific UI or server behavior.
- Package exports are separate: `./server` → `src/cache-engine.ts` and `./tui`
  → `src/tui.mjs`. The package is ESM (`"type": "module"`, no `main`) with a
  `files` whitelist (`src/`, `README.md`, `LICENSE`); the packed tarball ships
  runtime files only. Check packaging changes with `npm pack --dry-run`.
- Hooks registered: `chat.headers`, `chat.params`,
  `experimental.chat.system.transform`, `experimental.session.compacting`, and
  `event` (notably `session.idle` usage aggregation).
- Runtime facts (verified on OpenCode 1.18.34): `client.session.get` takes
  `{ path: { id } }`; SDK methods use `this._client`, so call them as members or
  bind them. `chat.params` marks compaction with `input.agent === "compaction"`.
- `client.session.messages` is called as `{ path: { id } }` and returns messages
  **oldest-first** (chronological; `time.created` non-decreasing), NOT
  newest-first. Usage aggregation keeps `lastProcessedMessageID` (newest
  processed id) plus a `lastProcessedAt` watermark: it counts assistant messages
  AFTER the cursor and falls back to the watermark when the cursor id is
  pruned/reverted, so compaction can never double-count (it undercounts when no
  safe boundary exists). Do not reintroduce a newest-first or "stop at the cursor
  scanning from the top" assumption.
- The system-transform runtime passes one `output.system` element and ignores
  reassignment; mutate `output.system[0]` in place. The plugin's fake-client
  affinity tests exercise `chat.headers` without model calls, but do not prove
  OpenCode's network adapter sends the header upstream.
- OpenCode sorts tools before sending them. `toolWireFingerprint` is a
  registry-order diagnostic, not a byte-exact wire fingerprint. Tool-list
  failures leave fingerprints unknown; never emit a fabricated tool change.
- Fork message ancestry is not reliable in the verified runtime, so GPT's
  `cacheRootKey` default stays `false`. Do not invent fork-ancestry heuristics.

## Provider invariants

- **DeepSeek:** passive only. Never mutate its system, tools, messages, provider
  options, or cache keys.
- **GPT-5.6:** prompt text stays unchanged. For OpenAI/Azure-compatible GPT-5.6
  models, add only missing `promptCacheKey` and `promptCacheOptions` (default
  `implicit`, `30m`) in `chat.params`; preserve runtime-supplied values.
  Compaction has its separate `<root>:compact` namespace. Reasoning effort is
  observe-only. Context/output limits and the 272K pricing boundary belong to
  user/harness configuration; never set or raise them here.
- **GLM-5.3 and MiMo-V2.6:** the only prompt mutations are exact,
  content-preserving relocations, only when enabled and eligible: (a) the
  identifiable `<env>` block to the system tail (`stabilizeSystem`), and (b) the
  standalone daily date line (`Today's date: …`) to the system tail
  (`stabilizeDate`, experimental and default **off**; on the 2.0.26 shape the date
  sits outside `<env>`, so (a) does not move it; (b) is a no-op for missing /
  duplicate / malformed / ambiguous date lines and for the legacy inside-`<env>`
  shape). Don't reorder instructions, rewrite reasoning, or move generic dynamic
  content. MiMo detection must stay narrow: `/mimo-v2\.6-(flash|pro)(?![\w-])/i`.
- **OpenRouter affinity:** `chat.headers` adds deterministic `x-session-id`
  only for GLM-5.3/MiMo-V2.6 when the actual `providerID` is exactly
  `openrouter`. Preserve any case-insensitive pre-existing header; never add it
  for direct/unknown providers. This is an HTTP header, not a body `session_id`,
  cache key, or cache-control field. `mimo26.stickySession` gates the derived
  ID in telemetry, not header injection. Never invent MiMo cache keys,
  breakpoints, or TTLs, and never override routing.
- **xAI Grok:** passive only. Caching is automatic/provider-managed on all Grok
  language models; xAI documents no explicit breakpoint, TTL, or minimum and
  reports cached reads only. OpenCode 1.18.34 drives direct xAI (`providerID
  "xai"` + `@ai-sdk/xai`) through the Responses API and itself sets
  `providerOptions.xai.promptCacheKey = sessionID`, so CacheEngine preserves that
  harness affinity and never injects a key or the Chat Completions
  `x-grok-conv-id` header. Never fabricate a Grok TTL or write token. Gate on the
  verified identity; Go/Zen/OpenRouter/gateways stay passive. See RF-PRV-007 and
  RF-OC-013.
- **Meta Muse:** passive only. Caching is automatic, provider-managed positional
  prefix caching; Meta reports cached reads only. Meta requires
  `prompt_cache_key` to be an application-stable routing hint and explicitly not
  a per-user/per-session value, so CacheEngine never synthesizes one, and
  `prompt_cache_retention` (`in_memory`/`24h`) is a request-level policy left
  harness/user-owned. On direct Meta/Zen/Go the installed runtime pre-sets
  `promptCacheKey = sessionID`; preserve it and never overwrite. Never fabricate a
  Muse TTL, minimum, or write token. See RF-PRV-008 / RF-OC-014.
- **MiniMax:** passive and route-aware. Caching is automatic prefix caching on all
  M-series; M2.x additionally support explicit Anthropic `cache_control` with a
  billed write while **M3 does not** — keep the two model-split baselines
  (`minimax.m3-cache` / `minimax.m2-cache`) separate and never flatten the
  write-billing difference. Direct MiniMax and OpenCode Go use `@ai-sdk/anthropic`,
  so OpenCode's `applyCaching` owns the breakpoints; CacheEngine must not
  duplicate or compete with them, must not inject `cache_control`/`prompt_cache_key`,
  and must preserve Go's `x-opencode-session`. Never fabricate a MiniMax cache
  write on the OpenAI-compatible/Responses paths. See RF-PRV-009 / RF-OC-015.
- Fail closed on unknown provider identity. Model availability through
  OpenRouter does not authorize sending OpenRouter-specific fields to direct
  endpoints.

## Telemetry and safety

- Keep the ratios distinct: generic `read/(read+write)`; GLM
  `read/(read+write+input)`; MiMo `cachedTokens/promptTokens`, where MiMo
  `promptTokens = read + input`. Provider token counts are authoritative; local
  hashes show only observed byte changes, not cache hits.
- Do not fabricate cache-write values or emit zero-usage records on idle.
  Telemetry is best-effort and must not break requests. Never record prompt or
  reasoning contents, credentials, authorization headers, or full request
  bodies. MiMo's optional `stickySessionId` telemetry field is an intentional
  derived identifier (the same deterministic ID used for affinity), not a dump
  of captured request headers.
- Preserve the current compaction continuation behavior (at most one insert per
  invocation); do not change thresholds, context limits, or token budgets as an
  incidental change.

## Repository workflow

- The Git working tree is the source of truth; don't maintain a second active
  plugin copy under `~/.config/opencode/plugins/`. `.opencode/` and telemetry,
  session, archive, and lockfile artifacts may be local state; don't delete or
  commit them opportunistically. The local `.opencode/opencode.json` loads the
  package by name and is not the package source.
- The example config must match parser defaults; update it and default
  assertions together when defaults change.
- Keep changes task-scoped; run focused checks first, then `npm test`. For
  runtime-facing changes, use the fake-client/no-model harness where applicable
  and distinguish tested hook logic from unverified network behavior.

## External research findings (search last, store always)

Web search is the last resort, not the first step. Before searching for provider
cache semantics, cache-control/cache-key/usage-field behavior, OpenCode runtime
or SDK behavior, or OpenRouter transport behavior, consult the two tracked
stores:

- `docs/cache-policy-inventory.md` — per-model compatibility evidence: creator
  docs, verification dates, compatibility matrix.
- `docs/research-findings.md` — cross-model findings about the harness and
  transports: OpenCode runtime/SDK/plugin API, OpenRouter routing, AI-SDK and
  provider-package serialization, and provider API mechanics.
- `docs/competitor-prompt-cache-plugins-research-report.md` — competitor/ecosystem
  landscape and the input to the post-1.0.0 plan (**gitignored/local-only**; the
  tracked distillation is the plan). Its third-party claims are **author-reported,
  not verified**; never promote one to `[D]`/`[O]` without our own reproduction.

The two tracked stores use the same evidence tags: `[D]` documented, `[O]`
observed, `[I]` inferred, `[U]` unknown. Cite a finding ID (`RF-OC-001`) instead
of restating the fact.

- Never re-search a fact already recorded with `Status: current` whose
  `Version context` still matches the installed toolchain.
- Record every newly verified first-party fact using the entry template in
  `docs/research-findings.md` (harness/transport/API mechanics) or in the
  inventory (per-model compatibility). A research session that fetches a source
  and does not store the fact is not finished.
- Record findings in **full detail, not a paraphrase**. When a research subagent
  returns an evidence packet (or you fetch first-party pages yourself), store
  every decision-relevant fact: exact endpoint/route and base URL, exact
  request/response field names and JSON shapes, provider/transport gating
  conditions and precedence, fallback rules, numeric values (TTL, minimum
  length, caps, multipliers, limits), usage-field paths, and every
  caveat/unknown. A finding that drops a field name, a gate condition, or an
  unknown is incomplete. Only strip payloads (see below), never facts. If the
  packet is long, the entry is long — do not compress it to save space.
- Give a concrete `Re-verify when:` trigger, not a date. IDs are immutable and
  never reused; supersede by pointing forward with `Superseded by:`.
- Store facts, never payloads: no prompt text, reasoning content, credentials,
  authorization headers, or request/response bodies.
- `audit-report-*.md` and `session-*.md` are gitignored and lost on a fresh
  clone. Promote anything durable from them into one of the two tracked files.
- Unsure whether something is already recorded? Search both files first; that is
  cheaper than a fetch and it is the reason they exist.

## Future-model maintenance procedure (audit first)

Use this whenever a newly released model needs a compatibility review. It is an
AUDIT FIRST task: web search is allowed, runtime code changes are not. Start
from `docs/research-findings.md` and `docs/cache-policy-inventory.md`; search
only for the gaps they do not cover, and store anything new you verify.

Establish the model id and creator, then determine from **first-party creator
documentation**:

1. model family/generation
2. prompt-cache mechanism
3. cache prefix rules
4. cache-control fields
5. cache-key semantics
6. retention/TTL
7. usage fields
8. documented prompt-stability guidance
9. whether the model inherits the creator's existing family cache policy
10. whether any existing CacheEngine overlay is applicable

Compare the findings against `docs/cache-policy-inventory.md`,
`docs/research-findings.md`, the current policy resolver
(`src/cache-policy-core.mjs`), and the current tests.

Classify the model as exactly one of:

- existing family policy applies unchanged
- existing family baseline applies but no existing overlay applies
- new exact-model override required
- new family policy required
- insufficient evidence; remain passive/neutral

Never add a code change merely because a model is new.

**If no change is required:** update the compatibility inventory with the model
and its verification date, run tests, stop.

**If a code change is required:** do not implement it in that session. Report the
smallest justified follow-up release, the exact source evidence and the exact
runtime behavior that must change, and the regression tests required.

Hard rules:

- Don't speculate about undocumented cache behavior.
- Don't use pricing as proof of cache semantics.
- Don't broaden an existing prompt transformation merely because the new model
  has a similar name.

OpenCode is the harness. Use `policy-resolution` telemetry
(`matchCategory`, `matchReason`, `overlaySkippedReason`) to see how a model
actually resolved before assuming anything about it.

## Roadmap and current phase

`docs/opencode-cache-engine-v1.x.x-implementation-plan.md` is the authoritative
plan for the **post-1.0.0** phase (diagnostics-first; details in the phase
section at the end of this file). `docs/implementation-plan-v2.md` is retained as
the **shipped record** of the V1→V2 milestone (Phases A–D below); its gates are
closed per §2D.13 (Gate 4 **NOT PASS**; accounting best-effort). Read the current
plan before starting work, and treat every plan as a milestone checklist rather
than as authorization to implement.

Milestones (authoritative detail in the consolidated plan, §4–§9):

1. **Phase A — 0.7.x stabilization (shipped).** Preserved V1 and the shared
   core; kept the V2 adapter and its regression coverage; completed the
   locally-answerable telemetry/lifecycle/accounting investigations; kept V2
   runtime registration unverified *at that stage*. Documented bounded
   session-state eviction and its accounting tradeoffs.
2. **Phase B — 0.8.x V2 runtime integration.** Establish a supported, safe
   runtime validation procedure; verify `./v2` entry resolution, `setup(ctx)`
   execution, and hook installation against the installed API; confirm
   usage-source semantics and ordering. Fix real defects narrowly; keep V1
   unchanged. Do not edit shared config or risk the user's managed service to
   force a smoke test.
3. **Phase C — 0.9.x dual-runtime stabilization.** Validate V1 and V2
   independently; decide the V1→V2 parity contract (including whether compaction
   isolation / fork cache-root are required for 1.0.0); complete
   installation/export/lifecycle docs; cut a release candidate only when the
   plan's acceptance gates pass.
4. **Phase D — 1.0.0 stable dual-runtime release.** Requires demonstrated V1
   compatibility and **demonstrated V2 registration and hook installation**; no
   calendar deadlines — exit criteria only.

Mistral remains the only deferred provider candidate, pending an audit-first
evidence note. Read the consolidated plan for the capability matrix, work
packages, acceptance criteria, testing strategy, release policy, and rollback.

Branches: `master`/`main` carries the shipped dual-runtime line and all releases;
the V2 adapter is merged (1.0.0). Use a short-lived `feature/<task>` branch per
change (e.g. `feature/provider-<name>` per provider) and merge to `master` only
through the release gates above.

Binding constraints on roadmap work — these override the plan:

- The plan is a roadmap, not a source of truth for provider behavior. Every
  provider recipe in it is illustrative; the official links are *references to
  verify*, never evidence. Never implement a field name, header, TTL, or usage
  mapping from the plan text. Verify each one from first-party creator
  documentation and record it, or classify the model as insufficient evidence
  and stay passive.
- Every new provider or model still goes through **Future-model maintenance
  procedure (audit first)** above, and every verified fact is stored in the two
  tracked files. Do not skip the audit because a provider is already on the
  roadmap.
- Gate per **API route**, not per provider name. A provider reached through a
  native endpoint, an OpenAI-compatible gateway, or a third-party gateway can
  have different request shapes; assume nothing is uniform across a vendor's
  endpoints or models. Anthropic and Kimi in particular need route-difference
  tests.
- Never bundle a provider addition with a large architecture refactor. Keep the
  phase small and release incrementally; a validated passive policy beats an
  active mutation based on assumptions, and shipping fewer providers beats
  lowering the evidence or test standard.
- The **Provider invariants** above stay binding for the existing families. A
  new family earns its own invariant bullet only after its evidence is recorded.
- Telemetry changes stay additive: keep existing record kinds, field names, and
  provider-correct ratios readable by current consumers.
- Runtime-file moves or renames (`cache-engine.ts` becoming a V1 adapter module,
  a new V2 entrypoint) must update the `Ownership and runtime` section, the
  `package.json` `exports` map, and the `files` whitelist in the same change,
  and be validated with `npm pack --dry-run`. Keep the existing `./server`
  entrypoint working or make an explicit breaking version bump.
- Keep the V1 path stable on `master`; V1-only tasks must not take on V2 runtime
  dependencies.
- Pricing, cost thresholds, and context/output limits stay out of scope.
- The plan's CI/packaging automation is optional future work; do not add a
  bundler, `tsc`, or runtime dependencies just to satisfy it.

## Post-1.0.0 phase — diagnostics-first cache-stability program

`docs/opencode-cache-engine-v1.x.x-implementation-plan.md` is the authoritative
post-1.0.0 plan; `docs/competitor-prompt-cache-plugins-research-report.md` is its
input (competitor/ecosystem research — its third-party claims are
**author-reported, not verified**). The plan is **proposed**: nothing in it is
authorization to implement. Use its §17 task-result template for phase reports.

`TODO.md` (repo root) is the **parent task list** for the post-1.0.0 work: read it
before starting phase work, work **one task at a time**, and expand the selected
task's kickoff contract into child todos. Do not start the next task until the
current task's gate is met.

**Phase 1 — structural diagnostics + offline capture harness: COMPLETE**
(2026-10-14; suite 362/0). Delivered `lintSystemVolatility`/`firstSystemDifference`,
`systemStablePrefixLength` telemetry, V1/V2 diagnostic integration, and the
offline/mock capture harness. **Phase 2 — date relocation: COMPLETE** (P2-T1..P2-T5, 2026-10-14). The
`stabilizeDate` date-line relocation is implemented for V1/V2 (**default off**),
wire-verified (G3, `RF-OC-036`); the provider A/B showed **directional support**
(`RF-OC-038`) but not a clean benefit (G4, simulated rollover). **P2-T5 keeps it
experimental** (`docs/phase2-p2t5-acceptance-decision.md`); a real-calendar rollover
confirmation is optional. **Phase 3 — other volatility sources: P3-T1 (offline
capture groundwork) COMPLETE** (2026-10-15) — both pair types reproduce offline
(`RF-OC-040`/`RF-OC-041`; `docs/phase3-p3t1-capture-groundwork.md`). **P3-T2 (tool
ordering) COMPLETE** (2026-10-15) — **no-op** (deterministic order/definitions;
`RF-OC-042`; `docs/phase3-p3t2-tool-ordering.md`). **P3-T3 (startup/MCP readiness)
COMPLETE** (2026-10-15) — **no-op / watch item** (the MCP-readiness race is real:
MCP tools are Code-Mode by default and the first request can precede MCP registration;
`RF-OC-044` supersedes `RF-OC-043`; `docs/phase3-p3t3-startup-mcp.md`); P3-T4
(dynamic instructions/project context) is next. See `TODO.md`.

- **Diagnose before mutating.** Observe the rendered request, identify a specific
  avoidable instability, verify the hook can safely observe/change it, then make
  the smallest justified transformation and verify the serialized request. Prefer
  diagnostics over rewrites; a no-op is a valid outcome.
- **Wire, not hook.** Wire verification reads the **serialized** provider request
  after OpenCode's schema decoding (`RF-OC-030`); a hook payload is not the wire
  and would false-positive. Capture with the isolated procedure and only supported
  loading paths (`RF-OC-023`–`RF-OC-025`).
- **Use the plan's scaffold.** Work from the plan's harness/capture contract (§3),
  current-implementation mapping (§3A — extend the shipped primitives, do not
  re-implement them), phase map (§3B, each phase tagged *research* vs
  *implementation*), quantitative thresholds (§3C), and risk register (§17A). The
  silent-invalidator linter is advisory and allowlist-aware (`VOL-*` rule IDs;
  `VOL-DATE`/`VOL-CWD-PATH` are `info`).
- **Governing decision rule.** Do not ship a cache intervention because it looks
  reasonable, because a competitor uses it, or because the adapter executed it.
  Ship only when the instability is *observed*, the transformation *safe*, the
  wire effect *verified*, and the benefit *supported by evidence*. Negative or
  inconclusive results are valid outcomes.
- **Evidence labels** for task reports: *Observed*, *Structurally verified*,
  *Wire verified*, *Provider measured*, *Inferred*, *Author reported*,
  *Inconclusive*. They refine the stores' `[D]`/`[O]`/`[I]`/`[U]` tags: `[D]` is
  a documented first-party/upstream source (the report's `(official)` /
  `(upstream-spec)`); `[O]` is observed/structurally/wire/provider-measured;
  `[I]` inferred; `[U]` unknown. A third-party claim is *Author reported*, never
  `[D]` or measured.
- **Testing ladder A–E:** A unit → B integration (hook shape, policy selection,
  V1/V2 isolation) → C offline wire (local mock proves the serialized request and
  unrelated-field preservation) → D provider experiment (only with explicit
  authorization) → E release qualification. Passing one level never implies the
  next; unit/wire tests cannot prove provider cache benefit.
- **Release gates G0–G6:** baseline, observation, safety, wire, outcome,
  operations, publication. A failed gate means narrow, revise, or reject — never
  "ship and hope". Completion is not a promotion criterion.
- **Safety (binding):** never commit/push/amend/rebase/tag/publish/bump without
  explicit authorization; never modify managed OpenCode config, installed plugins,
  user cache/state, or running services; do not use `opencode plugin
  add/remove/update` or `opencode run --plugin` for testing; no real provider
  requests or paid calls without authorization; never log credentials; the user
  verifies and commits. Preserve an untracked `package-lock.json` byte-for-byte.
- **Do not loosen the `<env>` marker guard**, extend a prompt transform, or add a
  new policy without a separate safety case and its own evidence (see the
  Provider invariants above).
- **Priority order (§16):** baseline/regression protection; offline capture +
  first-difference diagnostics + fingerprints + silent-invalidator linter;
  date-relocation hook-shape/wire verification; date relocation only if
  structurally safe (offline first); authorized provider rollover A/B before any
  benefit claim; route-specific GPT-option and OpenRouter-affinity verification;
  ranked volatility investigation (tool order, startup/MCP, dynamic instructions,
  reasoning boundaries); telemetry definitions + best-effort accounting docs;
  compaction economics research; minimal observability + reproducible benchmark.
- **Deferred (do not start without a demonstrated, route-specific need):**
  keepalive/warming, broad system-block reordering, automatic tool sorting,
  blocking on MCP readiness, frozen date/memory, general-purpose pruning,
  automatic policy learning, and a large TUI/dashboard.
