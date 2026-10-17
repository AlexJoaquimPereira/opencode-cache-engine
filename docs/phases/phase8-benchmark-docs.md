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

---

## P8-T2 — reproducibility contract + claims taxonomy

**Task:** P8-T2 (`TODO.md`) — fix the documented command(s), the meaning of "the same structural
result", and the taxonomy labelling every conclusion.
**Type:** design decision — **authorized by the user (2026-10-17)**. Read-only.
**Provider measured: not performed.**

### The contract

**Prerequisites (documented, no credentials):** Linux with `bubblewrap`; Node ≥ 22; an OpenCode V2
binary (`OC2`, default `~/.opencode/bin/opencode`). The mock provider binds loopback only and the
sandbox runs `bwrap --unshare-net`.

**Documented commands**

```sh
# baseline (two equivalent turns)
test/harness/capture/run.sh

# determinism (three equivalent turns + a session-continue turn)
OC_CAPTURE_TURNS=3 OC_CAPTURE_CONTINUE=1 test/harness/capture/run.sh

# policy A/B (baseline vs candidate) — two runs + the wire verifier
OC_CAPTURE_ENGINE_CONFIG='{"policies":{"glm53":{"stabilizeDate":true}}}' test/harness/capture/run.sh
node test/harness/capture/verify-date-relocation.mjs <offCaptureRoot> <onCaptureRoot>
```

**"The same structural result" means:** the same **exit-contract verdict** (`0` identical/expected-
only, `1` an unexpected structural difference, `2` a blocker) **and** a `benchmark.json` whose
`diff.verdict` and `requests.kinds` match — for the same `OC_CAPTURE_*` inputs and the same OpenCode +
plugin versions. Provider-reported numbers are explicitly **out of scope** for reproduction.

### Claims taxonomy (binding)

| Class | Meaning | Use in a published benchmark |
|---|---|---|
| `structural` | a serialized-request observation (diff, prefix, marker) | **allowed** — the harness's only offline class |
| `provider-measured` | a provider-reported number (cache read/write, tokens) from an **authorized** provider experiment | only with the authorization and that run's evidence |
| `estimated` | a model over stated assumptions (e.g. the P6-T3 re-prefill) | allowed, **with the assumptions stated** |

**Rules**

1. A `structural` result **never** implies a provider benefit.
2. Offline, `providerMetrics` is **`unavailable`** — never zero, never inferred.
3. `wireVerification` is **`not_observed`** unless a wire verifier applies (today only the date-relocation
   verifier does; `RF-OC-030`/`RF-OC-031`).
4. Competitor numbers are **`author-reported`** unless independently reproduced.

### Redaction / local-only defaults (preserved)

Captures contain only the harness's synthetic prompt; `authorization` **values** are never recorded
(presence flag only); captures stay under the temp root; the mock is loopback-only; `bwrap
--unshare-net` with a private HOME/XDG. A published benchmark must not add real prompts, credentials,
or provider bodies.

### Acceptance

Recorded and user-authorized (2026-10-17). **P8-T3 may proceed.**

---

## P8-T3 — benchmark harness gaps (implemented)

**Task:** P8-T3 (`TODO.md`) — implement only the gaps P8-T1 proved missing, under the P8-T2 contract.
**Type:** implementation — **authorized** (2026-10-17); offline. No request mutation; no provider.

### Delivered

- `test/harness/capture/benchmark.mjs` (**new**) — assembles `benchmark.json` for a capture root:
  pure helpers `parseStatus` / `summarizeRequests` / `summarizeRepetitions` + `buildBenchmark`, and a
  CLI that writes the envelope. **Read-only**; never contacts a provider.
- `run.sh` — invokes `benchmark.mjs` after the sandbox run, **best-effort** (it never changes the
  exit contract), passing the resolved workload env.
- `inner.sh` — records the OpenCode version once (`opencode --version` → `opencode-version.txt`, **G1**)
  and a per-turn duration (`runN_ms`, **G3**; the line is omitted when `date` lacks millisecond
  precision, so no bogus value is written).
- `diff-requests.mjs` — exports `kindOf` (additive; no behaviour change).
- `exit-contract.test.sh` — counts **turn** invocations only (a `--version` probe is not a turn) and
  the sleep stub answers `--version`.
- Harness README — the "Benchmark envelope (P8-T3)" section.
- Tests (`npm test`, **391/0**; 2 new): envelope assembly from a synthetic root (+ `parseStatus`);
  CLI write + missing-root blocker.

### Envelope (verified in situ — a real default capture)

`plugin 1.4.0` · `opencode v2.0.32` (**G1**) · `model`/`provider` · `engineConfig: null` (**G2**) ·
`workload {turns:2, continue:false, promptBytes:6, mockPort:39420}` ·
`turns[{n:1,rc:0,durationMs:705},{n:2,rc:0,durationMs:645}]` (**G3**) · `requests.total 4` + per-kind
census (**G8**) · `diff.verdict "expected"` · `repetitions` per kind (**G5**) ·
`evidence {conclusionClass:"structural", providerMetrics:"unavailable", wireVerification:"not_observed"}`
(**G4/G7**).

### Invariants

offline; no provider calls; **no request-behaviour change**; the envelope is best-effort and cannot
alter the exit contract; the default capture path is unchanged (a clean default run still exits 0 with
identical paired diffs, and all four harness suites pass).

### Completion rule

P8-T3 is complete when the gaps close and `npm test` + `npm run test:harness` pass. **P8-T4 may
proceed.**
