# Phase 7 — minimal user-facing observability (P7-T1 …)

**Plan:** `docs/plans/v1.x.x-implementation-plan.md` §11 (+ §3B/§3C row 7). **Parent task list:**
`TODO.md` (Phase 7). Gated implementation — no request mutation, no provider calls, **0 bytes added
to any prompt**.

---

## P7-T1 — observability requirements + data-source inventory

**Task:** P7-T1 (`TODO.md`) — map every element plan §11 requires to a telemetry source (or mark it
**unavailable**), and fix the "must not show" list — before any renderer is designed.

**Evidence:** every row traces to a record kind/field in the P5-T1 catalogue
(`docs/phases/phase5-usage-accounting.md` §1–§5) and the emitters
(`src/cache-engine.ts`, `src/cache-engine-v2.mjs`, `src/cache-engine-core.mjs`). `[O]` structurally
verified. **Provider measured: not performed.**

### 1. Required element → data source

| Element (plan §11) | Record kind + field(s) | Adapter | Availability |
|---|---|---|---|
| **policy mode** | `boundary.policy` (+ `reason`); `policy-resolution.policy`/`family`/`matchCategory`/`matchReason`/`overlayApplied`/`overlaySkippedReason`; `usage.policy` | both; `policy-resolution` V1-only | available (V1 richest) |
| **last structural change** | `prefix-change` (`ts`, `dimensions`, `reasons`, `changedFields`, `before`/`after`, `systemStablePrefixLength`); `boundary` (`system_date_relocated`, `mimo_system_env_relocated`, `system_volatility`) | `prefix-change` V1-only; some `boundary` both | available (V1); V2 → boundary events only |
| **first differing section** | `prefix-change.changedFields` / `dimensions` / `reasons` (system-stable-prefix · volatile-suffix · semantic-tools · wire-tools hashes); `boundary.system_volatility.rules` | V1 | available (V1-only) |
| **transformation attempt vs applied** | `stage` on every record (`decision` vs `applied`; `observation`/`outcome`/`error`); `cache-options.keyInjected`/`keyPreserved`/`optionsInjected` | both | available |
| **wire verification** | `wireEffect` — **currently always `"not_observed"`** | both | **constant "not observed"** (never a wire claim) |
| **provider cache metrics (when available)** | `usage.read`/`write`/`input`, `sampleHitRate`, `cumulative`/`cumulativeHitRate`, `glmHitRate`, `cachedTokens`/`cacheHitRate`, `tokenSource` | both | **often unavailable** — only when the provider reports them |
| **accounting limitations** | static text from P5-T4 (best-effort; unavailable ≠ zero; restart recount; eviction undercount; provider-specific formulas) | — | static |
| **estimated cost impact** | **not produced** by the plugin (no pricing); only a P6-T3-style model | — | **only with explicit assumptions** |

### 2. Elements with no defensible source (must render as *unavailable*)

1. **Wire verification** — `wireEffect` is always `"not_observed"`; the report may show *attempted/
   applied hook-object* status but **must not** claim a wire effect (P4-T2/T3).
2. **Provider cache metrics** — absent when the provider reports none; the report shows *unavailable*,
   never `0` (P5-T4: missing ≠ zero).
3. **Estimated cost impact** — not computed anywhere; appears **only** with the assumptions spelled
   out, or is omitted.
4. **V2 diagnostics** — the V1-only kinds (`policy-resolution`, `prefix-observation`,
   `prefix-change`, `compaction`, `reasoning-integrity`) and `usage.provider`/`model` do not exist on
   V2; the report states "no V1 diagnostic available" rather than inventing a value.

### 3. Never-show list

- Prompt or reasoning content, tool schemas, message bodies — **none of the records carry them**
  (P5-T4 privacy guard); the report must not reconstruct or inline any.
- Credentials, authorization headers, full request/response bodies.
- **A ratio when provider data is insufficient** — omitted, not zero.
- An **estimate without its assumptions** — or any estimate presented as measured savings.
- A wire claim derived from `stage:"applied"` — always paired with `wireEffect:"not_observed"`.

### 4. Surface recommendation (input to P7-T2; decision deferred to the user)

**Recommend Option A — a pure renderer + a thin CLI over the metrics store:**

- `renderReport(records) → string`: a **pure** function in a dependency-light core module
  (`records` = the parsed `cache-metrics.jsonl` lines).
- A thin entry point reads `CACHE_ENGINE_METRICS_FILE` (else `DEFAULT_METRICS_FILE`,
  `~/.cache/opencode/cache-metrics.jsonl`) and prints the report.

Rationale: it is **never on the request path** (0 bytes to any prompt), fully **testable** (a pure
function over synthetic records, matching the repo's core-module ethos), adds **no dependency** and
touches no OpenCode runtime API.

**Option B (`./tui` panel)** is named by §3B but higher-risk: `src/tui.mjs` is a deliberate V1/V2
**registration no-op**, and the OpenCode TUI-panel API is **unverified** — building a panel would
need its own `RF-*` finding first. **Option C (staged)** = ship A now; revisit B only if that API is
verified. (Recommendation only — the choice is P7-T2.)

### 5. Evidence & acceptance

- Labels: **Structurally verified** / **Documented**. **Provider measured: not performed.**
- Acceptance: every required element is mapped or explicitly marked unavailable (§1/§2); the
  never-show list is explicit (§3); a surface recommendation is recorded (§4). **P7-T2 may proceed
  (subject to explicit authorization for the surface decision).**

---

## P7-T2 — surface decision + renderer contract

**Task:** P7-T2 (`TODO.md`) — choose the minimal surface and fix the renderer's contract.
**Type:** design decision — **authorized by the user (2026-10-16)**. Read-only.
**Evidence:** two independent reviews (Appendix A) reconcile to the decision below.
**Provider measured: not performed.**

### Decision

- **Surface: Option A — a pure renderer + a thin CLI.** `./tui` stays the compatibility no-op.
  The plan names a "compact report view (`./tui` surface)" **once** (plan §3B, *artifacts* column) and
  defers a "Large TUI/dashboard" (§13); §11's body and §3C row 7 are the normative requirements and
  mandate the *observable result*, not an interaction model. A panel would also need a verified
  OpenCode TUI API — none exists, and `src/tui.mjs` is a deliberate no-op satisfying the V2 module
  contract — so a panel is gated behind its own `RF-*` (see *Revisit clause*).
- **Packaging: minimal.** **No `bin`, no new `exports` entry.** Invocation **by path**:
  `node src/cache-report.mjs [--file <path>]`, optionally aliased by an `npm run report` script.
  `files: ["src/"]` already ships it; no installed-command contract to maintain.
- **Modules:** `src/cache-report-core.mjs` (pure: parse + render; imports core + node builtins only)
  and `src/cache-report.mjs` (thin: file read, argv, exit codes).

### Renderer contract

```text
parseReportInput(text) -> { records, skipped }   // tolerant: blank lines ignored; malformed / partial-trailing lines skipped-and-counted
renderReport(records)  -> string                 // pure, deterministic, dependency-free; no options
```

- **Input:** the parsed JSONL records (as emitted, incl. `stage`/`wireEffect`). The renderer
  **allow-lists** the P7-T1 §1 fields and ignores everything else — privacy is structural.
- **Sections (fixed order, each always present):** policy mode · last structural change ·
  attempt-vs-applied · wire status · provider cache usage · accounting limitations · estimates.
- **Unavailable rendering:** the literal `unavailable — <reason>` (never `0`, never a blank that
  infers zero).
- **Estimates:** **omitted**; if ever added, only with explicit assumptions and labeled separately.

### Semantic rules (binding)

1. **Policy** — the most recent **valid** `policy-resolution`; if only a `policy` field on another
   record exists, label it "policy recorded on that event"; label it *last recorded*, not live state.
2. **Last change** — the newest relevant event, chosen deterministically, with its **kind +
   timestamp**, so a policy change is distinguishable from a prefix observation or a compaction.
3. **Wire status** — explicit wire evidence only. `wireEffect:"not_observed"` means *not observed* —
   **not** confirmed absent, rejected, or unsuccessful. Missing wire fields ⇒ unknown.
4. **Cache ratios** — only from valid provider measurements with a **non-zero denominator**; a zero
   denominator ⇒ `unavailable`, never a fabricated percentage. Missing is not zero.
5. **Empty / partial telemetry** — render `unknown` / `unavailable`; **never** infer "no change".

### Isolation

One-way dependency: the report imports core + node builtins only; **nothing** in `./server`, `./v2`,
or `./tui` imports the report. The CLI is a standalone, read-only consumer of the JSONL store,
invoked manually, stdout-only — it never initializes the plugin, registers a hook, writes telemetry,
or touches the request path. Enforced by a static-grep test (P7-T4).

### Test obligations (P7-T4)

Renderer purity/determinism (no input mutation) · per-element coverage on V1-rich **and** V2-thin
inputs · **unavailable ≠ zero** (esp. a missing cache-read never becoming `0`) · privacy/allow-list
(prompt fragments, credentials, bodies, headers, session ids, unknown fields never appear) · no wire
claim from `stage:"applied"` · estimate gating · JSONL tolerance (empty file, trailing newline,
malformed line, unknown kind, partial record) · CLI (default path, `CACHE_ENGINE_METRICS_FILE`,
explicit path, missing/unreadable file, useful error + exit status) · isolation grep.

### Revisit clause

A TUI panel is reconsidered **only** behind an `RF-*`-verified OpenCode TUI-panel API; the pure
`renderReport` is then reused verbatim as the panel's formatting core. Reversal cost is deliberately
tiny — nothing is on the request path either way.

### Evidence & acceptance

- Labels: **Structurally verified** (plan §3B/§3C/§11/§13) / **Inferred**. **Provider measured: not performed.**
- Acceptance: the surface + contract are recorded and the user authorized (2026-10-16).
  **P7-T3 may proceed.**

---

## P7-T3 — pure report renderer (implemented)

**Task:** P7-T3 (`TODO.md`) — implement `renderReport(records) → string` per the P7-T2 contract.
**Type:** implementation — **authorized** (2026-10-16); offline. No request mutation; no provider.

### Delivered

- `src/cache-report-core.mjs` — pure: `parseReportInput(text) → { records, skipped }` (tolerant:
  blank lines ignored; malformed / partial-trailing lines skipped-and-counted) and
  `renderReport(records) → string`. Imports **nothing** (not even node builtins); no filesystem,
  network, clock, environment, or OpenCode access; no side effects on import.
- Sections (fixed order, each always present): policy mode · last structural change · first
  differing section · transformation status · wire verification · provider cache usage ·
  accounting limitations · estimated cost impact.
- **Allow-listed fields only.** The renderer reads `kind`, `ts`, `policy`/`family`, `reason`,
  `changedFields`/`dimensions`/`reasons`, `stage`, `wireEffect`,
  `keyInjected`/`optionsInjected`/`keyPreserved`, and
  `read`/`write`/`input`/`tokenSource`/`glmHitRate`/`cacheHitRate`; it prints **none of** `sid`,
  prompt/message content, bodies, headers, or unknown fields.
- Missing ⇒ `unavailable — <reason>`; the generic ratio requires a non-zero denominator; estimates
  are omitted.

### Invariants

pure; allow-listed; **0 bytes** added to any prompt (never on the request path); no fabricated zero;
no ratio without provider data; an `applied` change is never a wire claim.

### Completion rule

P7-T3 is complete when the renderer produces the report from records under the invariants.
**P7-T4 followed.**

---

## P7-T4 — entry point + tests (implemented)

**Task:** P7-T4 (`TODO.md`) — the metrics-file entry point + unit/privacy/isolation tests.
**Type:** implementation + tests — offline.

### Delivered

- `src/cache-report.mjs` — thin CLI: `parseCliArgs`, `resolveMetricsPath` (`--file` > env >
  default), and `run(argv, env, out, err) → exitCode` (injectable streams; never throws). Reads
  `CACHE_ENGINE_METRICS_FILE` else `~/.cache/opencode/cache-metrics.jsonl`; stdout-only; exit `0`
  ok / `2` usage or unreadable file. Invoked by path (`node src/cache-report.mjs [--file <path>]`)
  or `npm run report`. **No `bin`, no new `exports` entry** (P7-T2 decision).
- Tests (`npm test`, **388/0**): parse tolerance; renderer purity/determinism + no input mutation;
  per-element rendering; unavailable ≠ zero; no ratio on a zero/partial denominator; privacy
  (content-shaped fields never appear); `stage:"applied"` never a wire claim; CLI arg/path
  resolution; CLI render + skipped-line note + exit codes; **isolation** (the plugin runtime does
  not reference the report; the report imports only node builtins + the core).
- AGENTS "Ownership and runtime" carries the new modules; `package.json` gains a `report` script.
  `npm pack --dry-run`: both files ship (`total files: 11`).

### Evidence & acceptance

- Labels: **Structurally verified** (unit + CLI tests) / **Offline**. **Provider measured: not performed.**
- Acceptance: the entry point works offline and the tests pass. **P7-T5 may proceed.**

---

## Appendix A — P7-T2 independent reviews

Two independent reviews of the same P7-T2 problem statement. They **agree** on the core (pure
renderer + thin CLI; keep `./tui`; never on the request path; `not_observed` ≠ absence; missing ≠
zero; estimates omitted; a panel only behind a verified API) and **differed on exactly one axis —
packaging** — which the user resolved toward the **minimal** surface (no `bin`, no new `export`).

### A.1 — `@oracle` review (session `ses_ebb53ce03ffe230BuIQawahFJn`): decision **C**

- **Surface:** ship **A now; B only on an `RF-*`-verified API**. §3B's "(`./tui` surface)" is a
  parenthetical in an artifacts column, **illustrative**, not an API contract; the normative
  requirements are §11 + §3C.
- **Packaging:** **no `bin`, no `exports` entry, do not touch `src/tui.mjs`**; a pure core module +
  a by-path entry; `files: ["src/"]` already covers it; one AGENTS "Ownership and runtime" bullet.
- **Contract:** `parseReportInput(text) → {records, skipped}` + `renderReport(records) → string`;
  allow-listed fields; `unavailable — <reason>`; estimates omitted; `stage:"applied"` never becomes a
  wire claim.
- **Tests:** the renderer obligations **plus a static-grep isolation test** (the report module must
  not be imported by `./server`/`./v2`/`./tui`; the report imports core + node builtins only).
- **Isolation:** one-way dependency; manual stdout-only entry; `tui.mjs` untouched.
- **Reversal:** tiny; `renderReport` is reused as a future panel's formatting core.

### A.2 — OpenAI review (external, independent): decision **A** — reproduced

**Decision record — approved design direction**

- **Surface:** A — pure renderer plus thin CLI. Keep `./tui` compatible; revisit a panel only behind
  a verified API. The plan's "compact report view (`./tui` surface)" is treated as a requirement for
  a compact *user-facing report*, **not** sufficient evidence that it mandates an interactive TUI
  panel; the acceptance criteria constrain *what the user must see* and *what must not happen*.
- **Invocation:** packaged `opencode-cache-report` **via a `package.json` `bin`**, with
  `node ./src/report-cli.mjs` for repository development; an **additive `./report` export**; no
  dependencies or build step; validate the packed file list with `npm pack --dry-run` and test the
  installed-style command **from the packed artifact** (not just the checkout). *(Superseded by the
  user's minimal-packaging choice above.)*
- **Contract:** `renderReport(records, options) -> string` — pure, over already-read records (no
  filesystem, OpenCode, network, clock, or environment access); a separate pure parser turns JSONL
  lines into validated records; the CLI owns file access, argument parsing, and exit codes.
- **Report must answer three questions:** (1) what policy mode is active / was last resolved;
  (2) what was the last meaningful change; (3) what evidence exists that the change reached the
  provider wire. It must distinguish **observed facts, inferred effects, and unknowns**, and never
  imply a cache hit or savings when provider evidence is missing.
- **Semantics:** policy = most recent valid `policy-resolution` (labelled *last recorded*, not live);
  last change = newest relevant event with **kind + timestamp**; wire = **explicit evidence only**
  (`wireEffect:"not_observed"` means *not observed* — not confirmed absent/rejected/unsuccessful;
  missing wire fields = unknown); ratios only from valid provider-reported measurements with
  sufficient known values (missing ≠ zero; a zero denominator ⇒ *unavailable*, not a fabricated
  percentage); estimates **omitted initially** (if later, require explicit assumptions and label
  separately from observations); empty/partial telemetry ⇒ *unknown*/*unavailable*, never "no change
  occurred because no record was found".
- **Renderer must not print** raw records, session IDs, prompt content, request bodies, headers,
  credentials, or arbitrary unknown fields.
- **Illustrative layout** (their mock-up, not repository output): a titled header; *Policy mode*
  with a `Source: policy-resolution` line; *Last change* with `Source: prefix-change` + timestamp
  and the change type/evidence (never the changed text); *Wire status* → "Not observed — no evidence
  that the change reached the provider wire; an applied local policy or hook-level change is not
  proof of wire carriage"; *Provider cache usage* → "Unavailable — no sufficient provider-reported
  data for a defensible ratio; missing values are not treated as zero".
- **Test areas (their table):** pure renderer (determinism, no input mutation) · policy (latest
  valid, missing policy, missing provider/model) · last change (multiple event types, equal
  timestamps, missing/invalid timestamps, empty history) · wire status (`not_observed`, explicit
  positive evidence, missing, conflicting) · usage (valid, missing, nulls, zero denominator, invalid
  numbers, none) · privacy (prompt fragments, credentials, bodies, headers, session IDs, unknown
  fields) · JSONL parsing (empty file, trailing newline, malformed line, unknown kind, partial) ·
  CLI (default path, env override, explicit path, missing/unreadable file, useful error + exit
  status) · **packaging** (export resolution, executable invocation, packed-file inclusion, existing
  exports unchanged) · **isolation** (the renderer and CLI do not initialize the plugin, write
  telemetry, invoke OpenCode, or make network requests). Include fixtures for every telemetry kind —
  especially `policy-resolution`, `prefix-change`, `cache-options`, `boundary`, `usage`,
  `telemetry-error`.
- **Isolation:** reporting is a *separate consumer* of telemetry, not a new plugin hook — no import
  into `cache-engine.ts`/V2 hooks; no report hook/timer/watcher/background process; no telemetry
  schema change for presentation; read the metrics file only on invocation; JSONL treated as
  potentially malformed and sensitive (allowlist displayed fields).
- **Reversal cost table:** pure renderer *low* · thin CLI *low* · additive `./report` export
  *low–medium* · new `bin` *low–medium* · reusing `./tui` for an interactive panel now *medium–high*
  · staged future panel using the renderer *low–medium*. The obligation: **existing exports retain
  their meaning** — do not replace the `./tui` no-op with a panel in this task.
- **Qualification (their words):** the plan excerpt establishes the compact-report requirement but
  does not conclusively settle whether `./tui` is a literal implementation location; document the
  interpretation and check it against the full plan before implementation — *if* §11 explicitly
  required rendering through `./tui`, keep the pure renderer + CLI and add only the smallest verified
  adapter needed.

### A.3 — Reconciliation

The plan-text check settles their shared qualification: `./tui` occurs in the plan **only** at §3B
(artifacts column) and §13 (deferred "Large TUI/dashboard"); §11 never mentions it. So no `./tui`
adapter is required. The single substantive disagreement (packaging) was resolved by the user toward
the **minimal** surface (Appendix A.1). Everything else in A.2 — the semantic rules, the allowlist,
the isolation dependency direction, the JSONL/CLI testing detail, the "unknown is not zero / local
application is not wire confirmation" discipline — is **adopted** and folded into the P7-T2 decision
above.
