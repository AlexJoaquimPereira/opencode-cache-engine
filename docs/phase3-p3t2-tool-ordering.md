# Phase 3 — P3-T2: tool ordering (ranked entry)

**Task:** P3-T2 (`TODO.md`) — determine, **from captures**, whether tool ordering /
tool definitions are a recurring, avoidable, safely-correctable cache-volatility
source, and record **one ranked inventory entry** (feeds P3-T6).
**Type:** research — read-only; **offline/mock only**. No request mutated; no provider
contacted.
**Depends on:** P3-T1 (harness `OC_CAPTURE_TURNS`/`OC_CAPTURE_CONTINUE` + fixtures).
**Evidence basis:** OpenCode 2.0.26, Node 22.23.2, mock provider, `bwrap --unshare-net`.

Evidence labels: *Structurally verified* / *Offline/mock verified*.
**Provider measured: not performed.**

## Ranked entry (P3-T6 input)

| Field | Value |
|---|---|
| Cause | Tool ordering / tool definitions on the main request |
| Status | **Observed → NOT a volatility source (no-op)** |
| Frequency | **0 drift** across >=3 runs, equivalent turns, the session-continue turn, and a tool-set change |
| Expected impact | none on the verified route (order and definitions are deterministic) |
| Risk of intervention | high — forcing a sort could duplicate OpenCode's own sort or change semantics; plan §13 defers "Automatic tool sorting" until captures prove avoidable instability |
| Next experiment | only if a **second** non-sorted (appended) tool source appears; the single appended `execute` is the only non-core entry observed |
| Recommendation | **no-op** — do not add tool sorting/normalization |

## Evidence (Q1–Q6)

- **Q1 — order + upstream sort.** The wire order is: 11 core tools ASCII-ascending
  (`edit, glob, grep, question, read, shell, skill, subagent, webfetch, websearch,
  write`) with `execute` **appended after** the sorted core (not in sort position).
  Identical across 3 equivalent turns, the session-continue turn, and repeated runs —
  deterministic (`RF-OC-041`).
- **Q2 — definition stability.** The tool **definitions** (name/description/JSON
  schema) are **byte-identical** across equivalent turns / startup / session-continue,
  *and* across **three distinct project roots** with different working directories —
  i.e. descriptions do **not** interpolate the cwd/paths. (The strings "Working
  directory" / "session" appear only as static prose in tool descriptions.) New fact:
  `RF-OC-042`.
- **Q3 — tool-set change.** Disabling built-in tools via a disposable project config
  (`"tools": { "webfetch": false, "websearch": false }`) re-sorts the core cleanly to 9
  tools and keeps `execute` **last** (`edit, glob, grep, question, read, shell, skill,
  subagent, write, execute`). No order drift; the tail position of `execute` is stable.
- **Q4 — fingerprints.** `toolFingerprint` (order-insensitive) and
  `toolWireFingerprint` (order-sensitive) are **equal and stable** across all captured
  mains (semantic `08fa2584…`, wire `65ffbde1…`) — no reorder with a fixed set, no
  definition change.
- **Q5 — linter.** `lintSystemVolatility` emits **no** tool finding on equivalent
  requests and correctly flags `VOL-TOOL-SET` on a 12→10 set change and
  `VOL-TOOL-ORDER` (worst `medium`) on a same-set reorder — i.e. the tool rules are
  true-positive-capable, no false positive on the stable case.
- **Q6 — correction.** No semantic-safe correction is warranted: upstream already sorts,
  and the only non-sorted element (`execute`) is appended deterministically. **Outcome:
  no-op.**

## Structural notes

- OpenCode sorts the core tools ASCII-ascending before sending, then `execute` (the Code
  Mode tool) is appended after the sort. This matches the `toolWireFingerprint` caveat
  (`src/cache-engine-core.mjs`): the plugin's wire fingerprint is *registry order*, not
  byte-equal to the provider's sorted order; here both were stable anyway.
- Tool definitions are static text; only `messages[0]` (the system prompt) embeds the
  working directory (see `RF-OC-040` §5 of the P3-T1 report) — not the tools.

## Risks and limitations

- The route is a local mock; **no provider-measured** claim.
- Only one non-core (appended) tool (`execute`) was observable; a scenario with two+
  appended tools was not exercised (recorded as the next experiment).
- "Upstream sorts" is inferred from the ASCII-sorted wire order for a varying set
  (12 vs 10 tools); it is consistent and repeatable but not read from OpenCode source.

## Cleanup and integrity

- No managed config/plugin/service/state touched; captures under the temp root only.
- No credentials, prompt/reasoning content, or full bodies recorded or committed.
