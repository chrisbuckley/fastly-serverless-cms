# Security Hardening — Interface Contract

Every component (VCL/Terraform, Rust, TypeScript, Go, shared frontend, tests/CI) implements against
this document. **Rust is the reference implementation.** TS and Go must match behaviour exactly for
everything below (status codes, headers, template variables, validation rules). If you must deviate,
stop and report — do not invent a local variant.

Decisions (owner-approved):
- Rust is primary; TS/Go receive every security/data fix but future features land in Rust only.
- Compute origin is locked with a VCL-injected shared-secret header.
- Markdown is rendered then **sanitized with an allowlist** (not escaped wholesale).

---

## 1. Origin authentication (VCL → Compute)

- Header: `Edge-CMS-Origin-Auth: <token>`
- VCL: set on every backend request to a Compute backend (`bereq` in `vcl_miss` **and** `vcl_pass`),
  value from the private edge dictionary `edge_cms_private`, key `origin_auth_token`.
  VCL must `unset req.http.Edge-CMS-Origin-Auth` in `vcl_recv` so clients can't supply it.
- Compute: Secret Store `secrets`, key `origin_auth_token`. **First thing** in request handling,
  before routing: if the secret is missing → 403; if header missing or not equal (constant-time) → 403.
  Body: `Forbidden\n`, `Content-Type: text/plain; charset=utf-8`, `Cache-Control: private, no-store`.
- After origin auth passes, `Fastly-Client-IP` is trusted as the real client IP (geo, ERL, logs).
- Local dev / Viceroy: `tests/secrets.json` → `"origin_auth_token": "local-dev-origin-auth"`.
  Integration tests send it on every request.
- Terraform: generate with `random_password` (length 48, no special chars), write to both the secret
  store entry and the private dictionary item.

## 2. Security response headers (set by Compute on EVERY response, including errors/403)

```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; font-src 'self'; connect-src 'self'; frame-src https://www.youtube-nocookie.com https://www.youtube.com https://player.vimeo.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
X-Frame-Options: DENY
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
Cross-Origin-Opener-Policy: same-origin
```
- Routes under `/admin` (incl. login) additionally: `X-Robots-Tag: noindex, nofollow`.
- HSTS + HTTP→HTTPS are VCL's job (§9), not Compute's.
- Consequence for templates: **no inline `<script>`, no inline `<style>`, no `style=""`, no `on*=` attributes.**

## 3. CSRF

For every non-GET/HEAD request under `/admin` (login POST, logout, create, update, delete, upload,
sidebar, rebuild-index):
1. If `Sec-Fetch-Site` present → allow only `same-origin` (reject `same-site`, `cross-site`; `none` allowed).
2. Else if `Origin` present → allow only if its scheme+host[:port] equals `site_url` (§6).
3. Else → reject.
Reject = 403 `Forbidden\n`, no-store.

## 4. Admin auth & sessions

- Login rate limit inside Compute (in addition to VCL): Edge Rate Limiting `RateCounter` named
  `login_attempts` + `PenaltyBox` named `login_penalty`, keyed by client IP. On each `POST /admin/login`:
  if in penalty box → 429; increment counter; if count over the 60s window > 5 → add to penalty box for
  15 minutes and return 429. 429 body `Too many login attempts\n`, `Retry-After: 900`, no-store.
  (Viceroy may stub ERL; that's fine — code path must still compile and run.)
- Session token format: `v1.<expires_unix>.<nonce>.<b64sig>` where nonce = 16 random bytes hex (32 chars),
  sig = HMAC-SHA256(hmac_key, "v1.<expires>.<nonce>"), standard base64. TTL 3600s. Old 2-part tokens are rejected.
- Logout: KV `content` insert `session-revoked:<nonce>` = `<expires_unix>` (with TTL to expiry if the SDK
  supports it). `require_auth` rejects a token whose nonce has a revocation key. Then clear cookie.
- Cookie unchanged: `session=<token>; HttpOnly; Secure; SameSite=Strict; Path=/admin; Max-Age=3600`.

## 5. Input validation (server-side, all backends identical)

| Field | Rule | On failure |
|---|---|---|
| post slug | `^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$` | 400 |
| title | 1–200 chars after trim | 400 |
| excerpt | ≤ 500 chars | 400 |
| content | ≤ 512 KiB | 413 |
| tags | split on `,`, trim, lowercase, spaces→`-`, keep `^[a-z0-9][a-z0-9-]{0,49}$`, dedupe, max 20 | drop invalid silently |
| status | `published` \| `draft`; missing on update → keep existing | 400 if other value |
| form/JSON body | ≤ 1 MiB (check `Content-Length` first, then actual size) | 413 |
| sidebar JSON | ≤ 64 KiB, ≤ 50 items, schema below | 400 |
| upload body | ≤ 10 MiB | 413 |
| upload filename | `^[a-z0-9][a-z0-9_-]{0,63}\.(jpg|jpeg|png|webp|gif)$` | 400 |
| upload type | detect from magic bytes (JPEG `FF D8 FF`, PNG `89 50 4E 47 0D 0A 1A 0A`, GIF `GIF87a`/`GIF89a`, WEBP `RIFF....WEBP`); must match extension; this detected type is the Content-Type sent to Object Storage. SVG/anything else rejected | 415 |

- Create when `post:<slug>` exists → 409. Rename (`new slug != old slug`) when target exists → 409.
- Update: any field omitted (or empty for title/content) keeps its existing value.
- Errors for HTML form posts re-render the editor with `error` set (status 400/409/413); errors for JSON/API
  callers return `{"error": "..."}`. Use the request `Accept` header / content type to decide.
- TS: URL/form decoding must never throw (malformed `%` → treat raw).

Sidebar schema:
- `{"items": [...]}`; item `{"type":"category","label":1–100,"slug":<post-slug rule>,"children":[<post slugs>]}`
  or `{"type":"link","label":1–100,"url":U,"icon":optional ^[a-z0-9-]{1,32}$}`.
- U must be `https://…`, `http://…`, or start with `/` but not `//`. Anything else (e.g. `javascript:`) → 400.
- Unknown fields are dropped (typed deserialisation; TS must validate explicitly).
- Only `PUT /admin/sidebar` (JSON). Remove any `POST /admin/sidebar` route.
- Render-time defence: when rendering, links whose url fails rule U are omitted.

## 6. Configuration (Config Store `cache_config`)

| Key | Default if missing | Notes |
|---|---|---|
| `site_url` | `https://` + `Host` header | absolute, no trailing slash. Local: `http://127.0.0.1:7676` |
| `page_ttl` | 86400 | was 2592000 |
| `asset_ttl` | 31536000 | |
| `page_size` | 10 | home + tag pagination |

All three backends' `tests/cache-config.json`:
`{"site_url":"http://127.0.0.1:7676","page_ttl":"86400","asset_ttl":"31536000","image_ttl":"31536000","page_size":"10"}`

## 7. Caching

- Pages (home, post, tag): `Surrogate-Control: max-age=<page_ttl>, stale-while-revalidate=60, stale-if-error=86400`,
  `Cache-Control: max-age=<page_ttl>, public` (VCL rewrites HTML browser TTL), surrogate keys as today
  (`post-index`, `post-<slug>`, `tag-<tag>`, `sidebar` …).
- feed.xml, sitemap.xml, robots.txt: same Surrogate-Control; `Cache-Control: public, max-age=300`; key `post-index`.
- Assets `/assets/*`: `Cache-Control: public, max-age=31536000, immutable`; Surrogate-Control max-age=asset_ttl.
  URLs are versioned `?v={{asset_version}}`; `asset_version` = env `FASTLY_SERVICE_VERSION` or `dev`.
- Errors (404, 400, 403, 409, 413, 415, 429, 500) and all admin responses: `Cache-Control: private, no-store`, no Surrogate-Control.
- Purge (Rust/TS/Go identical): POST `https://api.fastly.com/service/<purge_service_id>/purge` via backend
  `fastly-api`, `Fastly-Key`, `Surrogate-Key: <keys>`, `Fastly-Soft-Purge: 1`. **Check status is 2xx**; on failure
  log status + first 200 bytes of body and return `false`. Admin handlers that purge redirect with
  `?purge=failed` appended when it failed (dashboard shows a warning banner when `purge_failed` is true).
- Keys purged: create → `post-index post-<slug> sidebar` + `tag-<t>` for each tag; update → same plus old slug/old tags;
  delete → `post-index post-<slug> sidebar` + tags; sidebar save → `sidebar post-index`; upload → `image-<slug>`.
- Go: replace `purge.PurgeSurrogateKey` with the API call above.

## 8. Data integrity

- KV errors: only "not found" means empty/absent. Any other KV error → propagate → 500 (no-store). Never write
  an index derived from a failed read.
- Write order on update: write new `post:<slug>` → update `_index` → delete old key (rename only) → purge.
- `_index` updates: use generation-conditional insert (if-generation-match) with up to 5 retries if the SDK
  supports it; if not, plain insert. Document which in code comment.
- New route `POST /admin/rebuild-index` (auth + CSRF): list keys with prefix `post:`, rebuild `_index` from them
  (sorted by created_at desc), purge `post-index`, redirect `/admin`.
- Revisions: before overwriting a post on update, insert `rev:<slug>:<unix_ts>` = previous JSON (TTL 30 days if supported).
- Soft delete: delete inserts `trash:<slug>` = post JSON (TTL 30 days if supported) before removing `post:<slug>`.
- `PostMeta` gains optional `updated_at` (serde default / omitempty; backwards compatible).
- Remove the Compute `/images/*` KV handler and the local `images` KV store; `/images/*` is VCL→Object Storage only.
  Compute returns 404 for `/images/*`.

## 9. VCL / Terraform (edge)

- HTTP → HTTPS 301 (`force_ssl` request setting or equivalent) and
  `Strict-Transport-Security: max-age=31536000; includeSubDomains` on all responses.
- Origin auth header injection (§1). Private dictionary `edge_cms_private`.
- Shield the Compute backends (`shield = var.shield_pop`). Explicit `connect_timeout=1000`,
  `first_byte_timeout=15000`, `between_bytes_timeout=10000` on all backends (Compute services too: `fastly-api`,
  `fastly-object-storage`).
- `/images/*` from Object Storage: Content-Type forced from an allowlist by extension (jpg/jpeg/png/webp/gif);
  anything else → 404. Add `X-Content-Type-Options: nosniff` and
  `Content-Security-Policy: default-src 'none'; sandbox` on image responses. Surrogate keys `images image-<slug>`
  (slug = first path segment after `/images/`).
- Rate limit: scope to `POST /admin/login` only, lowest rps the VCL rate limiter allows; fix all "5/min" comments
  (precise 5/min limit lives in Compute ERL §4).
- Split Object Storage keys: read-only key for VCL, read-write (non-admin) for Compute.
- `force_destroy = false` + `lifecycle { prevent_destroy = true }` on the content KV store.
- Commit `.terraform.lock.hcl`. Document a remote encrypted backend (commented example).
- DNS outputs: explicit records (apex/www + `app.`), no wildcard CNAME. Remove VCL backends for TS/Go unless their
  service hostnames are declared variables (default empty → backend not created).
- Logging: VCL service gets an optional log endpoint; never log full client IP — truncate (IPv4 /24, IPv6 /48) and
  drop query strings. Compute writes structured JSON to named endpoint `edge-cms-app-logs`.
- `page_ttl` config default 86400; add `site_url = "https://${var.domain}"`, `page_size = "10"`.
- outputs `next_steps`: no `echo $TOKEN |` patterns; use `read -rs` + `--stdin`.

## 10. Templates (shared/) — variable contract

Existing variable names stay unless listed. Backends must provide, for **every** layout render:

| Var | Type | Notes |
|---|---|---|
| `site_url` | string | §6 |
| `page_title` | string | always set |
| `meta_description` | string | always set (post: excerpt; home: site default "A CMS running entirely on Fastly's edge platform"; tag: `Posts tagged "<tag>"`; error/admin: short text) |
| `canonical_url` | string | **absolute** (`site_url` + path) |
| `og_type` | string | `article` for posts, else `website` |
| `og_image` | string | absolute URL or empty |
| `noindex` | bool | true for admin, login, error pages |
| `asset_version` | string | §7 |
| `is_admin` | bool | as today |

Remove `og_url` (template uses `canonical_url`), `og_title` (uses `page_title`), `og_description` (uses `meta_description`).
Remove `pop_city` / `pop_code` from server renders (cached HTML must not embed per-POP data); `/assets/site.js`
fetches `/api/edge-info` client-side.

Post page additionally:
- `json_ld` — server-built JSON string (`BlogPosting`: headline, description, datePublished, dateModified, author,
  image (absolute), mainEntityOfPage (canonical), publisher {name: "edge/cms"}). Serialised with a real JSON encoder,
  then `</` replaced with `<\/`. Template: `<script type="application/ld+json">{{{json_ld}}}</script>`
  (JSON-LD is data, allowed by CSP since it isn't executed).
- `share_url_encoded` — percent-encoded canonical URL; `share_title_encoded` — percent-encoded title.

Home / tag:
- `pagination`: `{ "page": n, "total_pages": n, "prev_url": string|null, "next_url": string|null }` (`?page=N`, 1-based,
  out-of-range → 404).

Sidebar (public `_sidebar.hbs` and `admin-sidebar.hbs`) items:
- category: `type, label, slug, children (array), children_csv (children joined with ",")`
- link: `type, label, url, icon`
- Each item also gets boolean `is_category` / `is_link` (handlebars-friendly).

Admin editor: `post` object `{slug,title,content,excerpt,status,tags_str,featured_image}`, `is_new` bool, `error` string|null.
Login: `error` string|null. Dashboard: `purge_failed` bool.

Assets served by every backend (embedded at build):
| Path | Source |
|---|---|
| `/assets/style.css` | `shared/css/style.css` (reader + shared) |
| `/assets/admin.css` | `shared/css/admin.css` (admin + login) |
| `/assets/site.js` | `shared/js/site.js` (public: edge-info widget, copy-link, share) |
| `/assets/admin.js` | `shared/js/admin.js` |
| `/assets/fonts/fraunces.woff2` | `shared/fonts/fraunces.woff2` (`font/woff2`) |
| `/assets/fonts/dm-sans.woff2` | `shared/fonts/dm-sans.woff2` |
| `/assets/fonts/jetbrains-mono.woff2` | `shared/fonts/jetbrains-mono.woff2` |
Unknown asset → 404. Query string ignored.

## 11. Markdown sanitisation (allowlist, same policy in all backends)

Pipeline: markdown → HTML (GFM: tables, strikethrough, task lists) → **sanitize** → existing image rewrite (srcset).
- Allowed tags: `p h1 h2 h3 h4 h5 h6 a img ul ol li blockquote pre code em strong del s table thead tbody tr th td hr br sup sub details summary figure figcaption span div input iframe`.
- Allowed attrs: `a[href title]` (+ add `rel="noopener noreferrer"` to absolute http(s) links), `img[src alt title width height]`,
  `code[class] pre[class] span[class] div[class]` (class only `language-[a-z0-9+-]+`), `th[align] td[align]`,
  `input[type=checkbox disabled checked]` (force `disabled`), `iframe[src width height title allow allowfullscreen]`
  only when src is `https://` on `www.youtube-nocookie.com`, `www.youtube.com`, or `player.vimeo.com` (else drop element).
- URL schemes: `http`, `https`, `mailto`, relative. Everything else (javascript:, data:, vbscript:) stripped.
- Libraries: Rust `ammonia`, TS a pure-JS sanitizer that bundles under StarlingMonkey (e.g. `xss` or `sanitize-html`
  if it webpack-bundles without Node built-ins), Go `github.com/microcosm-cc/bluemonday`. Drop goldmark `WithUnsafe`?
  No — keep raw HTML parsing so the sanitizer can allow the safe subset.
- Each backend gets unit tests for: `<script>` removed, `onerror=` removed, `javascript:` href removed, YouTube iframe kept,
  other iframe removed, table kept, `language-rust` class kept.

## 12. Logging & privacy

- Structured JSON lines `{"ts","level","msg","method","path","status","duration_ms","client_ip"}` to log endpoint
  `edge-cms-app-logs` (fall back to stderr if unavailable). `client_ip` truncated (IPv4 /24 → `1.2.3.0`, IPv6 /48).
- Never log passwords, tokens, cookies, request bodies, or full upstream error bodies (max 200 bytes).
- Fonts are self-hosted (no Google Fonts requests).

## 13. Robots / feed / sitemap

- robots.txt: `User-agent: *\nDisallow: /admin\nDisallow: /api/\nSitemap: <site_url>/sitemap.xml\n`
- sitemap: absolute `<loc>`, `<lastmod>` = updated_at (fallback created_at), include home + tag pages + posts.
- RSS: absolute links, `pubDate` RFC-822 (`Mon, 02 Jan 2006 15:04:05 +0000`), `<lastBuildDate>`, `<atom:link rel="self">`,
  XML-escape all text. Layout gets `<link rel="alternate" type="application/rss+xml" href="/feed.xml">`.

## 14. Version header

Keep `X-Edge-CMS-Compute-Version` (demo widget) but it must actually be set (Go currently sets it after WriteHeader).
