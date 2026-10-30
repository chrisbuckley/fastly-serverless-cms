#!/usr/bin/env bash
# Start a built Compute backend under Viceroy and run the shared integration
# suite against it. Run from the repo root.
#
# Usage: scripts/run-integration.sh <rust|typescript|go>
#
# The package must already be built (`fastly compute build` / `make build`).
set -euo pipefail

backend="${1:-}"
case "$backend" in
rust | typescript | go) ;;
*)
    echo "usage: $0 <rust|typescript|go>" >&2
    exit 2
    ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="$(mktemp)"
BASE="${EDGE_CMS_BASE_URL:-http://127.0.0.1:7676}"

# shellcheck disable=SC2329  # invoked via trap
cleanup() {
    if [ -n "${VICEROY_PID:-}" ]; then
        kill "$VICEROY_PID" 2>/dev/null || true
        wait "$VICEROY_PID" 2>/dev/null || true
    fi
}
trap cleanup EXIT

(cd "$ROOT/$backend" && exec fastly compute serve --skip-build) >"$LOG" 2>&1 &
VICEROY_PID=$!

up=0
for _ in $(seq 1 60); do
    if ! kill -0 "$VICEROY_PID" 2>/dev/null; then
        break
    fi
    # Any HTTP response (even 403 from origin auth) means the server is up.
    if curl -s -o /dev/null --max-time 2 "$BASE/"; then
        up=1
        break
    fi
    sleep 1
done

if [ "$up" -ne 1 ]; then
    echo "Viceroy did not become ready; log follows:" >&2
    cat "$LOG" >&2
    exit 1
fi

status=0
"$ROOT/rust/tests/integration.sh" || status=$?
if [ "$status" -ne 0 ]; then
    echo "--- Viceroy log (last 100 lines) ---" >&2
    tail -n 100 "$LOG" >&2
fi
exit "$status"
