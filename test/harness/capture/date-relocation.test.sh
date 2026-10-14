#!/usr/bin/env bash
# Hermetic (no sandbox, no provider) tests for verify-date-relocation.mjs, the
# P2-T3 offline WIRE verifier. Builds synthetic off/on capture dirs and checks the
# exit contract: 0 as expected, 1 wire mismatch, 2 invalid input. Exit nonzero on
# any failure.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERIFY="$SCRIPT_DIR/verify-date-relocation.mjs"
NODE_BIN="$(command -v node || true)"
if [ -z "${NODE_BIN:-}" ]; then echo "BLOCKER: node not found" >&2; exit 1; fi

T="$(mktemp -d "${TMPDIR:-/tmp}/ce-date-verify.XXXXXX")" || { echo "BLOCKER: mktemp failed" >&2; exit 1; }
trap 'rm -rf "$T"' EXIT

# Baseline: the date line sits BEFORE the <env> block (the captured 2.0.26 shape).
printf '%s\n' "SKILLS" "" "Today's date: Wed Oct 14 2026" "" "intro" "<env>" "  Working directory: /tmp/opencode/capture.AAAAAA/proj" "  Platform: linux" "</env>" "When you create a worktree." >"$T/off.txt"
# Candidate: the date line moved to AFTER the <env> block (per-part relocation),
# with one separator newline; a different run temp root (normalized before compare).
printf '%s\n' "SKILLS" "" "" "intro" "<env>" "  Working directory: /tmp/opencode/capture.BBBBBB/proj" "  Platform: linux" "</env>" "Today's date: Wed Oct 14 2026" "When you create a worktree." >"$T/on.txt"
# Candidate with a changed date value (must fail).
printf '%s\n' "SKILLS" "" "" "intro" "<env>" "  Working directory: /tmp/opencode/capture.CCCCCC/proj" "  Platform: linux" "</env>" "Today's date: Thu Oct 15 2026" "When you create a worktree." >"$T/onvm.txt"

build() { # dir contentFile
  mkdir -p "$1"
  "$NODE_BIN" -e 'const fs=require("fs");const c=fs.readFileSync(process.argv[1],"utf8");fs.writeFileSync(process.argv[2]+"/req-001.json",JSON.stringify({seq:1,method:"POST",url:"/v1/chat/completions",body:{messages:[{role:"system",content:c},{role:"user",content:"hi"}]}}))' "$2" "$1"
}
build "$T/off" "$T/off.txt"
build "$T/on" "$T/on.txt"
build "$T/off2" "$T/off.txt"
build "$T/onvm" "$T/onvm.txt"

rc=0
check() { # desc expected actual
  if [ "$2" = "$3" ]; then
    echo "ok   $1"
  else
    echo "FAIL $1 (expected exit $2, got $3)"
    rc=1
  fi
}

"$NODE_BIN" "$VERIFY" "$T/off" "$T/on" >/dev/null 2>&1
check "correct relocation -> exit 0" 0 $?
"$NODE_BIN" "$VERIFY" "$T/off" "$T/off2" >/dev/null 2>&1
check "no relocation -> exit 1" 1 $?
"$NODE_BIN" "$VERIFY" "$T/off" "$T/off2" --unchanged >/dev/null 2>&1
check "unchanged control -> exit 0" 0 $?
"$NODE_BIN" "$VERIFY" "$T/off" "$T/onvm" >/dev/null 2>&1
check "changed date value -> exit 1" 1 $?
"$NODE_BIN" "$VERIFY" "$T/off" "$T/does-not-exist" >/dev/null 2>&1
check "missing capture dir -> exit 2" 2 $?
"$NODE_BIN" "$VERIFY" >/dev/null 2>&1
check "missing arguments -> exit 2" 2 $?

if [ "$rc" -eq 0 ]; then
  echo "ALL DATE-RELOCATION CHECKS PASSED"
else
  echo "DATE-RELOCATION CHECKS FAILED" >&2
fi
exit "$rc"
