#!/usr/bin/env bash
# Prune capture roots owned by the Phase 1 capture harness under a temp root.
#
# usage: prune.sh <tmpRoot> <retentionMinutes>
#
# Removes directories named `capture.*` at depth 1 under <tmpRoot> whose mtime is
# older than <retentionMinutes>. A retention of 0 disables pruning. Only that
# exact pattern is touched; unrelated directories/files are never removed.
#
# Exit 0 on success (including "nothing to prune"); exit 2 on invalid input
# (missing/unreadable root, invalid retention). A prune command failure is
# reported (not silent) but does not abort, since pruning is best-effort cleanup.
set -uo pipefail

ROOT="${1:-}"
MIN="${2:-}"

if [ -z "$ROOT" ] || [ ! -d "$ROOT" ]; then
  echo "BLOCKER: temp root does not exist: ${ROOT:-<empty>}" >&2
  exit 2
fi
case "$MIN" in
  ''|*[!0-9]*) echo "BLOCKER: invalid OC_CAPTURE_RETENTION_MIN='$MIN'" >&2; exit 2 ;;
esac

# 0 disables pruning.
if [ "$MIN" -le 0 ]; then exit 0; fi

if ! find "$ROOT" -maxdepth 1 -type d -name 'capture.*' -mmin +"$MIN" -exec rm -rf -- {} + 2>/dev/null; then
  echo "WARN: retention prune encountered an error under $ROOT (continuing)" >&2
fi
exit 0
