#!/usr/bin/env bash
# Integration tests for Edge CMS — shared by the Rust, TypeScript and Go
# Compute backends. Runs against a local Viceroy instance and encodes
# docs/architecture/security-hardening-contract.md.
#
# Usage:
#   1. Start Viceroy in a backend dir:  fastly compute serve     (127.0.0.1:7676)
#   2. Run the suite from the repo root: rust/tests/integration.sh
#      (or: scripts/run-integration.sh <rust|typescript|go>)
#
# Environment overrides:
#   EDGE_CMS_BASE_URL        default http://127.0.0.1:7676
#   EDGE_CMS_SITE_URL        expected site_url, default http://127.0.0.1:7676
#   EDGE_CMS_ORIGIN_AUTH     default local-dev-origin-auth
#   EDGE_CMS_ADMIN_PASSWORD  default testpassword
#
# Requires: bash, curl, grep, sed, tr, head, cmp
#
# Notes:
#   * The session cookie is carried in $SESSION (the cookie is `Secure`,
#     `Path=/admin`, so a stock curl jar is unreliable over http://127.0.0.1).
#   * At most 5 POST /admin/login requests are made per run so the in-Compute
#     login rate limit (5 per 60s) is not tripped; re-running within 60s on a
#     backend with a working ERL may 429 the login. Viceroy may stub ERL.
set -euo pipefail

BASE="${EDGE_CMS_BASE_URL:-http://127.0.0.1:7676}"
SITE_URL="${EDGE_CMS_SITE_URL:-http://127.0.0.1:7676}"
ORIGIN_AUTH="${EDGE_CMS_ORIGIN_AUTH:-local-dev-origin-auth}"
ADMIN_PASSWORD="${EDGE_CMS_ADMIN_PASSWORD:-testpassword}"

PASS=0
FAIL=0
STATUS=""
SESSION=""

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT
HDRS="$WORKDIR/headers"
BODY="$WORKDIR/body"

CSP_EXPECTED="default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; font-src 'self'; connect-src 'self'; frame-src https://www.youtube-nocookie.com https://www.youtube.com https://player.vimeo.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'"
SURROGATE_PAGE_RE='max-age=86400, stale-while-revalidate=60, stale-if-error=86400'

# Fixture sidebar (rust/tests/kv-content.json `_sidebar`); restored at the end.
FIXTURE_SIDEBAR='{"items":[{"type":"category","label":"Getting Started","slug":"getting-started","children":["hello-world"]},{"type":"link","label":"GitHub","url":"https://github.com","icon":"github"}]}'

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

pass() {
    echo "PASS: $1"
    PASS=$((PASS + 1))
}

fail() {
    echo "FAIL: $1"
    if [ -n "${2:-}" ]; then
        echo "      $2"
    fi
    FAIL=$((FAIL + 1))
}

section() {
    echo ""
    echo "--- $1"
}

# req METHOD PATH [curl args...]
# Result: $STATUS, $HDRS (response headers), $BODY (response body).
# Per-call switches (set as a prefix, e.g. `SEND_AUTH=0 req GET /`):
#   SEND_AUTH=0    omit the Edge-CMS-Origin-Auth header
#   SEND_ORIGIN=0  omit the Origin header on mutating requests
#   SEND_COOKIE=0  omit the session cookie
# Override the cookie for one call with `SESSION=value req ...`.
req() {
    local method="$1" path="$2"
    shift 2
    local -a args=(-s -o "$BODY" -D "$HDRS" -w '%{http_code}' --max-time 120 -X "$method")
    if [ "${SEND_AUTH:-1}" = 1 ]; then
        args+=(-H "Edge-CMS-Origin-Auth: $ORIGIN_AUTH")
    fi
    if [ "${SEND_ORIGIN:-1}" = 1 ] && [ "$method" != GET ] && [ "$method" != HEAD ]; then
        args+=(-H "Origin: $BASE")
    fi
    if [ "${SEND_COOKIE:-1}" = 1 ] && [ -n "$SESSION" ]; then
        args+=(-H "Cookie: session=$SESSION")
    fi
    : >"$BODY"
    : >"$HDRS"
    STATUS=$(curl "${args[@]}" "$@" "$BASE$path" 2>/dev/null || true)
    if [ -z "$STATUS" ]; then
        STATUS=000
    fi
}

# Value of the last header called $1 in the previous response (CR stripped).
hdr_value() {
    grep -i "^$1:" "$HDRS" | tail -n 1 | sed 's/^[^:]*:[[:space:]]*//' | tr -d '\r' || true
}

# expect_status DESC CODE...   (any of the listed codes)
expect_status() {
    local desc="$1" code
    shift
    for code in "$@"; do
        if [ "$STATUS" = "$code" ]; then
            pass "$desc (HTTP $STATUS)"
            return
        fi
    done
    fail "$desc" "expected HTTP $*, got $STATUS"
}

# expect_status_not DESC CODE...
expect_status_not() {
    local desc="$1" code
    shift
    for code in "$@"; do
        if [ "$STATUS" = "$code" ]; then
            fail "$desc" "did not expect HTTP $STATUS"
            return
        fi
    done
    pass "$desc (HTTP $STATUS)"
}

# expect_header DESC NAME ERE   (case-insensitive match on the header value)
expect_header() {
    local v
    v="$(hdr_value "$2")"
    if [ -n "$v" ] && printf '%s' "$v" | grep -Eiq -- "$3"; then
        pass "$1"
    else
        fail "$1" "header '$2' = '${v:-<absent>}', wanted /$3/"
    fi
}

# expect_header_eq DESC NAME VALUE   (exact match)
expect_header_eq() {
    local v
    v="$(hdr_value "$2")"
    if [ "$v" = "$3" ]; then
        pass "$1"
    else
        fail "$1" "header '$2' = '${v:-<absent>}', wanted exactly '$3'"
    fi
}

expect_header_absent() {
    local v
    v="$(hdr_value "$2")"
    if [ -z "$v" ]; then
        pass "$1"
    else
        fail "$1" "header '$2' unexpectedly present: $v"
    fi
}

# expect_body DESC FIXED_STRING
expect_body() {
    if grep -aqF -- "$2" "$BODY"; then
        pass "$1"
    else
        fail "$1" "body missing '$2'"
    fi
}

# expect_body_re DESC ERE
expect_body_re() {
    if grep -aqE -- "$2" "$BODY"; then
        pass "$1"
    else
        fail "$1" "body does not match /$2/"
    fi
}

# expect_no_body DESC FIXED_STRING   (case-insensitive)
expect_no_body() {
    if grep -aqiF -- "$2" "$BODY"; then
        fail "$1" "body unexpectedly contains '$2'"
    else
        pass "$1"
    fi
}

# expect_no_body_re DESC ERE
expect_no_body_re() {
    if grep -aqE -- "$2" "$BODY"; then
        fail "$1" "body unexpectedly matches /$2/"
    else
        pass "$1"
    fi
}

# security_headers DESC — contract §2 headers on the previous response.
security_headers() {
    local missing="" name
    for name in Content-Security-Policy X-Content-Type-Options Referrer-Policy X-Frame-Options; do
        if [ -z "$(hdr_value "$name")" ]; then
            missing="$missing $name"
        fi
    done
    if [ -n "$missing" ]; then
        fail "$1: security headers" "missing:$missing"
        return
    fi
    if ! hdr_value X-Content-Type-Options | grep -qi '^nosniff$'; then
        fail "$1: security headers" "X-Content-Type-Options is not nosniff"
        return
    fi
    pass "$1: security headers (CSP, nosniff, Referrer-Policy, X-Frame-Options)"
}

# no_inline_code DESC — contract §2: no inline <script>, <style>, style="", on*=.
no_inline_code() {
    expect_no_body_re "$1: no inline script/style/on* handlers" \
        '<script>|<style[ >]|[[:space:]]style="|[[:space:]]on[a-z]+='
}

# form_post PATH [curl args...] — POST; pass fields with --data-urlencode.
# Origin is added by req.
form_post() {
    local path="$1"
    shift
    req POST "$path" "$@"
}

put_sidebar() {
    req PUT /admin/sidebar -H 'Content-Type: application/json' --data-binary "$1"
}

# ---------------------------------------------------------------------------
# Fixtures for request bodies
# ---------------------------------------------------------------------------

SLUG="qa-hardening-post"
INVALID_SLUG_POST="qa-invalid-post"

PNG_SMALL="$WORKDIR/small.png"
{
    printf '\x89PNG\r\n\x1a\n'
    head -c 64 /dev/zero
} >"$PNG_SMALL"

HTML_BYTES="$WORKDIR/html.png"
printf '<html><script>alert(1)</script></html>' >"$HTML_BYTES"

PNG_HUGE="$WORKDIR/huge.png"
{
    printf '\x89PNG\r\n\x1a\n'
    head -c $((10 * 1024 * 1024)) /dev/zero
} >"$PNG_HUGE"

# Pre-encoded urlencoded form bodies with a huge `content` field. Built as
# files and sent with --data-binary: curl's --data-urlencode @file is
# quadratic and takes tens of seconds at this size.
big_form() {
    local out="$1" bytes="$2"
    printf 'title=Too+big&slug=%s&status=published&content=' "$INVALID_SLUG_POST" >"$out"
    head -c "$bytes" /dev/zero | tr '\0' 'a' >>"$out"
}
FORM_600K="$WORKDIR/form-600k.txt"
big_form "$FORM_600K" $((600 * 1024))
FORM_1200K="$WORKDIR/form-1200k.txt"
big_form "$FORM_1200K" $((1200 * 1024))

POST_CONTENT='# QA Heading

Para text survives.

<script>alert(1)</script>

<a href="javascript:alert(1)">x</a>

<img src=x onerror=alert(1)>

<iframe src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ" width="560" height="315" allowfullscreen></iframe>

<iframe src="https://evil.example.com/embed"></iframe>

| h1 | h2 |
|----|----|
| c1 | c2 |

```rust
fn main() {}
```
'

echo "=== Edge CMS Integration Tests ==="
echo "Target:   $BASE"
echo "site_url: $SITE_URL"

# ---------------------------------------------------------------------------
section "1. Origin authentication (contract §1)"
# ---------------------------------------------------------------------------

SEND_AUTH=0 req GET /
expect_status "request without Edge-CMS-Origin-Auth -> 403" 403
expect_body "403 body is 'Forbidden'" "Forbidden"
expect_header "403 is private, no-store" Cache-Control 'private, no-store'
security_headers "403 response"

SEND_AUTH=0 req GET / -H "Edge-CMS-Origin-Auth: definitely-the-wrong-token"
expect_status "wrong Edge-CMS-Origin-Auth -> 403" 403

same_len_wrong="$(printf '%*s' "${#ORIGIN_AUTH}" '' | tr ' ' x)"
SEND_AUTH=0 req GET / -H "Edge-CMS-Origin-Auth: $same_len_wrong"
expect_status "wrong token of identical length -> 403" 403

SEND_AUTH=0 req GET /admin
expect_status "origin auth enforced before routing (/admin without header -> 403)" 403

SEND_AUTH=0 req GET /assets/style.css
expect_status "origin auth also guards assets" 403

# ---------------------------------------------------------------------------
section "2/3. Reader routes, security headers, caching, SEO (contract §2, §7, §10)"
# ---------------------------------------------------------------------------

req GET /
expect_status "home returns 200" 200
security_headers "home"
expect_header_eq "home: Content-Security-Policy is the contract value" Content-Security-Policy "$CSP_EXPECTED"
expect_header "home: Permissions-Policy" Permissions-Policy 'camera=\(\)'
expect_header_eq "home: Cross-Origin-Opener-Policy" Cross-Origin-Opener-Policy "same-origin"
expect_header "home: Surrogate-Control has stale-if-error" Surrogate-Control 'stale-if-error'
expect_header "home: Surrogate-Control matches contract" Surrogate-Control "$SURROGATE_PAGE_RE"
expect_header "home: Surrogate-Key includes post-index" Surrogate-Key 'post-index'
expect_header "home: Cache-Control public max-age" Cache-Control 'max-age=[0-9]+'
expect_header_absent "home: no X-Robots-Tag noindex" X-Robots-Tag
expect_body "home: canonical link is absolute" "<link rel=\"canonical\" href=\"$SITE_URL/"
expect_body_re "home: meta description present" '<meta[^>]*name="description"[^>]*content="[^"]+"'
expect_no_body "home: no fonts.googleapis.com" "fonts.googleapis.com"
expect_body "home: RSS alternate link" 'type="application/rss+xml"'
expect_body "home: lists the seeded post" "Hello World"
no_inline_code "home"

req GET /post/hello-world
expect_status "post page returns 200" 200
security_headers "post page"
expect_body "post page: renders title" "Hello World"
expect_header "post page: Surrogate-Control has stale-if-error" Surrogate-Control 'stale-if-error'
expect_header "post page: Surrogate-Key includes post-hello-world" Surrogate-Key 'post-hello-world'
expect_body "post page: canonical link is absolute" "<link rel=\"canonical\" href=\"$SITE_URL/post/hello-world\""
expect_body_re "post page: meta description present" '<meta[^>]*name="description"[^>]*content="[^"]+"'
expect_body "post page: JSON-LD BlogPosting" 'application/ld+json'
expect_body "post page: JSON-LD is typed BlogPosting" 'BlogPosting'
expect_no_body "post page: no fonts.googleapis.com" "fonts.googleapis.com"
no_inline_code "post page"

req GET /tag/fastly
expect_status "tag page returns 200" 200
security_headers "tag page"
expect_header "tag page: Surrogate-Control has stale-if-error" Surrogate-Control 'stale-if-error'
expect_header "tag page: Surrogate-Key includes tag-fastly" Surrogate-Key 'tag-fastly'
expect_body "tag page: canonical link is absolute" "<link rel=\"canonical\" href=\"$SITE_URL/"
expect_body_re "tag page: meta description present" '<meta[^>]*name="description"[^>]*content="[^"]+"'
expect_body "tag page: lists the seeded post" "Hello World"
expect_no_body "tag page: no fonts.googleapis.com" "fonts.googleapis.com"

# ---------------------------------------------------------------------------
section "4. robots.txt, sitemap, feed (contract §13)"
# ---------------------------------------------------------------------------

printf 'User-agent: *\nDisallow: /admin\nDisallow: /api/\nSitemap: %s/sitemap.xml\n' "$SITE_URL" >"$WORKDIR/robots.expected"
req GET /robots.txt
expect_status "robots.txt returns 200" 200
if cmp -s "$BODY" "$WORKDIR/robots.expected"; then
    pass "robots.txt matches the contract exactly"
else
    fail "robots.txt matches the contract exactly" "body differs from expected; got: $(head -c 300 "$BODY" | tr '\n' '|')"
fi
expect_header "robots.txt: Cache-Control public, max-age=300" Cache-Control 'public, max-age=300'
expect_header "robots.txt: Surrogate-Control has stale-if-error" Surrogate-Control 'stale-if-error'
security_headers "robots.txt"

req GET /sitemap.xml
expect_status "sitemap returns 200" 200
expect_body "sitemap: urlset" "<urlset"
expect_body "sitemap: absolute <loc> for home" "<loc>$SITE_URL/"
expect_body "sitemap: lists the seeded post" "<loc>$SITE_URL/post/hello-world</loc>"
expect_body "sitemap: lastmod present" "<lastmod>"
expect_header "sitemap: Cache-Control public, max-age=300" Cache-Control 'public, max-age=300'
expect_header "sitemap: Surrogate-Control has stale-if-error" Surrogate-Control 'stale-if-error'

req GET /feed.xml
expect_status "feed returns 200" 200
expect_body "feed: rss root" "<rss"
expect_body "feed: absolute item link" "<link>$SITE_URL/post/hello-world</link>"
expect_body_re "feed: RFC-822 pubDate" '<pubDate>[A-Z][a-z]{2}, [0-9]{2} [A-Z][a-z]{2} [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} \+0000</pubDate>'
expect_body "feed: lastBuildDate" "<lastBuildDate>"
expect_body_re "feed: atom self link" '<atom:link[^>]*rel="self"'
expect_header "feed: Cache-Control public, max-age=300" Cache-Control 'public, max-age=300'
expect_header "feed: Surrogate-Control has stale-if-error" Surrogate-Control 'stale-if-error'
security_headers "feed"

# ---------------------------------------------------------------------------
section "5. Assets (contract §7, §10) and /images (contract §8)"
# ---------------------------------------------------------------------------

for asset in style.css admin.css site.js admin.js fonts/dm-sans.woff2 fonts/fraunces.woff2 fonts/jetbrains-mono.woff2; do
    req GET "/assets/$asset"
    expect_status "asset /assets/$asset returns 200" 200
    expect_header "asset /assets/$asset: Cache-Control immutable" Cache-Control 'immutable'
done

req GET /assets/fonts/dm-sans.woff2
expect_header_eq "dm-sans.woff2 Content-Type is font/woff2" Content-Type "font/woff2"
security_headers "font asset"

req GET "/assets/style.css?v=dev"
expect_status "asset query string is ignored" 200
expect_no_body "style.css: no fonts.googleapis.com" "fonts.googleapis.com"

req GET /assets/nope.js
expect_status "unknown asset -> 404" 404

req GET /images/x.jpg
expect_status "/images/x.jpg -> 404 from Compute" 404
security_headers "/images 404"

# ---------------------------------------------------------------------------
section "6. Error pages (contract §7)"
# ---------------------------------------------------------------------------

req GET /definitely-not-a-route
expect_status "unknown route -> 404" 404
expect_header "404 page: Cache-Control private, no-store" Cache-Control 'private, no-store'
expect_header_absent "404 page: no Surrogate-Control" Surrogate-Control
security_headers "404 page"

req GET /post/nonexistent
expect_status "unknown post -> 404" 404
expect_header "unknown post: Cache-Control private, no-store" Cache-Control 'private, no-store'

# ---------------------------------------------------------------------------
section "Admin surface, unauthenticated"
# ---------------------------------------------------------------------------

req GET /admin/login
expect_status "login page returns 200" 200
expect_body "login page: password field" "password"
expect_header "login page: no-store" Cache-Control 'no-store'
expect_header "login page: X-Robots-Tag noindex" X-Robots-Tag 'noindex'
security_headers "login page"
no_inline_code "login page"

req GET /admin
expect_status "dashboard without session redirects" 302 303
expect_header "dashboard redirect targets /admin/login" Location '/admin/login'
security_headers "admin redirect"

SESSION="" req POST /admin/rebuild-index
expect_status "rebuild-index without session is not allowed" 302 303 401

# ---------------------------------------------------------------------------
section "7. CSRF on login (contract §3)"
# ---------------------------------------------------------------------------

SEND_ORIGIN=0 form_post /admin/login --data-urlencode "password=$ADMIN_PASSWORD"
expect_status "login POST without Origin/Sec-Fetch-Site -> 403" 403
expect_header_absent "CSRF reject sets no cookie" Set-Cookie

SEND_ORIGIN=0 form_post /admin/login --data-urlencode "password=$ADMIN_PASSWORD" \
    -H "Sec-Fetch-Site: cross-site" -H "Origin: $BASE"
expect_status "login POST with Sec-Fetch-Site: cross-site -> 403 (even with matching Origin)" 403
expect_header_absent "cross-site reject sets no cookie" Set-Cookie

SEND_ORIGIN=0 form_post /admin/login --data-urlencode "password=$ADMIN_PASSWORD" \
    -H "Origin: https://evil.example"
expect_status "login POST with foreign Origin -> 403" 403

# ---------------------------------------------------------------------------
section "8. Login (contract §4)"
# ---------------------------------------------------------------------------

SEND_ORIGIN=0 form_post /admin/login --data-urlencode "password=not-the-password" \
    -H "Sec-Fetch-Site: same-origin"
expect_status_not "wrong password (same-origin via Sec-Fetch-Site) passes CSRF, no server error" 403 429 500 502 503
if grep -qi '^set-cookie:[[:space:]]*session=v1\.' "$HDRS"; then
    fail "wrong password issues no session cookie" "a v1 session cookie was set"
else
    pass "wrong password issues no session cookie"
fi

form_post /admin/login --data-urlencode "password=$ADMIN_PASSWORD"
expect_status "correct password logs in (redirect)" 302 303
expect_header "login sets v1 session cookie" Set-Cookie 'session=v1\.'
expect_header "session cookie is HttpOnly" Set-Cookie 'HttpOnly'
expect_header "session cookie Path=/admin" Set-Cookie 'Path=/admin'
expect_header "session cookie SameSite=Strict" Set-Cookie 'SameSite=Strict'
expect_header "session cookie is Secure" Set-Cookie 'Secure'
expect_header "session cookie Max-Age=3600" Set-Cookie 'Max-Age=3600'
expect_header "login redirect targets /admin" Location '/admin'
SESSION="$(sed -n 's/^[Ss]et-[Cc]ookie:[[:space:]]*session=\([^;]*\).*/\1/p' "$HDRS" | tail -n 1 | tr -d '\r' || true)"
if printf '%s' "$SESSION" | grep -Eq '^v1\.[0-9]+\.[0-9a-f]{32}\.[A-Za-z0-9+/]+=*$'; then
    pass "session token format v1.<expires>.<nonce32>.<b64sig>"
else
    fail "session token format v1.<expires>.<nonce32>.<b64sig>" "unexpected token shape (length ${#SESSION})"
fi
OLD_SESSION="$SESSION"

legacy_token="1999999999.$(printf 'a%.0s' $(seq 1 43))="
SESSION="$legacy_token" req GET /admin
expect_status "legacy 2-part session token is rejected" 302 303

IFS=. read -r tok_v tok_exp tok_nonce tok_sig <<<"$OLD_SESSION"
flip=a
if [ "${tok_nonce:0:1}" = a ]; then
    flip=b
fi
tampered="$tok_v.$tok_exp.$flip${tok_nonce:1}.$tok_sig"
SESSION="$tampered" req GET /admin
expect_status "tampered session (nonce changed, signature stale) is rejected" 302 303

# ---------------------------------------------------------------------------
section "9. Authenticated admin + post creation + markdown sanitisation (contract §5, §11)"
# ---------------------------------------------------------------------------

req GET /admin
expect_status "dashboard with session returns 200" 200
expect_header "dashboard: Cache-Control no-store" Cache-Control 'no-store'
expect_header_absent "dashboard: no Surrogate-Control" Surrogate-Control
expect_header "dashboard: X-Robots-Tag noindex" X-Robots-Tag 'noindex'
security_headers "dashboard"
no_inline_code "dashboard"

req GET /admin/posts/new
expect_status "editor (new post) returns 200" 200
expect_header "editor: Cache-Control no-store" Cache-Control 'no-store'
no_inline_code "editor"

# Clean up any leftover from an aborted earlier run (result ignored).
req DELETE "/admin/posts/$SLUG"

form_post /admin/posts \
    --data-urlencode "title=QA Post" \
    --data-urlencode "slug=$SLUG" \
    --data-urlencode "content=$POST_CONTENT" \
    --data-urlencode "excerpt=A post created by the integration suite" \
    --data-urlencode "tags=QA Tag, second tag" \
    --data-urlencode "status=published" \
    --data-urlencode "featured_image="
expect_status "create post -> redirect" 302 303

req GET "/post/$SLUG"
expect_status "created post is readable" 200
expect_body "post: title rendered" "QA Post"
expect_body "post: markdown paragraph rendered" "Para text survives."
expect_no_body "sanitised: no <script>alert" "<script>alert"
expect_no_body "sanitised: no javascript: URL" "javascript:"
expect_no_body "sanitised: no onerror handler" "onerror"
expect_body "sanitised: YouTube iframe kept (youtube-nocookie.com)" "youtube-nocookie.com"
expect_no_body "sanitised: non-allowlisted iframe removed" "evil.example.com"
expect_body "sanitised: table kept" "<table"
expect_body "sanitised: language-rust class kept" "language-rust"
expect_body "post: canonical link is absolute" "<link rel=\"canonical\" href=\"$SITE_URL/post/$SLUG\""
security_headers "created post"

req GET /tag/qa-tag
expect_status "tags are normalised (qa-tag page exists)" 200
expect_body "tag page lists the created post" "QA Post"

# ---------------------------------------------------------------------------
section "10. Validation (contract §5)"
# ---------------------------------------------------------------------------

form_post /admin/posts \
    --data-urlencode "title=Duplicate" --data-urlencode "slug=$SLUG" \
    --data-urlencode "content=dup" --data-urlencode "status=published"
expect_status "duplicate slug on create -> 409" 409
expect_header "409 is no-store" Cache-Control 'private, no-store'

form_post /admin/posts -H 'Accept: application/json' \
    --data-urlencode "title=Duplicate" --data-urlencode "slug=$SLUG" \
    --data-urlencode "content=dup" --data-urlencode "status=published"
expect_status "duplicate slug (JSON caller) -> 409" 409
expect_body '409 JSON caller gets {"error": ...}' '"error"'

form_post /admin/posts \
    --data-urlencode "title=Bad" --data-urlencode "slug=Bad Slug" \
    --data-urlencode "content=x" --data-urlencode "status=published"
expect_status "invalid slug 'Bad Slug' -> 400" 400

form_post /admin/posts \
    --data-urlencode "title=" --data-urlencode "slug=$INVALID_SLUG_POST" \
    --data-urlencode "content=x" --data-urlencode "status=published"
expect_status "empty title -> 400" 400

form_post /admin/posts \
    --data-urlencode "title=Excerpt too long" --data-urlencode "slug=$INVALID_SLUG_POST" \
    --data-urlencode "content=x" --data-urlencode "status=published" \
    --data-urlencode "excerpt=$(head -c 501 /dev/zero | tr '\0' 'e')"
expect_status "excerpt over 500 chars -> 400" 400

form_post /admin/posts \
    --data-urlencode "title=Bad status" --data-urlencode "slug=$INVALID_SLUG_POST" \
    --data-urlencode "content=x" --data-urlencode "status=bogus"
expect_status "status other than published|draft -> 400" 400

form_post /admin/posts -H 'Expect:' \
    -H 'Content-Type: application/x-www-form-urlencoded' --data-binary "@$FORM_600K"
expect_status "content over 512 KiB (body under 1 MiB) -> 413" 413

form_post /admin/posts -H 'Expect:' \
    -H 'Content-Type: application/x-www-form-urlencoded' --data-binary "@$FORM_1200K"
expect_status "form body over 1 MiB -> 413" 413

req GET "/post/$INVALID_SLUG_POST"
expect_status "rejected creates were not persisted" 404

# ---------------------------------------------------------------------------
section "11. Partial update keeps omitted fields (contract §5)"
# ---------------------------------------------------------------------------

form_post "/admin/posts/$SLUG" --data-urlencode "title=QA Post Updated"
expect_status "update with only title -> redirect" 302 303

req GET "/post/$SLUG"
expect_status "updated post still public (status kept)" 200
expect_body "update: new title applied" "QA Post Updated"
expect_body "update: content kept" "Para text survives."
expect_body "update: sanitised iframe still present" "youtube-nocookie.com"

form_post "/admin/posts/$SLUG" --data-urlencode "status=bogus"
expect_status "update with invalid status -> 400" 400

# ---------------------------------------------------------------------------
section "12. Sidebar (contract §5)"
# ---------------------------------------------------------------------------

req GET /
expect_body "fixture sidebar: category rendered" "Getting Started"
expect_body "fixture sidebar: link rendered" "https://github.com"

req GET /admin/sidebar
expect_status "admin sidebar page returns 200" 200
expect_header "admin sidebar: no-store" Cache-Control 'no-store'

put_sidebar '{"items":[{"type":"category","label":"QA Category","slug":"qa-category","children":["hello-world"]},{"type":"link","label":"QA Link","url":"https://example.com/qa-link","icon":"link"}]}'
expect_status "PUT sidebar with category + link" 200 204
req GET /
expect_body "sidebar render: category present" "QA Category"
expect_body "sidebar render: link url present" "https://example.com/qa-link"
expect_body "sidebar render: link label present" "QA Link"

put_sidebar '{"items":[{"type":"link","label":"Bad","url":"javascript:alert(1)"}]}'
expect_status "PUT sidebar with javascript: url -> 400" 400
put_sidebar '{"items":[{"type":"link","label":"Bad","url":"//evil.example/x"}]}'
expect_status "PUT sidebar with protocol-relative url -> 400" 400
put_sidebar '{"items":[{"type":"link","label":"Bad","url":"data:text/html,x"}]}'
expect_status "PUT sidebar with data: url -> 400" 400
put_sidebar '{"items":[{"type":"category","label":"Bad","slug":"Not A Slug","children":[]}]}'
expect_status "PUT sidebar with invalid category slug -> 400" 400
put_sidebar '{"items":[{"type":"link","label":"","url":"/x"}]}'
expect_status "PUT sidebar with empty label -> 400" 400
put_sidebar 'this is not json'
expect_status "PUT sidebar with malformed JSON -> 400" 400

req GET /
expect_no_body "rejected sidebar updates did not persist javascript: URLs" "javascript:"
expect_body "rejected sidebar updates left the previous sidebar in place" "QA Category"

put_sidebar '{"items":[{"type":"link","label":"Unknown Fields","url":"/about","icon":"link","bogus":"dropped"}],"also_unknown":true}'
expect_status "PUT sidebar with unknown fields is accepted" 200 204
req GET /
expect_body "unknown-field sidebar renders relative url" 'href="/about"'

many_items=""
for i in $(seq 1 51); do
    many_items="$many_items{\"type\":\"link\",\"label\":\"L$i\",\"url\":\"/p$i\"},"
done
printf '{"items":[%s]}' "${many_items%,}" >"$WORKDIR/sidebar-51.json"
put_sidebar "@$WORKDIR/sidebar-51.json"
expect_status "PUT sidebar with 51 items -> 400" 400

printf '{"items":[],"pad":"%s"}' "$(head -c 70000 /dev/zero | tr '\0' 'p')" >"$WORKDIR/sidebar-big.json"
put_sidebar "@$WORKDIR/sidebar-big.json"
expect_status "PUT sidebar over 64 KiB -> 400" 400

req POST /admin/sidebar -H 'Content-Type: application/json' --data-binary "$FIXTURE_SIDEBAR"
expect_status "POST /admin/sidebar route is removed" 404 405

put_sidebar "$FIXTURE_SIDEBAR"
expect_status "restore fixture sidebar" 200 204

# ---------------------------------------------------------------------------
section "13. Uploads (contract §5)"
# ---------------------------------------------------------------------------

req POST "/admin/images?slug=test&filename=evil.svg" -H 'Expect:' \
    -H 'Content-Type: image/svg+xml' --data-binary "@$PNG_SMALL"
expect_status "upload evil.svg -> 400" 400

req POST "/admin/images?slug=test&filename=Evil.PNG" -H 'Expect:' \
    -H 'Content-Type: image/png' --data-binary "@$PNG_SMALL"
expect_status "upload with uppercase filename -> 400" 400

req POST "/admin/images?slug=test&filename=..%2Fescape.png" -H 'Expect:' \
    -H 'Content-Type: image/png' --data-binary "@$PNG_SMALL"
expect_status "upload with path traversal filename -> 400" 400

req POST "/admin/images?slug=test&filename=page.png" -H 'Expect:' \
    -H 'Content-Type: image/png' --data-binary "@$HTML_BYTES"
expect_status "HTML bytes named .png -> 415" 415

req POST "/admin/images?slug=test&filename=mismatch.gif" -H 'Expect:' \
    -H 'Content-Type: image/gif' --data-binary "@$PNG_SMALL"
expect_status "PNG bytes named .gif (extension mismatch) -> 415" 415

req POST "/admin/images?slug=test&filename=huge.png" -H 'Expect:' \
    -H 'Content-Type: image/png' --data-binary "@$PNG_HUGE"
expect_status "upload over 10 MiB -> 413" 413

echo "SKIP: valid image upload (needs Object Storage, unavailable in Viceroy)"

# ---------------------------------------------------------------------------
section "14. rebuild-index (contract §8)"
# ---------------------------------------------------------------------------

SEND_ORIGIN=0 req POST /admin/rebuild-index
expect_status "rebuild-index without Origin -> 403" 403

req POST /admin/rebuild-index
expect_status "rebuild-index -> redirect" 302 303
expect_header "rebuild-index redirects to /admin" Location '/admin'

req GET /
expect_status "home after rebuild returns 200" 200
expect_body "home still lists the created post after rebuild" "QA Post Updated"
expect_body "home still lists the seeded post after rebuild" "Hello World"

# ---------------------------------------------------------------------------
section "15. Pagination (contract §10)"
# ---------------------------------------------------------------------------

req GET "/?page=999"
expect_status "/?page=999 -> 404" 404
expect_header "out-of-range page: no-store" Cache-Control 'private, no-store'

req GET "/?page=1"
expect_status "/?page=1 -> 200" 200

req GET "/tag/fastly?page=999"
expect_status "/tag/fastly?page=999 -> 404" 404

req GET "/tag/fastly?page=1"
expect_status "/tag/fastly?page=1 -> 200" 200

# ---------------------------------------------------------------------------
section "16. Delete (contract §3, §8)"
# ---------------------------------------------------------------------------

SEND_ORIGIN=0 req DELETE "/admin/posts/$SLUG" -H "Sec-Fetch-Site: cross-site"
expect_status "cross-site DELETE -> 403" 403

SEND_ORIGIN=0 req DELETE "/admin/posts/$SLUG" -H "Sec-Fetch-Site: same-site"
expect_status "same-site DELETE -> 403" 403

SEND_ORIGIN=0 req DELETE "/admin/posts/$SLUG"
expect_status "DELETE without Origin/Sec-Fetch-Site -> 403" 403

req GET "/post/$SLUG"
expect_status "post survives rejected deletes" 200

req DELETE "/admin/posts/$SLUG"
expect_status "delete post succeeds" 200 204 302 303

req GET "/post/$SLUG"
expect_status "deleted post -> 404" 404
expect_header "deleted post 404 is no-store" Cache-Control 'private, no-store'

req GET /
expect_no_body "home no longer lists the deleted post" "QA Post Updated"

# ---------------------------------------------------------------------------
section "17. Logout and session revocation (contract §4)"
# ---------------------------------------------------------------------------

SEND_ORIGIN=0 req POST /admin/logout -H "Sec-Fetch-Site: cross-site"
expect_status "cross-site logout -> 403" 403

req POST /admin/logout
expect_status "logout -> redirect" 302 303
expect_header "logout clears the session cookie" Set-Cookie 'session=;|Max-Age=0|Expires=Thu, 01 Jan 1970'

SESSION="$OLD_SESSION" req GET /admin
expect_status "revoked session cookie no longer reaches /admin" 302 303
expect_header "revoked session redirects to login" Location '/admin/login'

# ---------------------------------------------------------------------------
section "18. Edge Rate Limiting (contract §4)"
# ---------------------------------------------------------------------------

echo "NOTE: 429 from the login rate limiter (RateCounter login_attempts / PenaltyBox login_penalty) is"
echo "      not asserted; Viceroy may stub Edge Rate Limiting. The code path is exercised by the logins above."

# ---------------------------------------------------------------------------
echo ""
echo "=== Results: $PASS passed, $FAIL failed ($((PASS + FAIL)) checks) ==="
if [ "$FAIL" -ne 0 ]; then
    exit 1
fi
