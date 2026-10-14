#!/usr/bin/env bash
# Reproducible exit-contract checks for the Phase 1 capture harness.
#
# Synthetic fixtures only: no sandbox, no provider, no network. Exercises the
# reporter CLI (relative + absolute invocation), the post-capture decision
# (decide.sh), run.sh propagation/blockers, and the inner.sh timeout validation.
#
# Exit 0 if all checks pass, 1 otherwise.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../../.." && pwd)"
DIFF="$SCRIPT_DIR/diff-requests.mjs"
DECIDE="$SCRIPT_DIR/decide.sh"
RUN="$SCRIPT_DIR/run.sh"
INNER="$SCRIPT_DIR/inner.sh"
NODE="$(command -v node || true)"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/ce-exit.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

fail=0
check() { # expected actual label
  if [ "$1" = "$2" ]; then
    echo "ok   $3 (exit $2)"
  else
    echo "FAIL $3: expected $1 got $2"
    fail=1
  fi
}

BODY_IDENT='{"body":{"model":"m","system":"s","stream":true,"messages":[{"role":"user","content":"hi"}]}}'
BODY_EXPECT='{"body":{"model":"m","system":"s","stream":true,"messages":[{"role":"user","content":"hi"},{"role":"assistant","content":"ok"}]}}'
BODY_UNEXPECT='{"body":{"model":"m","system":"drift","stream":true,"messages":[{"role":"user","content":"hi"}]}}'

# --- reporter: identical pairs -> 0 ---
d="$TMP/identical"; mkdir -p "$d"; printf '%s' "$BODY_IDENT" >"$d/req-000.json"; printf '%s' "$BODY_IDENT" >"$d/req-001.json"
node "$DIFF" "$d" >/dev/null 2>&1; check 0 $? "reporter: identical pairs"

# --- reporter: expected difference (messages only) -> 0 ---
d="$TMP/expected"; mkdir -p "$d"; printf '%s' "$BODY_IDENT" >"$d/req-000.json"; printf '%s' "$BODY_EXPECT" >"$d/req-001.json"
node "$DIFF" "$d" >/dev/null 2>&1; check 0 $? "reporter: expected difference"

# --- reporter: unexpected structural difference (system) -> 1 ---
d="$TMP/unexpected"; mkdir -p "$d"; printf '%s' "$BODY_IDENT" >"$d/req-000.json"; printf '%s' "$BODY_UNEXPECT" >"$d/req-001.json"
node "$DIFF" "$d" >/dev/null 2>&1; check 1 $? "reporter: unexpected difference"

# --- reporter: relative-path invocation works ---
( cd "$REPO" && node "test/harness/capture/diff-requests.mjs" "$TMP/identical" >/dev/null 2>&1 ); check 0 $? "reporter: relative-path invocation"

# --- reporter: invalid JSON -> 2 ---
d="$TMP/badjson"; mkdir -p "$d"; printf '%s' '{ not json' >"$d/req-000.json"; printf '%s' '{ not json' >"$d/req-001.json"
node "$DIFF" "$d" >/dev/null 2>&1; check 2 $? "reporter: invalid JSON"

# --- reporter: missing request body -> 2 ---
d="$TMP/nobody"; mkdir -p "$d"; printf '%s' '{"nope":1}' >"$d/req-000.json"; printf '%s' '{"nope":1}' >"$d/req-001.json"
node "$DIFF" "$d" >/dev/null 2>&1; check 2 $? "reporter: missing body"

# --- reporter: insufficient captures -> 2 ---
d="$TMP/insufficient"; mkdir -p "$d"; printf '%s' "$BODY_IDENT" >"$d/req-000.json"
node "$DIFF" "$d" >/dev/null 2>&1; check 2 $? "reporter: insufficient captures"

# --- reporter: missing directory -> 2 ---
node "$DIFF" "$TMP/does-not-exist" >/dev/null 2>&1; check 2 $? "reporter: missing directory"

# --- decide.sh: turn failed/timeout -> 2 ---
r="$TMP/decide-turnfail"; mkdir -p "$r/capture"; printf 'run1_rc=124\nturn_failed=1\n' >"$r/status"
bash "$DECIDE" "$r" >/dev/null 2>&1; check 2 $? "decide: failed/timed-out turn"

# --- decide.sh: insufficient captures -> 2 ---
r="$TMP/decide-insufficient"; mkdir -p "$r/capture"; : >"$r/status"
bash "$DECIDE" "$r" >/dev/null 2>&1; check 2 $? "decide: insufficient captures"

# --- decide.sh: valid identical -> 0, unexpected -> 1 ---
r="$TMP/decide-identical"; mkdir -p "$r/capture"; : >"$r/status"; cp "$TMP/identical"/req-*.json "$r/capture/"
bash "$DECIDE" "$r" >/dev/null 2>&1; check 0 $? "decide: identical -> 0"
r="$TMP/decide-unexpected"; mkdir -p "$r/capture"; : >"$r/status"; cp "$TMP/unexpected"/req-*.json "$r/capture/"
bash "$DECIDE" "$r" >/dev/null 2>&1; check 1 $? "decide: unexpected -> 1"

# --- run.sh: blocker (missing OC2) -> 2 ---
OC2=/nonexistent/opencode "$RUN" >/dev/null 2>&1; check 2 $? "run.sh: missing OC2 blocker"

# --- run.sh: diff-only propagation 0/1/2 ---
OC_CAPTURE_ONLY_DIFF="$TMP/identical" "$RUN" >/dev/null 2>&1; check 0 $? "run.sh: diff-only identical -> 0"
OC_CAPTURE_ONLY_DIFF="$TMP/unexpected" "$RUN" >/dev/null 2>&1; check 1 $? "run.sh: diff-only unexpected -> 1"
OC_CAPTURE_ONLY_DIFF="$TMP/does-not-exist" "$RUN" >/dev/null 2>&1; check 2 $? "run.sh: diff-only invalid -> 2"

# --- inner.sh: invalid timeout -> 2 (no sandbox) ---
CE="$TMP/ce-invalid" REPO="$REPO" OC_CAPTURE_TURN_TIMEOUT=abc bash "$INNER" >/dev/null 2>&1; check 2 $? "inner.sh: invalid timeout"

# --- inner.sh: P3-T1 turn-plan validation (no sandbox) ---
CE="$TMP/ce-turns-bad" REPO="$REPO" OC_CAPTURE_TURNS=abc bash "$INNER" >/dev/null 2>&1; check 2 $? "inner.sh: invalid OC_CAPTURE_TURNS"
CE="$TMP/ce-turns-one" REPO="$REPO" OC_CAPTURE_TURNS=1 bash "$INNER" >/dev/null 2>&1; check 2 $? "inner.sh: OC_CAPTURE_TURNS < 2"
CE="$TMP/ce-cont-bad" REPO="$REPO" OC_CAPTURE_CONTINUE=yes bash "$INNER" >/dev/null 2>&1; check 2 $? "inner.sh: invalid OC_CAPTURE_CONTINUE"

# --- inner.sh: TURNS=3 + CONTINUE=1 -> 4 turns; only the last is --continue ---
ARGVSTUB="$TMP/stub-argv.sh"; printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" >>"$CE/argv.log"\n' >"$ARGVSTUB"; chmod +x "$ARGVSTUB"
mkdir -p "$TMP/ce-turns/proj"
CE="$TMP/ce-turns" REPO="$REPO" OC_BIN="$ARGVSTUB" MOCK_PORT=39432 OC_CAPTURE_TURNS=3 OC_CAPTURE_CONTINUE=1 OC_CAPTURE_TURN_TIMEOUT=5 bash "$INNER" >/dev/null 2>&1
turns=$(wc -l <"$TMP/ce-turns/argv.log" 2>/dev/null | tr -d ' ')
check 4 "${turns:-0}" "inner.sh: TURNS=3 + CONTINUE=1 runs 4 turns"
if grep -q -- '--continue' <(sed -n '4p' "$TMP/ce-turns/argv.log" 2>/dev/null) && ! grep -q -- '--continue' <(sed -n '1,3p' "$TMP/ce-turns/argv.log" 2>/dev/null); then
  echo "ok   inner.sh: only the last turn uses --continue"
else
  echo "FAIL inner.sh: --continue placement"; fail=1
fi

# --- inner.sh: a controlled stub turn exceeds the timeout -> turn_failed=1 ---
STUB="$TMP/stub-sleep.sh"; printf '#!/usr/bin/env bash\nsleep 30\n' >"$STUB"; chmod +x "$STUB"
mkdir -p "$TMP/ce-timeout/proj"
CE="$TMP/ce-timeout" REPO="$REPO" OC_BIN="$STUB" MOCK_PORT=39431 OC_CAPTURE_TURN_TIMEOUT=1 bash "$INNER" >/dev/null 2>&1
inner_rc=$?
grep -q '^turn_failed=1' "$TMP/ce-timeout/status" 2>/dev/null
tf=$?
if [ "$tf" -eq 0 ]; then echo "ok   inner.sh: timed-out turn marked turn_failed=1 (inner rc=$inner_rc)"; else echo "FAIL inner.sh: timeout not marked"; fail=1; fi

# --- timeout utility: returns 124 on expiry (controlled local sleeper) ---
if command -v timeout >/dev/null 2>&1; then
  timeout --kill-after=1 1 sleep 30 >/dev/null 2>&1
  check 124 $? "timeout: returns 124 on expiry"
else
  echo "SKIP timeout utility not present"
fi

if [ "$fail" -eq 0 ]; then echo "ALL EXIT-CONTRACT CHECKS PASSED"; else echo "SOME EXIT-CONTRACT CHECKS FAILED"; fi
exit "$fail"
