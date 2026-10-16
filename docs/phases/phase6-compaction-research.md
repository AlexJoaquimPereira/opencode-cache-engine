# Phase 6 — compaction and memory-boundary research (P6-T1 …)

**Plan:** `docs/plans/v1.x.x-implementation-plan.md` §10. **Parent task list:** `TODO.md`
(Phase 6). This is a **research, read-only/offline** phase: no request mutation, no on-disk
history change, no provider calls. A no-op / insufficient-evidence outcome is valid.

---

## P6-T1 — compaction mechanism + hook inventory

**Task:** P6-T1 (`TODO.md`) — enumerate exactly what the runtime and both adapters expose about
compaction, and decide whether that is **sufficient** to characterise the compaction cache
boundary (the Phase-6 kill criterion) before any capture or cost analysis.

**Verdict: SUFFICIENT** to proceed to P6-T2 — with the recorded limits in §4.

### 1. Compaction surfaces by adapter

| Surface | Adapter | What it carries | What it enables |
|---|---|---|---|
| `experimental.session.compacting` (hook) | V1 | `input.sessionID` + the compaction context; mutable `output.context[]` | append the digest template **at the boundary** (`src/cache-engine.ts:1319-1330`) |
| `input.agent === "compaction"` (in `chat.params`) | V1 | the compaction request's params/model | detect a compaction **request**; apply GPT `<root>:compact` key isolation (`src/cache-engine.ts:912-913,926`) |
| `event` → `"session.compacted"` | V1 | `properties.sessionID` | set `pendingInsert = true`; emit a `compaction` **observation** record carrying cumulative `read`/`write` at the boundary (`src/cache-engine.ts:1053-1069`) |
| `model.request` `kind === "compaction"` | V2 | `SessionModelRequest` incl. `kind ∈ {primary,compaction,title,generate}` (`RF-OC-018`) | **available but unused** — V2 always derives the key with `compaction:false` (`src/cache-engine-v2.mjs:331`) |
| `compaction` session hook | V2 | declared in the hook surface (`RF-OC-018`) | **not registered** — V2 registers only `context` + `model.request` (`src/cache-engine-v2.mjs:567-568`) |
| `session.context({sessionID})` | V1 + V2 | the active history — messages **after the last compaction** (`RF-OC-021`) | post-boundary history; the boundary is the sole truncation point |

### 2. Mechanisms (as shipped)

- **Digest template.** `DIGEST_TEMPLATE` (`src/cache-engine-core.mjs:43-48`) is appended by V1's
  `experimental.session.compacting` handler when `digestDecision({ compactTemplate, pendingInsert })`
  is true (`src/cache-engine-core.mjs:1144-1146`) — i.e. `compactTemplate === true` (default
  **true**, `:144`) **and** `pendingInsert === true`. `pendingInsert` starts `true`
  (`src/cache-engine.ts:240`), is set `true` by `session.compacted` (`:1056`), and is reset to
  `false` after an insert (`:1324`). Best-effort: a failure records a `telemetry-error` and never
  breaks compaction (`:1325-1329`).
- **GPT compaction isolation.** `gptCacheKeyFor(root, { compaction })` returns `` `${root}:compact` ``
  when `compaction` is set (`src/cache-engine-core.mjs:1044-1052`); V1 applies it when
  `compactionCacheIsolation === true` (default **true**, `src/cache-engine-core.mjs:82`) and the
  request is a compaction (`src/cache-engine.ts:912-913,926`). Its boundary record `gpt_compaction`
  is staged **`applied`** (`src/cache-engine-core.mjs:248`).
- **Record staging.** The `compaction` record kind is staged **`observation`**
  (`src/cache-engine-core.mjs:238`) — it reports cumulative usage, never a claimed effect.

### 3. V1/V2 parity gap (finding)

V2 registers **only** `context` and `model.request` (`src/cache-engine-v2.mjs:567-568`) and has
**no compaction branch**: no digest-template insert, no `session.compacted` handling, and no key
isolation (always `compaction:false`, `:331`). Consequences for Phase 6:

- every cost/behaviour statement must be **scoped per adapter**;
- the only V2 compaction signal is `model.request.kind`, and it is currently ignored.

### 4. Sufficiency verdict (kill criterion)

**SUFFICIENT**, because:

1. **Wire truth is available offline.** The serialized request stream across a boundary is captured
   by the **harness**, not the hook (`RF-OC-030`: a hook payload is not the wire).
2. **The runtime labels the boundary.** V1: `session.compacted` + `agent === "compaction"`.
   V2: `model.request.kind === "compaction"`.
3. **Provider-reported read/write counts are available** (best-effort, `RF-OC-021`) for the cost
   model in P6-T3.

**Recorded limits / risks (carried into P6-T2..P6-T5):**

- **Offline trigger risk.** Whether the harness can *trigger* a real compaction against the mock
  provider is **unverified** — a **P6-T2** question. If it cannot, P6-T2 falls back to synthetic
  **fixture** shapes and records the infeasibility; P6-T3's cost model then rests on structure and
  is labelled *inferred*.
- **V2 parity.** No compaction hook or branch → V2 statements depend on `model.request.kind` only.
- **Truncation.** `session.context` cannot show the **pre**-boundary state after the fact
  (`RF-OC-021`); only the harness's captured stream retains it.
- **No `kind` in `context`.** A compaction request cannot be detected from the `context` hook
  (`RF-OC-018`), so any V2 boundary logic must live in `model.request`.

### 5. Evidence & acceptance

- Labels: **Structurally verified** (source `file:line`); **Documented** (`RF-OC-018`,
  `RF-OC-021`). **Provider measured: not performed.**
- Acceptance: every compaction surface is enumerated with what it exposes; the sufficiency verdict
  is explicit with its limits. **P6-T2 may proceed.**

---

## P6-T2 — offline before/after-compaction capture

**Task:** P6-T2 (`TODO.md`) — reproduce a compaction boundary offline and capture the requests
before and after (plus a later reuse request), then identify the unchanged prefix regions.

**Verdict: a compaction boundary IS reproducible offline** (no synthetic-fallback needed).

Reproduce (from the repo root):

```sh
OC_CAPTURE_CONTEXT_LIMIT=2000 OC_CAPTURE_SUMMARY_OK=1 \
OC_CAPTURE_TURNS=3 OC_CAPTURE_CONTINUE=1 \
OC_CAPTURE_PROMPT="$(head -c 8192 /dev/zero | tr '\0' x)" \
test/harness/capture/run.sh
```

### Harness extension

Three additive, backward-compatible edits — the default path (no new envs) is byte-identical
(verified: a clean default run exits 0 with paired diffs identical, and `npm run test:harness`
passes):

- `run.sh` — `OC_CAPTURE_CONTEXT_LIMIT` (positive int; fail-closed exit 2) injects
  `"limit": { "context": N, "output": 4096 }` into the mock model entry; `OC_CAPTURE_SUMMARY_OK`
  (0/1). Both are passed into the sandbox.
- `inner.sh` — `OC_CAPTURE_PROMPT` (default exactly `say hi`) as the turn message.
- `mock-provider.mjs` — with `OC_CAPTURE_SUMMARY_OK=1`, a summarizer request (body containing
  `You MUST summarize the conversation`) receives a valid template summary instead of `ok`.

### Q1 — Can the offline harness produce a compaction without a real provider?

**Yes.** Forcing `limit.context=2000` with an ~8 KB synthetic user message makes OpenCode run its
compaction/summarizer step **before** the agent request. Without `OC_CAPTURE_SUMMARY_OK=1` the
mock's `ok` fails OpenCode's template check
(`Session.StepFailedError: Compaction summary did not match the required template`) and the turn
errors — the compaction still *triggered*, but no post-compaction request is emitted.

### Q2 — Serialized shape before vs after

Per turn (deterministic across ≥3 equivalent turns):

| # | request | messages | tools | marker |
|---|---|---|---|---|
| 1 | aux title | 2 | 0 | — |
| 2 | compaction summarizer (full history) | 3 | 12 | `You MUST summarize the conversation …` |
| 3 | post-compaction agent | 2 | 12 | `<conversation-checkpoint>` |

- **before (req-002)** — `system(8267)`, `user(filler 8102)`, `user(summarizer instruction 2723)`; 12 tools.
- **after (req-003)** — `system(8267, byte-identical)`, `user(checkpoint + summary 478)`; 12 tools (identical).

Top-level keys are the same on both:
`max_completion_tokens,messages,model,store,stream,stream_options,tools`. The agent request with the
full history is **never sent before compaction** (compaction triggers on the overflowing user
message, on the first request of the session).

### Q3 — Unchanged prefix regions

**Everything except `messages`.** The system message and the `tools` array are **byte-identical**
across the boundary (tool count 12); only the history is replaced (full history → a single
`<conversation-checkpoint>` user message). This is the structural cache-prefix property Phase 6
needs: compaction invalidates the **conversation tail**, not the **prefix**.

### Q4 — Digest-template insert present?

**Not on this route.** The digest template is a **V1** behaviour (`experimental.session.compacting`);
the harness loads the **V2** adapter, which has no compaction branch (P6-T1 §3). The checkpoint
message is OpenCode's own, not the plugin's digest template.

### Q5 — Determinism

Structurally deterministic across the equivalent turns (turns 1–3 each produced the identical
aux → summarizer → checkpoint sequence); the default (no-overflow) run is byte-identical across
paired requests. The session-continue turn (`OC_CAPTURE_CONTINUE=1`) re-compacts and its
compaction failed the template check (rc=1) — recorded as a limit, not a blocker for the boundary pair.

### Deliverables

- Harness support for a forced offline compaction (three files, backward-compatible).
- `test/fixtures/compaction-shapes.mjs` — pinned structural shapes + `classifyRequest` /
  `prefixPreserved` helpers.
- `phase6/p6t2:` test in `test/cache-engine.test.mjs` (hermetic; `npm test` 379/0).
- `RF-OC-049` recorded in `docs/research-findings.md`.

### Limits carried into P6-T3..P6-T5

1. **No cache read/write counts offline** — the mock returns fixed usage and no cache fields, and
   no plugin telemetry file is written in these runs. P6-T3's cost model is therefore
   **modelled/inferred**, never provider-measured.
2. **No pre-compaction agent request** — the forced tiny limit compacts every turn, so the
   before/after pair is *summarizer → checkpoint*, not *agent → agent*. A session that accumulates
   first is a P6-T3/T4 refinement if needed.
3. **Version drift** — captured on OpenCode **2.0.30** (the harness binary); prior captures were
   2.0.26. Shapes are consistent; the version is recorded in `RF-OC-049`.
4. The continue-turn re-compaction failed the template check — the `--continue` path needs its own
   trigger tuning if multi-turn accumulation is required.

### Evidence & acceptance

- Labels: **Structurally verified** (serialized bodies) / **Offline/mock verified**.
  **Provider measured: not performed.**
- Acceptance: both boundary requests + the reuse request are captured; the unchanged prefix is
  quantified; no request mutated; no provider contacted. **P6-T3 may proceed.**

---

## P6-T3 — compaction cache-cost accounting

**Task:** P6-T3 (`TODO.md`) — account for the cache cost around the boundary: the
provider-reported reads/writes at and after the boundary, and the **one-time cost of
establishing the new prefix** — separating **observed** counts from a **modelled** estimate.

**Headline: no cache read/write count is observable offline.** The mock returns no cache
fields and fixed usage, and no plugin telemetry file is written in these runs (verified: zero
`*.jsonl`, zero `cache-metrics*`, zero `"kind":"compaction"` records in the capture root HOME).
Every cost figure below is therefore **Inferred (model)**, never provider-measured. Missing
metrics are *unavailable*, **not zero**.

### Q1 — What is observable at/after the boundary, and what is unavailable vs zero?

| Quantity | Offline (this harness) | Live runtime |
|---|---|---|
| provider cache `read` / `write` | **unavailable** (mock emits none) | from provider usage fields |
| provider prompt/completion tokens | **unavailable** — the mock returns a fixed `prompt_tokens: 10` constant (`mock-provider.mjs:81,121`), which is fabricated, not measured | from provider usage |
| plugin accounting record | **none written** (no telemetry file) | V1 `session.compacted` → `kind:"compaction"` record with cumulative `read`/`write` (`src/cache-engine.ts:1053-1069`); V2 has no compaction branch |
| segment sizes (chars) | **structurally verified** (below) | — |

So the only observed input to a cost model is the **serialized size** of each region.

### Observed — serialized segment sizes (structurally verified)

From the retained capture (`/tmp/opencode/capture.JNKhJd`), `req-002` (pre) vs `req-003` (post):

| Region | pre (chars) | post (chars) | note |
|---|---|---|---|
| system message | 8267 | 8267 | **byte-identical** |
| tools JSON | 13534 | 13534 | **byte-identical** |
| history → checkpoint user message(s) | 8102 + 2723 | 478 | **replaced** |
| body (serialized) | 33120 | 22705 | |
| `messages` count | 3 | 2 | |

Stable prefix `P = system + tools` = **21801 chars**, unchanged across the boundary.

### Modelled — the one-time re-prefill cost (inferred)

A boundary replaces the message region while the stable prefix stays cache-eligible:

| Term | chars | ≈ tokens (÷4) |
|---|---|---|
| `P` stable prefix (system + tools) | 21801 | ≈ 5450 |
| `H` replaced history (filler + summarizer instruction) | 10825 | ≈ 2706 |
| `C` checkpoint (new continuation) | 478 | ≈ 120 |

Modelled one-time cost of one boundary:
- **summarizer input** ≈ `H` + instruction ≈ **≈2700 tokens** (uncached — the summary request
  carries the full history);
- **new continuation** ≈ `C` ≈ **≈120 tokens** (written/processed once after the boundary);
- **summary output** — **not observable** offline (the mock's reply is a fixed template): a
  real cost omitted from the model.

Steady state: later requests carry ≈ `P + C` ≈ **5570 tokens** (a cache-eligible prefix plus
the checkpoint), instead of a growing history.

**This is a model, not a measurement** — not a savings claim. The reuse comparison is P6-T4.

### Q3 — interaction with the GPT `<root>:compact` isolation

The V1 adapter isolates a compaction request's key to `<root>:compact`
(`src/cache-engine-core.mjs:1048-1052`, applied at `src/cache-engine.ts:912-926`) so a
compaction write cannot pollute the live-session namespace. That is a **structural** decision:
on the tested routes the GPT cache field is **not wire-attributable** (`RF-OC-047`, Phase 4 —
Gate 4 NOT PASS), so the isolation cannot be costed or credited. V2 has no compaction branch
at all (P6-T1 §3).

### Q4 — Assumptions (all explicit)

1. **char→token ratio 4:1** — a heuristic; the harness never tokenizes and the mock's reported
   tokens are a fixed constant, so no tokenizer is available offline.
2. The stable prefix is cache-eligible across the boundary — the bytes are identical (measured).
3. Cache **writes are billed** on the tested route — **unverified** (true for MiniMax M2.x
   explicit caching; not established here).
4. The summary **output** token cost is excluded (unobservable offline).
5. Provider cache behaviour is unknown offline; nothing here is provider-measured.

### Evidence & acceptance

- Labels: **Structurally verified** (segment byte sizes) / **Inferred** (token + cost model).
  **Provider measured: not performed.**
- Acceptance: the observed/modelled split is recorded with explicit assumptions, missing
  metrics are stated as unavailable (not zero), and no figure is presented as measured
  savings. **P6-T4 may proceed.**

---

## P6-T4 — reuse vs re-prefill comparison

**Task:** P6-T4 (`TODO.md`) — compare the one-time re-prefill cost (P6-T3) against reuse on later
requests after a boundary, and state whether the new prefix is reused (and how soon).

**Headline: reuse is *structurally eligible immediately*, but no provider reuse is observable
offline.** The comparison is **structural**, not measured.

### Q1 — Do later requests after the boundary carry the re-usable prefix, and how soon?

Offline no cache read is observable (P6-T3). Structurally, **yes — from the very next request**:

- the **stable prefix** (system `8267` bytes + `tools`, count 12) is **byte-identical** across the
  boundary, across turns, and across sessions (verified on `req-003` / `req-006` / `req-009`);
- within a session the serialized request is **append-only**: a later request's `messages` array is
  a byte-identical prefix-extension of the earlier one (`req-009` ⊂ `req-010` ⊂ `req-011`).

So every post-boundary request sends a prefix a provider prefix cache could read in full —
eligibility begins on the **next** request (structural count = 1).

### Q2 — Is there a reuse threshold that amortises the re-prefill?

**Not determinable offline.** Structurally, because reuse is eligible from the next request, the
P6-T3 one-time cost (≈2706 summarizer-input tokens + ≈120 continuation tokens) is spread over the
subsequent requests in the session; the break-even count depends on the provider's cache economics
(unobservable) and on the **unmeasured** summary-output cost. A session with a single post-boundary
request amortises nothing.

### Q3 — Does compaction isolation help or hurt reuse?

Structural only (`<root>:compact`, P6-T3 Q3; **not wire-attributable**, `RF-OC-047`): a distinct key
namespace for the compaction request means (a) it cannot read the live-session prefix cache, and
(b) its write cannot pollute the live namespace. Net it trades a possible summarizer cache read for
protection of the live prefix — neither effect is measurable on the tested route.

### Q4 — Confounders and the conclusion

Confounders: no provider measurement; the forced tiny limit re-compacts (the `--continue` turn
triggered a **second** boundary, which used a different summarizer instruction and *preserved* the
prior checkpoint — `RF-OC-049` notes 4/5); turns 1–3 are separate sessions (within-session reuse is
observable only via `--continue`); the continue turn failed its template check (rc=1); the mock's
usage is a fixed constant.

**Conclusion (structural / inconclusive for benefit):** the post-boundary prefix is stable and
reuse-eligible on the next request, so a provider prefix cache *can* reuse it; whether it *does*,
and the net benefit versus the summarizer cost, is **not established offline**. No provider benefit
claim.

### Evidence & acceptance

- Labels: **Structurally verified** / **Inconclusive** (no provider measurement).
  **Provider measured: not performed.**
- Acceptance: the comparison + confounders are recorded, the conclusion is labelled structural, and
  no benefit is claimed beyond the evidence. **P6-T5 may proceed.**
