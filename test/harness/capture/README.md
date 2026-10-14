# Phase 1 capture harness

Reusable, **offline** two-request capture harness for the Phase 1 diagnostics.
It drives two equivalent OpenCode V2 turns against a loopback mock provider
inside a network-isolated `bubblewrap` sandbox, records the **serialized request
bodies** the provider receives, and reports the first structural difference.

It is deliberately small: it captures and diffs two requests. It is not a
general-purpose benchmark.

## What it does

1. Creates a disposable project under `/tmp/opencode/capture.*` with a mock
   provider (`@ai-sdk/openai-compatible` → `http://127.0.0.1:39420/v1`) and a
   project-local plugin shim that loads the repository's V2 adapter.
2. Runs `opencode run --standalone` twice (same prompt, same model) inside a
   `bwrap --unshare-net` sandbox with a private HOME/XDG.
3. The mock (`mock-provider.mjs`, loopback-only) writes each request it receives
   to `capture/req-NNN.json` — method, url, redacted headers, and JSON body.
4. `diff-requests.mjs` pairs captured bodies of the **same request kind** across
   runs (so equivalent requests are compared, not a primary agent request against
   an auxiliary one), compares them section by section (cache-prefix order:
   model, system/instructions, tools, options, then messages/input), and reports
   the first differing section, the first differing byte offset within the
   canonicalized (key-sorted) body, and an **expected / unexpected** classification.

## Run

```sh
test/harness/capture/run.sh
# overrides:
OC2=/path/to/opencode test/harness/capture/run.sh
OC_CAPTURE_TMPDIR=/some/writable/dir test/harness/capture/run.sh
OC_CAPTURE_TURN_TIMEOUT=180 test/harness/capture/run.sh
MOCK_PORT=39420 test/harness/capture/run.sh
OC_CAPTURE_RETENTION_MIN=1440 test/harness/capture/run.sh
# optional per-model capture, and an inline CacheEngine config written to the
# sandbox ~/.config/opencode/cache-engine.json (e.g. to enable an experimental
# policy for a wire test):
OC_CAPTURE_MODEL=mock/glm-5.3-flash test/harness/capture/run.sh
OC_CAPTURE_ENGINE_CONFIG='{"policies":{"glm53":{"stabilizeDate":true}}}' test/harness/capture/run.sh
# debug/test only — write the project for the configured port, no capture:
OC_CAPTURE_DRY_RUN=1 test/harness/capture/run.sh
# debug/test only — diff an existing capture dir, no capture, no provider:
OC_CAPTURE_ONLY_DIFF=/path/to/capture-dir test/harness/capture/run.sh
```

## Session-pair capture (P3-T1)

Beyond the default two equivalent turns, the harness reproduces a
**first-vs-subsequent** request pair and a ≥3-repeat determinism check:

```sh
OC_CAPTURE_TURNS=3 OC_CAPTURE_CONTINUE=1 test/harness/capture/run.sh
```

- `OC_CAPTURE_TURNS=<n>` — equivalent turns (integer ≥ 2; default 2).
- `OC_CAPTURE_CONTINUE=1` — append one `opencode run … --continue` turn, which
  produces a *subsequent* same-session request (history grows; `tools` and the
  system message stay byte-identical to the first request).

A fresh `opencode run` emits two requests — an auxiliary (title/summary) request
with **no tools**, then the main agent request — so `diff-requests.mjs` pairs them
by kind. Shape findings and the go/no-go are in
`docs/phase3-p3t1-capture-groundwork.md`; consumable fixture data is in
`test/fixtures/volatility-shapes.mjs`.

## Exit contract

| Code | Meaning |
|---:|---|
| 0 | captures completed; every paired difference identical or expected |
| 1 | captures completed; at least one unexpected structural difference |
| 2 | blocker: missing dependency, invalid/insufficient input, a failed or timed-out turn, or a missing temp root |

`run.sh` delegates the post-capture decision to `decide.sh` (so the contract is
testable without a sandbox) and propagates its status.

## Testing the contract

```sh
npm run test:harness        # runs all four below
# or individually:
test/harness/capture/exit-contract.test.sh
test/harness/capture/retention.test.sh
test/harness/capture/port-parity.test.sh
test/harness/capture/date-relocation.test.sh
```

Synthetic fixtures only (no sandbox, no provider). `exit-contract` exercises the
reporter CLI (relative + absolute), `decide.sh` (turn failure, insufficient
captures, identical/expected/unexpected), `run.sh` propagation and blockers, and
the `inner.sh` timeout validation and timeout-as-failure signalling. `retention`
covers capture-root pruning; `port-parity` covers the host/sandbox port;
`date-relocation` covers the P2-T3 wire verifier's exit contract. All exit
nonzero on failure (`npm run test:harness` stops at the first failing one).

## Timeouts

Each `opencode run` turn is bounded by `OC_CAPTURE_TURN_TIMEOUT` seconds (default
120, positive integer). A timed-out or failed turn writes `turn_failed=1` to the
run status, makes `inner.sh` exit nonzero, and is treated as a blocker (exit 2)
by `decide.sh` — it is never compared as if it had succeeded. The timeout utility
must be present (`run.sh` reports a blocker otherwise).

## Retention

Capture roots are written under `OC_CAPTURE_TMPDIR` (default `/tmp/opencode`) as
`capture.*`. Each run prunes `capture.*` roots older than
`OC_CAPTURE_RETENTION_MIN` minutes (default 1440 = 24h) before creating a new one;
set it to `0` to disable pruning. Captured `req-NNN.json` files contain the full
request body (the harness only ever sends its own synthetic prompt) and stay
local to the temp root; they are not written into the repository.

## Classification criteria (explicit)

- **expected** — the two requests are identical, or every differing section is a
  conversation section (`messages` / `input`). Conversation growth is normal.
- **unexpected** — any structural cache-prefix section differs: route/model,
  `system`/`instructions`, `tools`, or a cache option/key
  (`prompt_cache_key`/`promptCacheOptions`/…). These can invalidate the prefix.

The diff is a **structural** signal only. It does not and cannot prove a
provider-side cache effect.

## Guarantees and constraints

- Offline: the mock binds `127.0.0.1` only; no real provider is contacted; no
  credentials are used or recorded (authorization header **values** are never
  written — only a presence flag).
- Isolated: `bwrap --unshare-net`, private HOME/XDG; the managed OpenCode
  configuration and services are never touched.
- Read-only vs requests: the harness captures the body as received; the plugin's
  diagnostics do not mutate requests (verified by the Phase 1 tests).

## Isolation prerequisite

Requires `bubblewrap`, `node`, and an OpenCode V2 binary. If any is missing the
script exits `2` with a `BLOCKER:` message and does not fall back to an
unisolated request.

## Files

- `run.sh` — host orchestrator (safety checks, temp root, `bwrap`, report).
- `inner.sh` — runs inside the sandbox (mock + two bounded turns).
- `decide.sh` — post-capture decision (turn failure, capture count, diff) + exit
  contract; testable with synthetic roots.
- `mock-provider.mjs` — loopback OpenAI-compatible mock that captures bodies.
- `diff-requests.mjs` — structural first-difference reporter + input validation
  (also unit tested from `test/cache-engine.test.mjs`).
- `prune.sh` — capture-root retention pruning (directly testable).
- `exit-contract.test.sh` — reproducible exit-code checks with synthetic fixtures.
- `retention.test.sh` — retention/prune checks (old/new pruned/retained, `=0`
  disables, unrelated paths untouched, fail-closed on invalid input).
- `port-parity.test.sh` — host base-URL vs sandbox `MOCK_PORT` parity via dry-run.
- `verify-date-relocation.mjs` — P2-T3 offline WIRE verifier: compares an
  off/on capture pair and asserts, on the serialized system content, that the
  daily date line moved past the `<env>` block with the date value and non-date
  content preserved (`--unchanged` for the control).
- `date-relocation.test.sh` — hermetic exit-code checks for the wire verifier
  (synthetic off/on capture dirs; no sandbox, no provider).
