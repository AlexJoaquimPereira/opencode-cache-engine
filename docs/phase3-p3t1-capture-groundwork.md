# Phase 3 — P3-T1: volatility capture groundwork

**Task:** P3-T1 (`TODO.md`) — establish a reusable **offline** procedure that
reproduces the two comparison pairs every Phase-3 thread needs, commit a fixture
set for them, and state an explicit go/no-go **before** ranking any volatility.

**Type:** research — read-only; **offline/mock only**. No request is mutated; no
provider is contacted.
**Depends on:** Phase 1 (G1 met — diagnostics + capture harness).
**Evidence basis:** OpenCode 2.0.26, Node 22.23.2, the Phase 1 capture harness
(loopback mock `127.0.0.1`, `bwrap --unshare-net`, private HOME/XDG).

Evidence labels used here: *Structurally verified* / *Offline/mock verified*.
**Provider measured: not performed.**

## 1. What changed (harness only)

The existing harness ran exactly **two equivalent turns**; it could not produce a
first-vs-subsequent pair nor a ≥3-repeat determinism check. Per the kickoff
contract's "extend only if needed" clause, `inner.sh`/`run.sh` gained two opt-in
knobs (defaults preserve the original two-turn behavior exactly):

- `OC_CAPTURE_TURNS=<n>` — number of equivalent turns (integer ≥ 2; default 2).
- `OC_CAPTURE_CONTINUE=1` — append ONE session-continue turn (`opencode run … --continue`),
  which yields a "subsequent" request in the last session (default 0).

Invalid values fail closed (exit 2), matching the existing timeout validation.
`run.sh` passes both through into the sandbox. Hermetic coverage lives in
`test/harness/capture/exit-contract.test.sh`; the fixture data lives in
`test/fixtures/volatility-shapes.mjs`.

## 2. Procedure

Both pair types are reproduced by the committed harness:

```sh
# equivalent-turn pair (two fresh runs) — unchanged default:
test/harness/capture/run.sh

# first-vs-subsequent pair + ≥3-repeat determinism (3 equivalent turns + 1 continue):
OC_CAPTURE_TURNS=3 OC_CAPTURE_CONTINUE=1 test/harness/capture/run.sh
```

Each run writes serialized request bodies to `<root>/capture/req-NNN.json`; the
post-capture decision (`decide.sh` → `diff-requests.mjs`) pairs requests of the
same *kind* and reports the first differing section/byte with an expected /
unexpected classification. Captured bodies stay in the temp root (only the
harness's own synthetic prompt ever appears) and are never committed.

## 3. Findings (Q1–Q6)

- **Q1 — requests per run / kinds.** One fresh `opencode run --standalone` emits
  **two** requests: first an **aux** (title/summary) request — kind `model,store`,
  **no tools**, roles `system>user` — then the **main** (agent-loop) request —
  kind `max_completion_tokens,model,store,tools`, **12 tools**. A session-continue
  run emits **one** request (the main; the title is not regenerated).
- **Q2 — subsequent-request mechanism.** `opencode run … --continue` produces a
  genuine **subsequent same-session request** (roles grow `system>user>assistant>user`).
  Variadic messages (`opencode run "a" "b"`) do **not** create multiple turns (they
  collapse to one). Hook observability of "startup" is deferred to P3-T3.
- **Q3 — per-section stability.** Across equivalent turns the main requests are
  **byte-identical** (all sections). First-vs-subsequent differs **only** in
  `messages` (conversation growth); `model`, `tools`, and the system message are
  byte-identical (first differing canonical byte ≈ immediately after the system
  message).
- **Q4 — startup tool readiness.** No pending/connected/missing tool difference was
  observable on the local warm route (tools byte-identical across all requests).
  Whether the plugin hook can *see* readiness is out of P3-T1's scope (P3-T3).
- **Q5 — determinism.** Three equivalent turns in one capture were **byte-identical**
  (and matched a second, independent capture run) → deterministic ≥3 repeats.
- **Q6 — non-mutation.** The V2 adapter shim is loaded during capture and the
  requests are byte-identical across repeats; the Phase 1 §3C "diagnostics-only
  leaves the serialized request byte-identical" threshold is met by the existing
  diagnostics tests.

## 4. Observed request shapes (2.0.26, Chat Completions route)

- Main top-level keys: `max_completion_tokens, messages, model, store, stream,
  stream_options, tools`. No `prompt_cache_key` on this (non-GPT, mock) provider.
- **Tool order** (stable across all runs): `edit, glob, grep, question, read, shell,
  skill, subagent, webfetch, websearch, write, execute`. The first **11 are
  ASCII-sorted**; `execute` (the Code Mode tool) is **appended after the sorted
  core** and is therefore **not** in sort position — an ordering signal for P3-T2.
- The **system prompt is inside `messages[0]`** (role `system`, ~7.5 KB on the
  harness project), not a top-level `system` key.
- The system prompt embeds the working directory (`<env>` block), so it varies by
  project path — relevant to P3-T4 (project-context classification).

## 5. Gap surfaced (feeds P3-T4/P3-T3)

Because the system prompt rides inside `messages`, and `diff-requests.mjs`
classifies **every** `messages` change as *expected*, **system-prompt drift is
invisible** to the current classifier. Any Phase-3 thread that must rank system /
instruction volatility (P3-T4) has to compare the system message explicitly
(`messages[0].content`) rather than rely on the section classifier. This is
recorded now so P3-T4 does not mistake "expected" for "stable".

## 6. Deliverables

- Harness knobs + pass-through + hermetic coverage (`inner.sh`, `run.sh`,
  `exit-contract.test.sh`).
- Fixture set: `test/fixtures/volatility-shapes.mjs` (request kinds, tool order,
  pair expectations), consumed by `test/cache-engine.test.mjs`.
- This procedure/report.

## 7. Go/no-go

**GO.** Both pair types reproduce deterministically offline; the downstream ranking
(P3-T2..P3-T5) is supported by these captures. P3-T2 (tool ordering) can proceed
using the recorded tool-order baseline and the equivalent/subsequent pair harness.
Caveat: P3-T4 must use an explicit system-message comparison (see §5).

## 8. Risks and limitations

- The route is a local mock (OpenAI-compatible), not a real provider; §7's
  "provider measured" is explicitly not claimed.
- "Subsequent" is a session-continue request across processes; a *second request
  within one process* (tool-loop) was not required by the contract and is not
  covered.
- Tool order and system size are OpenCode-version-coupled; re-verify per version.

## 9. Cleanup and integrity

- No managed OpenCode config, plugin, service, or user state was touched; captures
  live under the temp root and are not committed.
- No credentials, authorization values, prompt/reasoning content, or full request
  bodies were recorded or committed.
