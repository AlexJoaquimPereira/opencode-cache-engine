#!/usr/bin/env bash
# Host/sandbox mock-port parity for the capture harness. Runs run.sh in dry-run
# mode (no capture, no sandbox, no provider), reads the generated provider config,
# and asserts the host base-URL port equals the sandbox MOCK_PORT for both the
# default and a non-default port.
# Exit 0 if all checks pass, 1 otherwise.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN="$SCRIPT_DIR/run.sh"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/ce-port.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

fail=0
check_port() { # port label
  local port="$1" label="$2" out cfg sandbox baseport
  out="$(MOCK_PORT="$port" OC_CAPTURE_TMPDIR="$TMP" OC_CAPTURE_DRY_RUN=1 bash "$RUN" 2>/dev/null)"
  cfg="$(printf '%s\n' "$out" | sed -n 's/^config=//p')"
  sandbox="$(printf '%s\n' "$out" | sed -n 's/^sandbox_mock_port=//p')"
  if [ -z "$cfg" ] || [ ! -f "$cfg" ]; then
    echo "FAIL $label: no config generated (dry-run output: $out)"
    fail=1
    return
  fi
  baseport="$(sed -n 's/.*baseURL": *"http:\/\/127\.0\.0\.1:\([0-9][0-9]*\)\/v1".*/\1/p' "$cfg")"
  if [ -n "$baseport" ] && [ "$baseport" = "$port" ] && [ "$sandbox" = "$port" ]; then
    echo "ok   $label: config baseURL port=$baseport sandbox MOCK_PORT=$sandbox"
  else
    echo "FAIL $label: config port='$baseport' sandbox='$sandbox' expected='$port'"
    fail=1
  fi
  rm -rf "$TMP"/dryrun.* 2>/dev/null || true
}

check_port 39420 "default port"
check_port 41234 "non-default port"

if [ "$fail" -eq 0 ]; then echo "ALL PORT-PARITY CHECKS PASSED"; else echo "SOME PORT-PARITY CHECKS FAILED"; fi
exit "$fail"
