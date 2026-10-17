#!/usr/bin/env bash
# Runs INSIDE the bubblewrap sandbox (invoked by run.sh). Starts the loopback
# mock provider, drives N equivalent OpenCode turns (default 2; see
# OC_CAPTURE_TURNS) plus an optional session-continue turn (OC_CAPTURE_CONTINUE),
# each bounded by a per-turn timeout), and stops. A failed or timed-out turn is
# recorded in $CE/status as `turn_failed=1` so the orchestrator refuses to compare.
#
# Env (optional):
#   OC_CAPTURE_PROMPT   turn message (default exactly `say hi`). Set to a large
#                       synthetic prompt to force a session-context overflow.
set -uo pipefail

: "${CE:?CE (disposable root) required}"
: "${REPO:?REPO required}"

CAPTURE_DIR="$CE/capture"
MOCK_PORT="${MOCK_PORT:-39420}"
TURN_TIMEOUT="${OC_CAPTURE_TURN_TIMEOUT:-120}"
OC_BIN="${OC_BIN:-/oc/opencode}"
CAPTURE_MODEL="${OC_CAPTURE_MODEL:-mock/synthetic}"
export CAPTURE_DIR MOCK_PORT

# Validate the per-turn timeout: positive integer only.
case "$TURN_TIMEOUT" in
  ''|*[!0-9]*) echo "BLOCKER: invalid OC_CAPTURE_TURN_TIMEOUT='$TURN_TIMEOUT'" >&2; exit 2 ;;
esac
if [ "$TURN_TIMEOUT" -le 0 ]; then echo "BLOCKER: OC_CAPTURE_TURN_TIMEOUT must be > 0" >&2; exit 2; fi
command -v timeout >/dev/null 2>&1 || { echo "BLOCKER: 'timeout' not found" >&2; exit 2; }

# Turn plan (P3-T1 session-pair capture). Validated fail-closed BEFORE any I/O (so
# invalid input is exit 2, never masked by a later cd/exit 3). Defaults preserve the
# original two equivalent turns exactly:
#   OC_CAPTURE_TURNS   number of equivalent turns (integer >=2; default 2)
#   OC_CAPTURE_CONTINUE=1  append one session-continue turn (`--continue`), which
#                          produces a "subsequent" request in the last session.
TURNS="${OC_CAPTURE_TURNS:-2}"
case "$TURNS" in ''|*[!0-9]*) echo "BLOCKER: invalid OC_CAPTURE_TURNS='$TURNS'" >&2; exit 2 ;; esac
if [ "$TURNS" -lt 2 ]; then echo "BLOCKER: OC_CAPTURE_TURNS must be >= 2" >&2; exit 2; fi
CONTINUE="${OC_CAPTURE_CONTINUE:-0}"
case "$CONTINUE" in 0|1) : ;; *) echo "BLOCKER: invalid OC_CAPTURE_CONTINUE='$CONTINUE' (want 0 or 1)" >&2; exit 2 ;; esac

mkdir -p "$CAPTURE_DIR"
: >"$CE/status"

# Record the OpenCode version once (Phase 8 / G1). Best-effort: `--version` is
# inert, and a failure just leaves the envelope's version null.
timeout 15 "$OC_BIN" --version >"$CE/opencode-version.txt" 2>/dev/null || true

node "$REPO/test/harness/capture/mock-provider.mjs" >"$CE/mock.log" 2>&1 &
MOCK=$!
sleep 0.7

cd "$CE/proj" || exit 3

# Run one bounded turn. Records its rc; a nonzero rc (timeout=124, kill=137, or
# any failure) marks the capture as failed so the orchestrator never compares.
# Extra args (e.g. --continue) precede the message.
run_turn() {
  local n="$1"; shift
  local t0 t1
  t0=$(date +%s%3N 2>/dev/null || true)
  timeout --kill-after=5 "$TURN_TIMEOUT" "$OC_BIN" run --standalone --print-logs --log-level info -m "$CAPTURE_MODEL" "$@" "${OC_CAPTURE_PROMPT:-say hi}" >"$CE/run${n}.log" 2>&1
  local rc=$?
  t1=$(date +%s%3N 2>/dev/null || true)
  echo "run${n}_rc=$rc" >>"$CE/status"
  # Per-turn duration (Phase 8 / G3). When `date` lacks millisecond precision the
  # line is omitted rather than written with a bogus value.
  case "$t0$t1" in
    ''|*[!0-9]*) : ;;
    *) echo "run${n}_ms=$((t1 - t0))" >>"$CE/status" ;;
  esac
  if [ "$rc" -ne 0 ]; then
    echo "turn_failed=1" >>"$CE/status"
    echo "turn${n}_failed=true" >>"$CE/status"
    echo "BLOCKER: turn ${n} failed or timed out (rc=$rc)" >&2
  fi
  return "$rc"
}

failed=0
for i in $(seq 1 "$TURNS"); do run_turn "$i" || failed=1; done
if [ "$CONTINUE" = "1" ]; then
  n=$((TURNS + 1))
  run_turn "$n" --continue || failed=1
fi

kill "$MOCK" 2>/dev/null
wait "$MOCK" 2>/dev/null
# Nonzero when any turn failed/timed out. The status file carries the detail and
# the orchestrator (decide.sh) enforces the exit contract for run.sh.
exit "$failed"
