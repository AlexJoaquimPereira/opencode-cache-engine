#!/usr/bin/env bash
# Post-capture decision for the capture harness. Given a capture root that
# already contains `status` (written by inner.sh) and `capture/req-*.json`, it
# enforces the exit contract:
#   0  valid captures; all paired differences identical/expected
#   1  valid captures; at least one unexpected structural difference
#   2  a failed/timed-out turn, insufficient captures, or invalid input
# It is a separate script so the contract is testable with synthetic roots and no
# sandbox or provider.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${1:?capture root required}"

NODE_BIN="$(command -v node || true)"
if [ -z "${NODE_BIN:-}" ]; then echo "BLOCKER: node not found" >&2; exit 2; fi

# A failed or timed-out turn is a blocker: never compare as if it succeeded.
if grep -q '^turn_failed=1' "$ROOT/status" 2>/dev/null; then
  echo "BLOCKER: an OpenCode turn failed or timed out; see $ROOT/run1.log and $ROOT/run2.log" >&2
  exit 2
fi

captured=$(ls "$ROOT/capture"/req-*.json 2>/dev/null | wc -l)
echo "captured requests: $captured" >&2
if [ "$captured" -lt 2 ]; then
  echo "BLOCKER: expected >=2 captured requests; see $ROOT/run1.log and $ROOT/run2.log" >&2
  tail -n 20 "$ROOT/run1.log" 2>/dev/null >&2
  exit 2
fi

# Propagate the reporter's status WITHOUT letting a trailing message replace it.
node "$SCRIPT_DIR/diff-requests.mjs" "$ROOT/capture"
diff_rc=$?
echo "capture root retained for inspection: $ROOT" >&2
exit "$diff_rc"
