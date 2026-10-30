#!/usr/bin/env bash
# Restore a JSON-lines backup produced by scripts/kv-backup.sh into the content
# KV store. Existing keys with the same name are OVERWRITTEN; keys not in the
# backup are left alone.
#
# Usage:   scripts/kv-restore.sh [--yes] <backup.jsonl>
# Env:     FASTLY_KV_STORE_ID, FASTLY_API_TOKEN (see scripts/.env.example)
# Needs:   fastly CLI (16.x), jq
#
# Without --yes the script shows the target store and key count and asks you to
# type the store id to confirm.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$HERE/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    . "$HERE/.env"
    set +a
fi

assume_yes=0
file=""
for arg in "$@"; do
    case "$arg" in
    --yes | -y) assume_yes=1 ;;
    -h | --help)
        sed -n '2,12p' "${BASH_SOURCE[0]}"
        exit 0
        ;;
    -*)
        echo "kv-restore: unknown option $arg" >&2
        exit 2
        ;;
    *) file="$arg" ;;
    esac
done

if [ -z "$file" ] || [ ! -f "$file" ]; then
    echo "usage: $0 [--yes] <backup.jsonl>" >&2
    exit 2
fi

: "${FASTLY_KV_STORE_ID:?set FASTLY_KV_STORE_ID (see scripts/.env.example)}"
: "${FASTLY_API_TOKEN:?set FASTLY_API_TOKEN (see scripts/.env.example)}"
export FASTLY_API_TOKEN

for tool in fastly jq; do
    command -v "$tool" >/dev/null 2>&1 || {
        echo "kv-restore: '$tool' is required" >&2
        exit 2
    }
done

if ! jq -e -s 'length > 0 and all(.[]; (.key | type == "string") and (.value | type == "string"))' "$file" >/dev/null 2>&1; then
    echo "kv-restore: $file is empty or not valid {\"key\",\"value\"} JSON lines" >&2
    exit 1
fi
count="$(jq -s 'length' "$file")"

echo "About to restore $count key(s) from $file"
echo "  into KV store: $FASTLY_KV_STORE_ID  (existing keys of the same name will be overwritten)"

if [ "$assume_yes" -ne 1 ]; then
    if [ ! -t 0 ]; then
        echo "kv-restore: not a terminal; pass --yes to proceed non-interactively" >&2
        exit 1
    fi
    printf 'Type the store id to confirm: '
    read -r answer
    if [ "$answer" != "$FASTLY_KV_STORE_ID" ]; then
        echo "kv-restore: confirmation did not match; aborting" >&2
        exit 1
    fi
fi

fastly kv-store-entry create --store-id "$FASTLY_KV_STORE_ID" --file "$file" --auto-yes
echo "kv-restore: restored $count key(s)" >&2
