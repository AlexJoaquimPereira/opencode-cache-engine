#!/usr/bin/env bash
# Retention checks for prune.sh (capture-root pruning). Synthetic dirs/timestamps
# only: never touches the machine's real /tmp contents.
# Exit 0 if all checks pass, 1 otherwise.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRUNE="$SCRIPT_DIR/prune.sh"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/ce-ret.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

fail=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fail=1; }
check() { if [ "$1" = "$2" ]; then ok "$3 (exit $2)"; else bad "$3: expected $1 got $2"; fi; }

ROOT="$TMP/root"
mkdir -p "$ROOT/capture.old" "$ROOT/capture.new" "$ROOT/keepme"
touch -d '2 days ago' "$ROOT/capture.old"
touch -d '2 days ago' "$ROOT/keepme"
touch -d '2 days ago' "$ROOT/capture.txt" # a file, not a directory

bash "$PRUNE" "$ROOT" 1440 >/dev/null 2>&1; check 0 $? "prune runs"
[ -d "$ROOT/capture.old" ] && bad "old capture root not pruned" || ok "old capture root pruned"
[ -d "$ROOT/capture.new" ] && ok "new capture root retained" || bad "new capture root removed"
[ -d "$ROOT/keepme" ] && ok "unrelated dir retained" || bad "unrelated dir removed"
[ -f "$ROOT/capture.txt" ] && ok "unrelated file retained" || bad "unrelated file removed"

# OC_CAPTURE_RETENTION_MIN=0 disables pruning.
mkdir -p "$ROOT/capture.zero"
touch -d '2 days ago' "$ROOT/capture.zero"
bash "$PRUNE" "$ROOT" 0 >/dev/null 2>&1; check 0 $? "prune with 0 runs"
[ -d "$ROOT/capture.zero" ] && ok "retention 0 disables pruning" || bad "retention 0 pruned a root"

# Invalid retention and missing root fail closed.
bash "$PRUNE" "$ROOT" abc >/dev/null 2>&1; check 2 $? "invalid retention fails closed"
bash "$PRUNE" "$TMP/does-not-exist" 1440 >/dev/null 2>&1; check 2 $? "missing root fails closed"

if [ "$fail" -eq 0 ]; then echo "ALL RETENTION CHECKS PASSED"; else echo "SOME RETENTION CHECKS FAILED"; fi
exit "$fail"
