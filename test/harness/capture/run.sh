#!/usr/bin/env bash
# Phase 1 reusable two-request capture harness (HOST orchestrator).
#
# Sets up a disposable project, runs two equivalent OpenCode V2 turns against a
# loopback mock provider inside a network-isolated bubblewrap sandbox, then
# reports the first structural difference between the two captured serialized
# request bodies. Offline only: no real provider, no credentials, no managed
# OpenCode configuration touched.
#
# Usage:
#   test/harness/capture/run.sh
# Env:
#   OC2=/path/to/opencode            (default ~/.opencode/bin/opencode)
#   OC_CAPTURE_TMPDIR=/some/dir     (default /tmp/opencode)
#   OC_CAPTURE_ENGINE_CONFIG=<json> (optional inline CacheEngine config written to
#                                    the sandbox ~/.config/opencode/cache-engine.json)
#   OC_CAPTURE_TURN_TIMEOUT=120     (per-turn seconds; validated in inner.sh)
#   OC_CAPTURE_MODEL=mock/synthetic (model id for `-m` and the config; the
#                                    provider part must be `mock`)
#   OC_CAPTURE_RETENTION_MIN=1440   (prune capture.* roots older than N minutes;
#                                    0 disables pruning)
#   MOCK_PORT=39420                 (loopback mock + provider base URL port)
#   OC_CAPTURE_ONLY_DIFF=<dir>      (debug/test: diff an existing capture dir;
#                                    performs no capture and touches no provider)
#   OC_CAPTURE_DRY_RUN=1            (debug/test: write the project for the
#                                    configured port and print resolved values;
#                                    performs no capture and touches no provider)
#
# Exit contract:
#   0  captures completed and every paired difference was identical/expected
#   1  at least one unexpected structural difference
#   2  a blocker prevented a valid capture or comparison (incl. a failed/timed-out
#      turn, invalid input, or a missing dependency)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../../.." && pwd)"
OC2="${OC2:-$HOME/.opencode/bin/opencode}"
MOCK_PORT="${MOCK_PORT:-39420}"
# Model override: `<provider>/<model>`. The harness configures the `mock`
# provider only, so the provider part must be `mock` for the turn to resolve;
# any other provider part fails the turn (recorded as a blocker by inner.sh).
CAPTURE_MODEL="${OC_CAPTURE_MODEL:-mock/synthetic}"
case "$CAPTURE_MODEL" in
  */*) : ;;
  *) echo "BLOCKER: OC_CAPTURE_MODEL must be <provider>/<model> (got '$CAPTURE_MODEL')" >&2; exit 2 ;;
esac
CAPTURE_PROVIDER="${CAPTURE_MODEL%%/*}"
CAPTURE_MODEL_ID="${CAPTURE_MODEL#*/}"
NODE_BIN="$(command -v node || true)"

if [ -z "${NODE_BIN:-}" ]; then echo "BLOCKER: node not found" >&2; exit 2; fi

# Write the disposable project (mock-provider config + plugin shim) for one port,
# so the host-side base URL and the sandbox MOCK_PORT share a single source.
write_project() {
  local proj="$1" port="$2"
  mkdir -p "$proj/.opencode/plugins"
  cat >"$proj/.opencode/opencode.json" <<JSON
{
  "\$schema": "https://opencode.ai/config.json",
  "provider": {
    "mock": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Mock",
      "options": { "baseURL": "http://127.0.0.1:${port}/v1", "apiKey": "not-a-real-key" },
      "models": { "$CAPTURE_MODEL_ID": { "name": "$CAPTURE_MODEL_ID" } }
    }
  },
  "model": "$CAPTURE_MODEL"
}
JSON
  cat >"$proj/.opencode/plugins/capture-entry.ts" <<TS
export { default } from "$REPO/src/cache-engine-v2.mjs"
TS
}

# Debug/test path: diff an existing capture directory with the same exit contract.
# No capture, no sandbox, no provider.
if [ -n "${OC_CAPTURE_ONLY_DIFF:-}" ]; then
  if [ -n "${OC_CAPTURE_ENGINE_CONFIG:-}" ]; then echo "warn: OC_CAPTURE_ENGINE_CONFIG is ignored in only-diff mode" >&2; fi
  node "$SCRIPT_DIR/diff-requests.mjs" "$OC_CAPTURE_ONLY_DIFF"
  exit $?
fi

# Temporary root: create it first and fail closed, so an empty TMP can never lead
# to writes outside the intended temp root (e.g. /home/.config).
TMPROOT="${OC_CAPTURE_TMPDIR:-/tmp/opencode}"
if ! mkdir -p "$TMPROOT"; then echo "BLOCKER: cannot create temp root $TMPROOT" >&2; exit 2; fi

# Debug/test path: write the project for the configured port and report the
# resolved orchestration values. No capture, no sandbox, no provider.
if [ -n "${OC_CAPTURE_DRY_RUN:-}" ]; then
  if [ -n "${OC_CAPTURE_ENGINE_CONFIG:-}" ]; then echo "warn: OC_CAPTURE_ENGINE_CONFIG is ignored in dry-run mode" >&2; fi
  DRY="$(mktemp -d "$TMPROOT/dryrun.XXXXXX")" || { echo "BLOCKER: dry-run mktemp failed" >&2; exit 2; }
  write_project "$DRY/proj" "$MOCK_PORT"
  echo "mock_port=$MOCK_PORT"
  echo "sandbox_mock_port=$MOCK_PORT"
  echo "config=$DRY/proj/.opencode/opencode.json"
  exit 0
fi

command -v bwrap >/dev/null 2>&1 || { echo "BLOCKER: bubblewrap (bwrap) not found" >&2; exit 2; }
[ -x "$OC2" ] || { echo "BLOCKER: OpenCode V2 binary not found at $OC2 (set OC2)" >&2; exit 2; }
command -v timeout >/dev/null 2>&1 || { echo "BLOCKER: 'timeout' not found (required per-turn limit)" >&2; exit 2; }
NODE_DIR="$(cd "$(dirname "$NODE_BIN")/.." && pwd)"

# Retention: prune stale capture roots owned by this harness (best-effort; an
# invalid configuration fails closed via prune.sh's exit 2).
RETENTION_MIN="${OC_CAPTURE_RETENTION_MIN:-1440}"
bash "$SCRIPT_DIR/prune.sh" "$TMPROOT" "$RETENTION_MIN" || { echo "BLOCKER: retention setup failed" >&2; exit 2; }

TMP="$(mktemp -d "$TMPROOT/capture.XXXXXX")" || { echo "BLOCKER: mktemp failed under $TMPROOT" >&2; exit 2; }
if [ -z "${TMP:-}" ] || [ ! -d "$TMP" ]; then echo "BLOCKER: temp directory was not created" >&2; exit 2; fi

mkdir -p "$TMP/home/.config" "$TMP/home/.local/share" "$TMP/home/.local/state" "$TMP/home/.cache"
write_project "$TMP/proj" "$MOCK_PORT"

# Optional CacheEngine config injection (offline): write the inline JSON to the
# sandbox HOME's ~/.config/opencode/cache-engine.json so a wire test can enable an
# experimental policy. Invalid JSON is a blocker (never silently defaulted).
if [ -n "${OC_CAPTURE_ENGINE_CONFIG:-}" ]; then
  mkdir -p "$TMP/home/.config/opencode"
  if ! "$NODE_BIN" -e 'JSON.parse(process.argv[1])' "$OC_CAPTURE_ENGINE_CONFIG" >/dev/null 2>&1; then
    echo "BLOCKER: OC_CAPTURE_ENGINE_CONFIG is not valid JSON" >&2
    exit 2
  fi
  printf '%s' "$OC_CAPTURE_ENGINE_CONFIG" >"$TMP/home/.config/opencode/cache-engine.json"
fi

echo "capture root: $TMP" >&2
bwrap --unshare-net --unshare-pid --unshare-uts --unshare-ipc \
  --ro-bind /usr /usr --ro-bind /lib /lib --ro-bind /lib64 /lib64 \
  --ro-bind /bin /bin --ro-bind /sbin /sbin --ro-bind /etc /etc \
  --ro-bind "$NODE_DIR" "$NODE_DIR" \
  --tmpfs /oc --ro-bind "$OC2" /oc/opencode \
  --ro-bind "$REPO" "$REPO" \
  --bind "$TMP" "$TMP" --proc /proc --dev /dev --tmpfs /run \
  --chdir "$TMP" \
  --setenv PATH "$NODE_DIR/bin:/usr/bin:/bin" \
  --setenv REPO "$REPO" --setenv CE "$TMP" \
  --setenv HOME "$TMP/home" \
  --setenv XDG_CONFIG_HOME "$TMP/home/.config" \
  --setenv XDG_DATA_HOME "$TMP/home/.local/share" \
  --setenv XDG_STATE_HOME "$TMP/home/.local/state" \
  --setenv XDG_CACHE_HOME "$TMP/home/.cache" \
  --setenv OC_CAPTURE_TURN_TIMEOUT "${OC_CAPTURE_TURN_TIMEOUT:-120}" \
  --setenv OC_CAPTURE_MODEL "$CAPTURE_MODEL" \
  --setenv MOCK_PORT "$MOCK_PORT" \
  /bin/bash "$REPO/test/harness/capture/inner.sh"

rc=$?
echo "sandbox rc=$rc ($(cat "$TMP/status" 2>/dev/null | tr '\n' ' '))" >&2

# Post-capture decision (turn failure, capture count, diff) with the exit contract.
bash "$SCRIPT_DIR/decide.sh" "$TMP"
exit $?
