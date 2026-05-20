#!/usr/bin/env bash
set -euo pipefail

for f in "$@"; do
    basename=$(basename "$f")
    if [[ "$basename" == .env || "$basename" == *.env ]] && \
       [[ "$basename" != *.env.example && "$basename" != .env.example ]]; then
        echo "BLOCKED: $f — use .env.example instead"
        exit 1
    fi
done
