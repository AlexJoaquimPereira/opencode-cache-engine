#!/usr/bin/env bash
# Runs INSIDE the bubblewrap sandbox (invoked by run.sh). Starts the loopback
# mock provider, drives two equivalent OpenCode turns against it (each bounded by
# a per-turn timeout), and stops. A failed or timed-out turn is recorded in
# $CE/status as `turn_failed=1` so the orchestrator refuses to compare.
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

mkdir -p "$CAPTURE_DIR"
: >"$CE/status"

node "$REPO/test/harness/capture/mock-provider.mjs" >"$CE/mock.log" 2>&1 &
MOCK=$!
sleep 0.7

cd "$CE/proj" || exit 3

# Run one bounded turn. Records its rc; a nonzero rc (timeout=124, kill=137, or
# any failure) marks the capture as failed so the orchestrator never compares.
run_turn() {
  local n="$1"
  timeout --kill-after=5 "$TURN_TIMEOUT" "$OC_BIN" run --standalone --print-logs --log-level info -m "$CAPTURE_MODEL" "say hi" >"$CE/run${n}.log" 2>&1
  local rc=$?
  echo "run${n}_rc=$rc" >>"$CE/status"
  if [ "$rc" -ne 0 ]; then
    echo "turn_failed=1" >>"$CE/status"
    echo "turn${n}_failed=true" >>"$CE/status"
    echo "BLOCKER: turn ${n} failed or timed out (rc=$rc)" >&2
  fi
  return "$rc"
}

failed=0
run_turn 1 || failed=1
run_turn 2 || failed=1

kill "$MOCK" 2>/dev/null
wait "$MOCK" 2>/dev/null
# Nonzero when any turn failed/timed out. The status file carries the detail and
# the orchestrator (decide.sh) enforces the exit contract for run.sh.
exit "$failed"
