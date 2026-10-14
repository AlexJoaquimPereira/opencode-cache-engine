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

# write_sys <file> <line...>: write the lines joined by newlines with NO trailing
# newline (so the relocation's separator semantics are exercised exactly).
write_sys() {
  local f="$1"; shift
  printf '%s' "$(printf '%s\n' "$@")" >"$f"
}

DATE="Today's date: Wed Oct 14 2026"
# Baseline: the date line BEFORE the <env> block (the captured 2.0.26 shape).
write_sys "$T/off.txt" "SKILLS" "" "$DATE" "" "intro" "<env>" "  Working directory: /tmp/opencode/capture.AAAAAA/proj" "  Platform: linux" "</env>" "When you create a worktree."
# Same shape, a different run temp root (exercises root normalization).
write_sys "$T/off2.txt" "SKILLS" "" "$DATE" "" "intro" "<env>" "  Working directory: /tmp/opencode/capture.EEEEEE/proj" "  Platform: linux" "</env>" "When you create a worktree."
# Candidate: the exact relocation output — the date line's bytes moved to the end
# (the date line's source newline is left behind), plus one separator newline.
write_sys "$T/on.txt" "SKILLS" "" "" "" "intro" "<env>" "  Working directory: /tmp/opencode/capture.BBBBBB/proj" "  Platform: linux" "</env>" "When you create a worktree." "$DATE"
# Candidate with a changed date value (must fail).
write_sys "$T/onvm.txt" "SKILLS" "" "" "" "intro" "<env>" "  Working directory: /tmp/opencode/capture.CCCCCC/proj" "  Platform: linux" "</env>" "When you create a worktree." "Today's date: Thu Oct 15 2026"
# Candidate with a duplicate date line (ambiguous; must fail).
write_sys "$T/ondup.txt" "SKILLS" "" "" "" "intro" "<env>" "  Working directory: /tmp/opencode/capture.DDDDDD/proj" "  Platform: linux" "</env>" "When you create a worktree." "$DATE" "$DATE"

# build <targetDir> <contentFile>  -> targetDir/req-001.json with a system message.
build() {
  mkdir -p "$1"
  "$NODE_BIN" -e 'const fs=require("fs");const c=fs.readFileSync(process.argv[1],"utf8");fs.writeFileSync(process.argv[2]+"/req-001.json",JSON.stringify({seq:1,method:"POST",url:"/v1/chat/completions",body:{messages:[{role:"system",content:c},{role:"user",content:"hi"}]}}))' "$2" "$1"
}
# buildmulti <targetDir> <primaryContentFile> -> a smaller aux req-001 + a larger
# req-002, so the verifier must select the LARGEST system content (req-002).
buildmulti() {
  mkdir -p "$1"
  "$NODE_BIN" -e 'const fs=require("fs");const c=fs.readFileSync(process.argv[1],"utf8");fs.writeFileSync(process.argv[2]+"/req-001.json",JSON.stringify({seq:1,method:"POST",url:"/v1/chat/completions",body:{messages:[{role:"system",content:"AUX no date"},{role:"user",content:"hi"}]}}));fs.writeFileSync(process.argv[2]+"/req-002.json",JSON.stringify({seq:2,method:"POST",url:"/v1/chat/completions",body:{messages:[{role:"system",content:c},{role:"user",content:"hi"}]}}))' "$2" "$1"
}

build "$T/off" "$T/off.txt"
build "$T/off2" "$T/off2.txt"
build "$T/on" "$T/on.txt"
build "$T/onvm" "$T/onvm.txt"
build "$T/ondup" "$T/ondup.txt"
# The real run writes under <root>/capture/req-*.json (the subdir branch).
build "$T/sub_off/capture" "$T/off.txt"
build "$T/sub_on/capture" "$T/on.txt"
buildmulti "$T/multi_off" "$T/off.txt"
buildmulti "$T/multi_on" "$T/on.txt"

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
check "unchanged control (temp root normalized) -> exit 0" 0 $?
"$NODE_BIN" "$VERIFY" "$T/off" "$T/onvm" >/dev/null 2>&1
check "changed date value -> exit 1" 1 $?
"$NODE_BIN" "$VERIFY" "$T/off" "$T/ondup" >/dev/null 2>&1
check "duplicate date line -> exit 1" 1 $?
"$NODE_BIN" "$VERIFY" "$T/sub_off" "$T/sub_on" >/dev/null 2>&1
check "capture/ subdir layout -> exit 0" 0 $?
"$NODE_BIN" "$VERIFY" "$T/multi_off" "$T/multi_on" >/dev/null 2>&1
check "multi-file (largest selected) -> exit 0" 0 $?
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
