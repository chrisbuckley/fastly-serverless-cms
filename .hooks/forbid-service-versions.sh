#!/usr/bin/env bash
set -euo pipefail

status=0
for f in "$@"; do
    if grep -qnE '"version"\s*:\s*[0-9]+' "$f" 2>/dev/null || \
       grep -qnE 'version\s*=\s*[0-9]+' "$f" 2>/dev/null; then
        echo "WARNING: $f may contain a hardcoded service version — verify before merging to main"
        status=1
    fi
done
exit $status
