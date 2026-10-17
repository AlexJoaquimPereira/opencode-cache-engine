# Phase 8 — reproducible benchmark and public documentation (P8-T1 …)

**Plan:** `docs/plans/v1.x.x-implementation-plan.md` §12 (+ §3B row 8, §3C row 8, §14 ladder,
§15 G6, §16 #10). **Parent task list:** `TODO.md` (Phase 8). Gated implementation — offline by
default; no request mutation; no provider calls without explicit authorization.

---

## P8-T1 — harness capability audit + gap analysis

**Task:** P8-T1 (`TODO.md`) — map plan §12's eight harness capabilities onto the shipped harness and
identify the gaps; map each benchmark-report field to its source — **before** designing the
reproducibility contract.

**Evidence:** every row traces to a file in `test/harness/capture/` (read in full: `run.sh`,
`inner.sh`, `mock-provider.mjs`, `diff-requests.mjs`, `decide.sh`, `prune.sh`,
`verify-date-relocation.mjs`, the `.test.sh` suites) or to a tracked store. `[O]` structurally
verified. **Provider measured: not performed.**

### 1. Capability matrix (plan §12)

| Capability | Status | Mechanism today | Gap |
|---|---|---|---|
| Baseline/candidate policy selection | **partial** | `OC_CAPTURE_ENGINE_CONFIG` injects one inline config per run; baseline-vs-candidate means two runs + `verify-date-relocation.mjs --unchanged` (an **off/on** pair, date-relocation-specific) | no generic baseline/candidate mode; the injected config is **not persisted** into the capture root |
| Offline capture + first-difference reporting | **yes** | `mock-provider.mjs` writes `req-NNN.json`; `diff-requests.mjs` pairs by request kind and reports the first differing section + canonical byte offset (JSON output) | — |
| Repeated equivalent turns + rollover tests | **yes** (structural) | `OC_CAPTURE_TURNS`, `OC_CAPTURE_CONTINUE`; rollover is **simulated** (the date-relocation verifier + fixtures) | a *provider* rollover (real calendar + cache reads) is **not offline** — needs authorization (ladder D) |
| Route/model/version metadata | **partial** | model via `OC_CAPTURE_MODEL`; route = the mock's `/v1/chat/completions`; the project config sits in the capture root | **no OpenCode version** and **no plugin version** are recorded (see G1) |
| Provider metrics when available | **no** (offline) | the mock returns a **fixed** `prompt_tokens: 10` and **no cache fields** | nothing to record offline; must be **labelled unavailable**, never inferred (G4) |
| Error/latency/extra-call recording | **partial** | errors: `status` (`turn_failed`, per-turn rc) + `run*.log` + `mock.log`; extra calls: **countable** from the captured requests (aux / summarizer / agent) but not summarised; **latency: not recorded** | no per-turn duration; no extra-call summary (G3, G8) |
| Redaction / local-only defaults | **yes** | `mock-provider.mjs` records only non-sensitive headers (presence flag for `authorization`); captures stay under the temp root; loopback-only; `bwrap --unshare-net`; private HOME/XDG | — |
| Machine-readable benchmark summary | **partial** | `diff-requests.mjs` prints a JSON structure (`count` + per-pair diffs) | no single envelope carrying versions/route/config/workload/errors/conclusion class (G6) |

### 2. Benchmark-report field map (plan §12)

| Report field | Source today | Availability |
|---|---|---|
| OpenCode / plugin versions | **none** | **gap (G1)** — must be added or recorded manually |
| Provider / model route | capture-root project config + request bodies | available |
| Policy conditions | the injected `OC_CAPTURE_ENGINE_CONFIG` (host env only) | **gap (G2)** — not persisted |
| Workload / repetition count | `status` (`runN_rc`) + captured-request count; `OC_CAPTURE_TURNS`/`OC_CAPTURE_CONTINUE` | available |
| Structural diff | `diff-requests.mjs` (JSON) | available |
| Wire verification | `verify-date-relocation.mjs` (**date relocation only**); otherwise `wireEffect:"not_observed"` | **partial (G7)** — must be labelled |
| Provider metrics | — | **unavailable offline (G4)** — label, never infer |
| Result distribution | only the last pair per request kind | **gap (G5)** — no distribution/repetition summary |
| Errors / confounders | `status`, `run*.log`, `mock.log` | available |
| Conclusion class (`structural`/`provider-measured`/`estimated`) | — | editorial; **must be explicit** (P8-T2 taxonomy) |

### 3. Gap list

- **G1 — version metadata.** No OpenCode or plugin version is recorded anywhere in a capture;
  `run.sh` only checks that the binary exists (`run.sh:157`).
- **G2 — policy conditions not persisted.** `OC_CAPTURE_ENGINE_CONFIG` is written into the sandbox
  HOME (`run.sh:175-181`) but not into the capture root, so a capture cannot be interpreted without
  the original shell history.
- **G3 — latency unrecorded.** No per-turn duration exists in `status`.
- **G4 — provider metrics unavailable offline.** The mock emits a fixed, fabricated usage constant;
  this is a **labelling** obligation, not a code gap.
- **G5 — no result distribution.** `diff-requests.mjs` keeps only the most recent pair per kind.
- **G6 — no benchmark envelope.** No single machine-readable object ties versions + route + config +
  workload + errors + conclusion class to the diff output.
- **G7 — wire verification is narrow.** Only the date relocation has a wire verifier; every other
  policy's wire status is structurally `not_observed` (`RF-OC-030`/`RF-OC-031`).
- **G8 — extra calls not summarised.** Aux/summarizer/agent requests are capturable but not counted.

### 4. Smallest fix per gap (input to P8-T2 / P8-T3)

| Gap | Smallest change |
|---|---|
| G1 | record `$OC2 --version` (and the package version) into a capture-root metadata file |
| G2 | persist the injected engine config (or a hash of it) into the same metadata file |
| G3 | append a per-turn duration to `status` in `inner.sh` |
| G4 | **no code** — the P8-T2 taxonomy must label provider metrics *unavailable* |
| G5 | summarise repetitions in `diff-requests.mjs` (or a thin wrapper) |
| G6 | emit one `benchmark.json` envelope beside `capture/` (versions, route, config, workload, per-turn rc, request counts, diff verdict, conclusion class) |
| G7 | **no code** — label wire status `not_observed` unless a wire verifier applies |
| G8 | count request kinds in the envelope (G6) |

**Smallest coherent design:** one additive `benchmark.json` written by `run.sh` at capture end
(G1, G2, G6, G8) + a per-turn duration line in `status` (G3) + a repetition summary in
`diff-requests.mjs` (G5). G4 and G7 are labelling obligations discharged by the P8-T2 taxonomy.

### 5. Evidence & acceptance

- Labels: **Structurally verified** (source read in full) / **Documented**. **Provider measured: not
  performed.**
- Acceptance: the capability matrix + the report-field map exist with an explicit gap list (G1–G8)
  and a smallest-fix per gap. **P8-T2 may proceed (subject to explicit authorization).**
