#!/usr/bin/env bash
set -euo pipefail

status=0
for f in "$@"; do
    if grep -nE '"version"\s*:\s*[0-9]+' "$f" 2>/dev/null | grep -qvE 'manifest_version' || \
       grep -nE 'version\s*=\s*[0-9]+' "$f" 2>/dev/null | grep -qvE 'manifest_version'; then
        echo "WARNING: $f may contain a hardcoded service version — verify before merging to main"
        status=1
    fi
done
exit $status
