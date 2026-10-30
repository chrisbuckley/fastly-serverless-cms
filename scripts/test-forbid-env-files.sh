#!/usr/bin/env bash
# Tests for .hooks/forbid-env-files.sh. Run: scripts/test-forbid-env-files.sh
set -euo pipefail

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.hooks/forbid-env-files.sh"
pass=0
fail=0

# expect_exit EXPECTED_RC PATH...
expect_exit() {
    local want="$1" rc=0
    shift
    "$HOOK" "$@" >/dev/null 2>&1 || rc=$?
    if [ "$rc" -eq "$want" ]; then
        pass=$((pass + 1))
        echo "PASS: $* -> exit $rc"
    else
        fail=$((fail + 1))
        echo "FAIL: $* -> exit $rc, wanted $want"
    fi
}

# Blocked
expect_exit 1 .env
expect_exit 1 rust/.env
expect_exit 1 .env.local
expect_exit 1 .env.production
expect_exit 1 typescript/.env.staging
expect_exit 1 prod.env
expect_exit 1 a/b/.env.development.local
# Allowed
expect_exit 0 .env.example
expect_exit 0 rust/.env.example
expect_exit 0 scripts/.env.example
expect_exit 0 prod.env.example
expect_exit 0 README.md
expect_exit 0 environment.ts
expect_exit 0 src/env.rs
expect_exit 0 scripts/envsubst.sh
# Mixed / empty
expect_exit 1 README.md .env.local rust/.env.example
expect_exit 0 rust/.env.example README.md
expect_exit 0

echo "forbid-env-files: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
