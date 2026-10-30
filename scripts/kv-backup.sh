#!/usr/bin/env bash
# Export every key of the Edge CMS content KV store to a timestamped
# JSON-lines file. Each line is {"key":"<name>","value":"<base64>"} — the exact
# format `fastly kv-store-entry create --file` accepts, so scripts/kv-restore.sh
# can replay it.
#
# Usage:   scripts/kv-backup.sh [output-dir]       (default: ./kv-backups)
# Env:     FASTLY_KV_STORE_ID  content KV store id (required)
#          FASTLY_API_TOKEN    Fastly API token (required; read by the CLI from
#                              the environment, never printed or put on argv)
#          Optional: values may also come from scripts/.env (see .env.example)
# Needs:   fastly CLI (16.x), jq
#
# The backup contains all post content: it is written mode 600. Do not commit it.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$HERE/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    . "$HERE/.env"
    set +a
fi

: "${FASTLY_KV_STORE_ID:?set FASTLY_KV_STORE_ID (see scripts/.env.example)}"
: "${FASTLY_API_TOKEN:?set FASTLY_API_TOKEN (see scripts/.env.example)}"
export FASTLY_API_TOKEN

for tool in fastly jq; do
    command -v "$tool" >/dev/null 2>&1 || {
        echo "kv-backup: '$tool' is required" >&2
        exit 2
    }
done

OUT_DIR="${1:-kv-backups}"
umask 077
mkdir -p "$OUT_DIR"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$OUT_DIR/kv-backup-${FASTLY_KV_STORE_ID}-${TS}.jsonl"
TMP="$OUT.partial"
trap 'rm -f "$TMP"' EXIT

echo "kv-backup: listing keys in store ${FASTLY_KV_STORE_ID}" >&2
# `list --json` prints a JSON array of key names (all pages).
KEYS_JSON="$(fastly kv-store-entry list --store-id "$FASTLY_KV_STORE_ID" --json --consistency strong)"

count=0
: >"$TMP"
while IFS= read -r key; do
    [ -n "$key" ] || continue
    # `get --json` prints {"<key>": "<base64 value>"}.
    fastly kv-store-entry get --store-id "$FASTLY_KV_STORE_ID" --key "$key" --json |
        jq -c 'to_entries[0] | {key: .key, value: .value}' >>"$TMP"
    count=$((count + 1))
done < <(printf '%s' "$KEYS_JSON" | jq -r '.[]')

# Every line must be well-formed before the backup is considered complete.
jq -e -s 'all(.[]; (.key | type == "string") and (.value | type == "string"))' "$TMP" >/dev/null
lines="$(wc -l <"$TMP" | tr -d ' ')"
if [ "$lines" != "$count" ]; then
    echo "kv-backup: expected $count entries, wrote $lines" >&2
    exit 1
fi

mv "$TMP" "$OUT"
echo "kv-backup: wrote $count key(s) to $OUT" >&2
echo "$OUT"
