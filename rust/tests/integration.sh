#!/usr/bin/env bash
# Integration tests for Edge CMS — runs against a local Viceroy instance.
#
# Usage:
#   1. Start Viceroy:  cd edge-cms/rust && fastly compute serve
#   2. Run tests:      ./tests/integration.sh
#
# Requires: curl
set -euo pipefail

BASE="${EDGE_CMS_BASE_URL:-http://127.0.0.1:7676}"
PASS=0
FAIL=0
TMPFILE=$(mktemp)
trap 'rm -f "$TMPFILE"' EXIT

check() {
    local desc="$1" url="$2" expect_status="$3" expect_body="${4:-}"
    local status
    status=$(curl -o "$TMPFILE" -s -w "%{http_code}" "$url")
    if [ "$status" != "$expect_status" ]; then
        echo "FAIL: $desc — expected $expect_status, got $status"
        FAIL=$((FAIL + 1))
        return
    fi
    if [ -n "$expect_body" ] && ! grep -q "$expect_body" "$TMPFILE"; then
        echo "FAIL: $desc — body missing '$expect_body'"
        FAIL=$((FAIL + 1))
        return
    fi
    echo "PASS: $desc"
    PASS=$((PASS + 1))
}

echo "=== Edge CMS Integration Tests ==="
echo "Target: $BASE"
echo ""

# ---------------------------------------------------------------------------
# Reader routes
# ---------------------------------------------------------------------------

check "Homepage returns 200" \
    "$BASE/" "200" "edge"

check "Post page returns 200" \
    "$BASE/post/hello-world" "200" "Hello World"

check "Unknown post returns 404" \
    "$BASE/post/nonexistent" "404"

check "Tag page returns 200" \
    "$BASE/tag/fastly" "200"

check "RSS feed returns 200" \
    "$BASE/feed.xml" "200" "rss"

check "Sitemap returns 200" \
    "$BASE/sitemap.xml" "200" "urlset"

check "Robots.txt returns 200" \
    "$BASE/robots.txt" "200" "User-agent"

check "CSS asset returns 200" \
    "$BASE/assets/style.css" "200"

check "Admin JS returns 200" \
    "$BASE/assets/admin.js" "200"

check "Unknown asset returns 404" \
    "$BASE/assets/nope.js" "404"

# ---------------------------------------------------------------------------
# Cache headers on reader responses
# ---------------------------------------------------------------------------

HEADERS=$(curl -s -D- -o /dev/null "$BASE/")
if echo "$HEADERS" | grep -qi "surrogate-control"; then
    echo "PASS: Surrogate-Control header present"
    PASS=$((PASS + 1))
else
    echo "FAIL: Missing Surrogate-Control header"
    FAIL=$((FAIL + 1))
fi

if echo "$HEADERS" | grep -qi "surrogate-key"; then
    echo "PASS: Surrogate-Key header present"
    PASS=$((PASS + 1))
else
    echo "FAIL: Missing Surrogate-Key header"
    FAIL=$((FAIL + 1))
fi

# ---------------------------------------------------------------------------
# JSON-LD on post pages
# ---------------------------------------------------------------------------

POST_BODY=$(curl -s "$BASE/post/hello-world")
if echo "$POST_BODY" | grep -q 'application/ld+json'; then
    echo "PASS: JSON-LD structured data on post page"
    PASS=$((PASS + 1))
else
    echo "FAIL: Missing JSON-LD structured data on post page"
    FAIL=$((FAIL + 1))
fi

# ---------------------------------------------------------------------------
# Admin routes (unauthenticated)
# ---------------------------------------------------------------------------

check "Login page returns 200" \
    "$BASE/admin/login" "200" "password"

# Admin dashboard should redirect to login without auth cookie
ADMIN_STATUS=$(curl -o /dev/null -s -w "%{http_code}" --max-redirs 0 "$BASE/admin")
if [ "$ADMIN_STATUS" = "302" ]; then
    echo "PASS: Admin dashboard redirects without auth"
    PASS=$((PASS + 1))
else
    echo "FAIL: Admin dashboard expected 302, got $ADMIN_STATUS"
    FAIL=$((FAIL + 1))
fi

# ---------------------------------------------------------------------------
# Admin cache headers — should never be cached
# ---------------------------------------------------------------------------

LOGIN_HEADERS=$(curl -s -D- -o /dev/null "$BASE/admin/login")
if echo "$LOGIN_HEADERS" | grep -qi "no-store"; then
    echo "PASS: Admin login has no-store cache header"
    PASS=$((PASS + 1))
else
    echo "FAIL: Admin login missing no-store cache header"
    FAIL=$((FAIL + 1))
fi

# ---------------------------------------------------------------------------
# Results
# ---------------------------------------------------------------------------

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ] || exit 1
