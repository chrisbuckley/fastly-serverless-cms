#!/usr/bin/env bash
# Extract the inline VCL snippets from terraform/vcl.tf and run `falco lint`
# on each wrapped snippet. Exits non-zero if any snippet fails.
#
# Usage: scripts/lint-vcl.sh [terraform/vcl.tf]
# Requires: falco on PATH.
set -euo pipefail

TF_FILE="${1:-terraform/vcl.tf}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

lint_dir="$("$HERE/extract-vcl.sh" "$TF_FILE" "$WORK" | tail -n 1)"

failed=0
total=0
for f in "$lint_dir"/*.vcl; do
    total=$((total + 1))
    echo "--- falco lint $(basename "$f")"
    if ! falco lint "$f"; then
        failed=$((failed + 1))
    fi
done

echo "lint-vcl: $((total - failed))/$total snippet(s) clean"
[ "$failed" -eq 0 ]
