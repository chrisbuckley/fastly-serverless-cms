#!/usr/bin/env bash
# Pre-commit hook: refuse to commit environment files that may hold real
# secrets. Blocks `.env`, `.env.*` (.env.local, .env.production, ...) and
# `*.env`; allows templates named `.env.example` / `*.env.example`.
set -euo pipefail

status=0
for f in "$@"; do
    name=$(basename "$f")
    case "$name" in
    .env.example | *.env.example)
        continue
        ;;
    .env | .env.* | *.env)
        echo "BLOCKED: $f — commit a .env.example with placeholder values instead"
        status=1
        ;;
    esac
done
exit "$status"
