# Edge CMS — Design Document

An open-source CMS running entirely on Fastly's edge platform. **Rust is the primary implementation**; TypeScript and Go are implemented parity backends that are frozen: they receive security and data-integrity fixes only, while new features land in Rust. All three use the same shared Handlebars templates. Demonstrates how Fastly's product suite composes into a real, deployable application.

The behavior all three backends must share (status codes, headers, validation rules, template variables) is specified in [`docs/architecture/security-hardening-contract.md`](docs/architecture/security-hardening-contract.md). See [`README.md`](README.md) for installation, upgrade and operations.

---

## Fastly Products Used

| Product | Purpose |
|---------|---------|
| **Compute** | Application runtime — routing, templating, auth, validation |
| **VCL CDN Service** | Public layer in front of Compute: force-TLS, HSTS, caching, `/images/*` from Object Storage, origin auth header injection |
| **KV Store** | Posts, index, sidebar, revisions, trash, revoked sessions |
| **Config Store** | `site_url`, cache TTLs, `page_size` |
| **Object Storage** | Image uploads; read-only key for VCL, read-write-objects key for Compute |
| **Secret Store** | Admin password (bcrypt hash), HMAC key, origin auth token, Fastly API token, Object Storage read-write key |
| **Edge Rate Limiting** | Precise login limit in Compute; coarse flood limit in VCL |
| **Image Optimizer** | On-the-fly image transformation via query params |
| **Surrogate Keys + Purge API** | Targeted cache invalidation on content changes |
| **Real-time Log Streaming** | Structured request logs to an HTTPS drain (truncated client IPs) |

---

## Architecture

```
Browser → VCL CDN service (public domain) → Compute service (app.<domain>)
              │                                  │
              ├─ /images/* → Object Storage      ├─ KV Store (content)
              │   (SigV4, read-only key)         ├─ Config Store, Secret Store
              └─ everything else ───────────────►└─ Purge API, Object Storage (uploads)
```

- **VCL service** — redirects HTTP to HTTPS (`301`), sends `Strict-Transport-Security: max-age=31536000; includeSubDomains`, applies a coarse ERL limit to `POST /admin/login` (VCL's rate limiter cannot go below 10 rps averaged over 60 s, so it only stops floods), passes `/admin*`, caches everything else, serves `/images/*`, and sets `Edge-CMS-Origin-Auth` on every backend request to Compute (`vcl_miss` and `vcl_pass`) from the private dictionary `edge_cms_private`. It strips any client-supplied copy of that header and resets `Fastly-Client-IP` on the first hop.
- **Compute service** — the first thing it does is compare `Edge-CMS-Origin-Auth` (constant time) with Secret Store `origin_auth_token`; missing or wrong is `403` before any routing. After that `Fastly-Client-IP` is trusted as the client IP. Every response, including errors, carries the security headers below.
- **Why a header and not network isolation:** Compute services are publicly addressable at their own domain. A shared secret proves the request passed through the VCL layer, so `app.<domain>` cannot be used to skip the rate limit, force-TLS, caching rules or image hardening.
- **DNS** uses explicit records (apex and `app.`, plus Go/TS hosts if configured). No wildcard CNAME, so a dangling wildcard cannot route arbitrary subdomains to Fastly. The TLS certificate is a wildcard.

### Security Response Headers (Compute, every response)

```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; font-src 'self'; connect-src 'self'; frame-src https://www.youtube-nocookie.com https://www.youtube.com https://player.vimeo.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
X-Frame-Options: DENY
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
Cross-Origin-Opener-Policy: same-origin
```

`/admin/*` adds `X-Robots-Tag: noindex, nofollow`. The CSP means templates contain no inline `<script>`, `<style>`, `style=""` or `on*=` attributes. JSON-LD (`<script type="application/ld+json">`) is data and is allowed.

---

## Directory Structure

```
.
├── shared/                ← Handlebars templates, CSS, JS, fonts
│   ├── templates/
│   │   ├── layout.hbs         ← Base layout (header, sidebar, footer)
│   │   ├── _sidebar.hbs       ← Public sidebar partial
│   │   ├── home.hbs           ← Post listing page (paginated)
│   │   ├── post.hbs           ← Single post page
│   │   ├── tag.hbs            ← Posts filtered by tag (paginated)
│   │   ├── error.hbs          ← Error pages
│   │   ├── login.hbs          ← Admin login form
│   │   ├── admin-dashboard.hbs
│   │   ├── admin-editor.hbs   ← Split-pane markdown editor
│   │   └── admin-sidebar.hbs  ← Sidebar management
│   ├── css/                   ← style.css (reader), admin.css (admin + login)
│   ├── js/                    ← site.js (public), admin.js (editor, sidebar)
│   ├── fonts/                 ← Self-hosted woff2 + OFL licence
│   └── test-fixtures/
├── rust/                  ← Primary implementation
├── typescript/            ← Parity backend, security fixes only
├── go/                    ← Parity backend, security fixes only
├── terraform/             ← VCL service, Compute service, stores, keys
├── scripts/               ← KV backup/restore, integration runner, VCL lint
└── docs/architecture/     ← Security hardening contract
```

Each language directory is a complete Fastly Compute application that embeds `shared/` at build time.

---

## Data Model

### Post (KV Store, key: `post:<slug>`)

```json
{
  "slug": "my-first-post",
  "title": "My First Post",
  "content": "# Hello\n\nThis is markdown...",
  "excerpt": "A short summary for listing pages",
  "status": "published",
  "created_at": "2026-05-20T14:30:00Z",
  "updated_at": "2026-05-20T15:00:00Z",
  "tags": ["fastly", "edge"],
  "featured_image": "/images/my-first-post/hero.jpg",
  "author": "Chris"
}
```

### Post Index (KV Store, key: `_index`)

```json
{
  "posts": [
    {
      "slug": "my-first-post",
      "title": "My First Post",
      "excerpt": "A short summary...",
      "status": "published",
      "created_at": "2026-05-20T14:30:00Z",
      "updated_at": "2026-05-20T15:00:00Z",
      "tags": ["fastly", "edge"],
      "featured_image": "/images/my-first-post/hero.jpg"
    }
  ]
}
```

Sorted by `created_at` descending; contains enough metadata to render listing pages without reading individual posts. `updated_at` is optional (older entries lack it; sitemaps fall back to `created_at`). The index is derived data: `POST /admin/rebuild-index` rebuilds it from the `post:` keys.

### Other KV keys

| Key | Value | Purpose |
|-----|-------|---------|
| `_sidebar` | JSON | Sidebar config |
| `rev:<slug>:<unix_ts>` | previous post JSON | Written before each update (30-day TTL) |
| `trash:<slug>` | post JSON | Written before a delete — soft delete (30-day TTL) |
| `session-revoked:<nonce>` | expiry timestamp | Written on logout; TTL to the session's expiry |

### Sidebar Config (KV Store, key: `_sidebar`)

```json
{
  "items": [
    {
      "type": "category",
      "label": "Getting Started",
      "slug": "getting-started",
      "children": ["my-first-post", "setup-guide"]
    },
    {
      "type": "link",
      "label": "GitHub",
      "url": "https://example.com/repo",
      "icon": "github"
    }
  ]
}
```

Categories contain post slugs as children; links point at a URL. Array order is display order. Validation: at most 64 KiB and 50 items; labels 1–100 chars; link URLs must be `https://`, `http://` or a root-relative `/path` (not `//`) — anything else, e.g. `javascript:`, is rejected with `400`, and links failing the rule are also omitted at render time. Unknown fields are dropped.

### Images (Fastly Object Storage, key: `<slug>/<filename>`)

Binary image data in an Object Storage bucket (not KV). Compute writes it on upload; the VCL service serves it at `/images/<slug>/<filename>` and Image Optimizer handles query params (e.g., `?width=800&format=webp`).

### Configuration (Config Store `cache_config`)

| Key | Default if missing | Notes |
|-----|--------------------|-------|
| `site_url` | `https://` + `Host` | Absolute, no trailing slash. Used for canonical URLs and the CSRF `Origin` check |
| `page_ttl` | `86400` | Edge TTL for pages |
| `asset_ttl` | `31536000` | Edge TTL for `/assets/*` |
| `image_ttl` | `31536000` | Present in the store; the image edge TTL is read by VCL from the `edge_cms_config` dictionary |
| `page_size` | `10` | Posts per page on home and tag listings |

### Secrets (Secret Store `secrets`)

`admin_password` (bcrypt hash), `hmac_key`, `origin_auth_token`, `fastly_api_token` (purge scope), `purge_service_id`, `fos_access_key_id` and `fos_secret_key` (read-write-objects key), `fos_region`, `fos_bucket`.

### Edge dictionaries (VCL service)

`edge_cms_config` (`active_backend`, `image_ttl`), private `edge_cms_private` (`origin_auth_token`), private `edge_cms_fos_creds` (read-only Object Storage key for SigV4).

---

## URL Routing

### Public Routes (reader-facing, cached)

| Route | Behavior | Surrogate Keys |
|-------|----------|----------------|
| `GET /` | Post listing, `?page=N` (1-based; out of range is `404`) | `post-index sidebar` |
| `GET /post/<slug>` | Post from KV: markdown, sanitized, rendered through the template | `post-<slug> sidebar` |
| `GET /tag/<tag>` | Filtered listing, paginated | `tag-<tag> post-index sidebar` |
| `GET /images/<slug>/<file>` | **VCL only**, from Object Storage; Compute returns `404` | `images image-<slug>` |
| `GET /assets/*` | Embedded CSS, JS, fonts; query string ignored | `assets` |
| `GET /robots.txt` | `Disallow: /admin`, `Disallow: /api/`, sitemap link | `post-index` |
| `GET /sitemap.xml` | Absolute URLs, `lastmod`; home, tag pages, posts | `post-index` |
| `GET /feed.xml` | RSS with absolute links, RFC-822 dates | `post-index` |
| `GET /api/edge-info` | `{"pop": ...}` for the footer badge; `no-store` | — |

### Admin Routes (behind auth, never cached)

| Route | Behavior |
|-------|----------|
| `GET /admin/login` | Login form (password only) |
| `POST /admin/login` | Rate limit, CSRF check, verify password, set signed session cookie |
| `GET /admin` | Dashboard — post list, purge-failure banner, rebuild-index action |
| `GET /admin/posts/new` | New post form (split-pane markdown editor) |
| `POST /admin/posts` | Create (`409` if the slug exists) |
| `GET /admin/posts/<slug>/edit` | Edit form |
| `POST` or `PUT /admin/posts/<slug>` | Update (HTML forms POST; `PUT` is for API callers). Renaming to an existing slug is `409` |
| `DELETE /admin/posts/<slug>` | Soft delete |
| `POST /admin/images` | Upload an image |
| `GET /admin/sidebar` | Sidebar editor |
| `PUT /admin/sidebar` | Update sidebar JSON (there is no `POST`) |
| `POST /admin/rebuild-index` | Rebuild `_index` from `post:` keys, purge `post-index` |
| `POST /admin/logout` | Revoke the session and clear the cookie |

---

## Authentication, CSRF and Rate Limiting

1. Admin opens `/admin/login` and enters the password (no username; one shared password).
2. Compute checks the login rate limit, then the bcrypt hash from the Secret Store.
3. On success it issues a **v1 session token** `v1.<expires_unix>.<nonce>.<b64sig>` — nonce is 16 random bytes in hex, `sig` is HMAC-SHA256 over `v1.<expires>.<nonce>` with the Secret Store `hmac_key`, TTL 3600 s — set as `session=<token>; HttpOnly; Secure; SameSite=Strict; Path=/admin; Max-Age=3600`. Pre-v1 two-part tokens are rejected.
4. Every `/admin/*` request except login validates the signature, expiry and that no `session-revoked:<nonce>` key exists. Invalid, expired or revoked sessions redirect to `/admin/login?error=expired`.
5. **Logout** writes `session-revoked:<nonce>` to KV (with a TTL to expiry) and clears the cookie, so a copied token stops working.

**CSRF.** For every non-GET/HEAD request under `/admin` (including the login POST): if `Sec-Fetch-Site` is present it must be `same-origin` (`none` is allowed); otherwise `Origin` must equal `site_url`; otherwise reject with `403`.

**Rate limiting, two layers.**

- *Compute (precise):* Edge Rate Limiting `RateCounter` `login_attempts` plus `PenaltyBox` `login_penalty`, keyed by client IP. A `POST /admin/login` from an IP in the penalty box gets `429`; otherwise the counter increments, and more than 5 in the 60 s window puts the IP in the penalty box for 15 minutes. `429` carries `Retry-After: 900`. If an ERL host call itself errors, Compute logs a warning and allows the request (fail open) since the VCL layer still limits.
- *VCL (coarse):* a `ratelimit.check_rate()` with the lowest limit VCL allows (10 rps averaged over 60 s, 15-minute penalty box) on `POST /admin/login` only, counted on the first Fastly hop. It stops floods, not guessing.

**Known limitations:** one shared password and no MFA; KV-based revocation is eventually consistent across POPs.

---

## Input Validation

Server-side, identical in all backends:

| Field | Rule | Failure |
|-------|------|---------|
| slug | `^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$` | `400` |
| title | 1–200 chars after trim | `400` |
| excerpt | ≤ 500 chars | `400` |
| content | ≤ 512 KiB | `413` |
| tags | comma-separated, trimmed, lowercased, spaces to `-`, `^[a-z0-9][a-z0-9-]{0,49}$`, deduplicated, max 20 | invalid ones dropped |
| status | `published` or `draft` | `400` |
| form/JSON body | ≤ 1 MiB | `413` |
| upload body | ≤ 10 MiB | `413` |
| upload filename | `^[a-z0-9][a-z0-9_-]{0,63}\.(jpg\|jpeg\|png\|webp\|gif)$` | `400` |
| upload type | detected from magic bytes (JPEG, PNG, GIF, WEBP), must match the extension; the detected type is stored as the object's Content-Type; SVG and everything else rejected | `415` |

On update, an omitted field (or an empty title or content) keeps its existing value. HTML form posts re-render the editor with an error message; JSON callers get `{"error": "..."}`.

---

## Cache Strategy

### Reader Responses

```
Surrogate-Control: max-age=<page_ttl>, stale-while-revalidate=60, stale-if-error=86400
Cache-Control: max-age=<page_ttl>, public        (Compute)
Cache-Control: public, no-cache                  (what browsers see — rewritten by VCL for HTML)
Surrogate-Key: <relevant keys>
```

- `Surrogate-Control` holds the page at the edge for `page_ttl` (default one day). Long edge TTLs are safe because writes purge exactly the affected keys.
- `stale-if-error` lets the edge keep serving a page if Compute or KV is failing.
- The VCL service rewrites HTML browser caching to `public, no-cache`, so browsers always revalidate and purges are visible at once; edge TTL is unaffected.
- feed.xml, sitemap.xml, robots.txt use the same `Surrogate-Control` with `Cache-Control: public, max-age=300`.
- `/assets/*`: `Cache-Control: public, max-age=31536000, immutable`; template URLs carry `?v=<service version>` so a deploy busts them.
- Errors and all admin responses: `Cache-Control: private, no-store`, no `Surrogate-Control`.
- Image responses (VCL): `public, max-age=86400` for browsers, `image_ttl` at the edge (purged by `image-<slug>`); `Content-Type` forced from the extension; `X-Content-Type-Options: nosniff`; `Content-Security-Policy: default-src 'none'; sandbox`.

### Purge Flow

On any admin write, Compute: (1) writes the new `post:<slug>`, (2) updates `_index`, (3) deletes the old key on a rename, (4) calls the Fastly Purge API (`POST /service/<purge_service_id>/purge`, `Surrogate-Key: <keys>`, `Fastly-Soft-Purge: 1`), (5) responds. Keys: create or delete `post-index post-<slug> sidebar` plus each `tag-<t>`; update the same plus the old slug and tags; sidebar save `sidebar post-index`; upload `image-<slug>`.

The purge status is checked. On a non-2xx response Compute logs the status and the first 200 bytes of the body and the admin redirect gets `?purge=failed`, which shows a warning banner on the dashboard. Because KV is eventually consistent, a read in a POP that has not yet received the new value can re-cache old content after a purge; a second purge resolves it.

---

## Data Integrity

- Only "key not found" means empty. Any other KV error returns `500` (no-store); an index is never written from a failed read.
- Update order is write new post, update index, delete old key (rename only), purge.
- Index updates use generation-conditional inserts with retries where the SDK supports them.
- **Revisions:** before an update overwrites a post, the previous JSON goes to `rev:<slug>:<unix_ts>` (30-day TTL).
- **Soft delete:** delete copies the post to `trash:<slug>` (30-day TTL) before removing `post:<slug>`.
- **Rebuild:** `POST /admin/rebuild-index` regenerates `_index` from the `post:` keys.
- The KV store itself is protected from deletion in Terraform; `scripts/kv-backup.sh` and `scripts/kv-restore.sh` export and replay it.

---

## Markdown Rendering

Pipeline: markdown → HTML (GFM tables, strikethrough, task lists) → **allowlist sanitize** → image rewrite. Rendered on cache misses only. Libraries:

| Backend | Markdown | Sanitizer |
|---------|----------|-----------|
| Rust | `pulldown-cmark` | `ammonia` |
| TypeScript | `marked` | `xss` |
| Go | `goldmark` (raw HTML parsed so the sanitizer can keep the safe subset) | `bluemonday` |

Policy (identical across backends): tags `p h1–h6 a img ul ol li blockquote pre code em strong del s table thead tbody tr th td hr br sup sub details summary figure figcaption span div input iframe`; `a[href title]` with `rel="noopener noreferrer"` added to absolute http(s) links; `img[src alt title width height]`; `class` on `code pre span div` only when it matches `language-[a-z0-9+-]+`; `input` only as a disabled checkbox; `<iframe>` only when `src` is `https://` on `www.youtube-nocookie.com`, `www.youtube.com` or `player.vimeo.com`, otherwise the element is dropped. URL schemes allowed: `http`, `https`, `mailto`, relative. `<script>`, `on*` handlers and `javascript:`, `data:`, `vbscript:` URLs are removed.

---

## Image Handling

1. Admin uploads an image in the editor (`POST /admin/images`).
2. Compute validates it (see Input Validation: size, filename, magic bytes) and writes it to Object Storage at `<post-slug>/<filename>` using the read-write-objects key, then purges `image-<slug>`.
3. The author references it in markdown: `![Alt](/images/my-post/hero.jpg?width=800)`.
4. A reader request to `/images/*` never reaches Compute: the VCL service allows only `/images/<slug>/<file>.(jpg|jpeg|png|webp|gif)` (anything else is `404`), SigV4-signs the GET with the read-only key on cache misses, forces `Content-Type` from the extension and adds `nosniff` and a `default-src 'none'; sandbox` CSP.
5. Image Optimizer applies `?width=`, `?height=`, `?format=`, `?quality=`.
6. Responses are cached with surrogate keys `images image-<slug>`.

---

## Geolocation

The serving POP is shown in the footer badge. Cached HTML must not contain per-POP data, so the badge is filled in by `/assets/site.js`, which fetches `GET /api/edge-info` (`no-store`) after load.

---

## Logging

Compute writes structured JSON lines `{"ts","level","msg","method","path","status","duration_ms","client_ip"}` to the named endpoint `edge-cms-app-logs` (stderr if unavailable). `client_ip` is truncated (IPv4 /24, IPv6 /48). Passwords, tokens, cookies, request bodies and long upstream error bodies are never logged (bodies are cut at 200 bytes). The VCL service has an optional endpoint (`enable_vcl_logging`) that logs the truncated IP and URL path only, never the query string. Both are off unless `logging_endpoint_url` is set.

---

## Template System

Shared Handlebars templates in `shared/templates/`. All three implementations render the same files using language-native libraries:

- **Rust:** `handlebars` crate
- **TypeScript:** `handlebars` npm package
- **Go:** `raymond` package

Every layout render gets `site_url`, `page_title`, `meta_description`, `canonical_url` (absolute), `og_type`, `og_image`, `noindex`, `asset_version`, `is_admin`. Post pages also get `json_ld` (a `BlogPosting`, serialized with a real JSON encoder and `</` escaped) and percent-encoded share values; home and tag pages get a `pagination` object (`page`, `total_pages`, `prev_url`, `next_url`). The full variable contract is in the architecture contract, section 10.

---

## Admin UI

### Dashboard

Post list with title, status, date, and edit/delete actions; links to the sidebar editor and new post; a warning banner when the last purge failed; a rebuild-index action.

### Post Editor

Split-pane markdown editor:
- **Left pane:** Raw markdown textarea
- **Right pane:** Live preview, rendered client-side (inserted with DOM-safe sinks)
- **Above editor:** Title, slug (auto-generated from title, editable), tags, status (draft/published), excerpt, featured image upload
- Image upload inserts a markdown image reference at the cursor; client-side checks mirror, but never replace, the server-side validation.

### Sidebar Editor

List-based management:
- Add/remove categories and links
- Reorder with up/down buttons
- Assign posts to categories
- Save sends the sidebar JSON with `PUT /admin/sidebar`

---

## Social & SEO

- **Open Graph and Twitter Card tags** on every page (`canonical_url`, `page_title`, `meta_description`, `og_image`)
- **Canonical URLs**, always absolute (`site_url` + path)
- **RSS feed** at `/feed.xml`, advertised with a `<link rel="alternate">`
- **Sitemap** at `/sitemap.xml`
- **robots.txt** disallowing `/admin` and `/api/`
- **Structured data** (JSON-LD `BlogPosting`) on post pages
- `noindex` on admin, login and error pages

---

## Visual Design

Mockup files live in `mockups/`. These are static HTML files that demonstrate the design system without any backend — open them directly in a browser.

| Mockup | File |
|--------|------|
| Reader homepage | `mockups/reader.html` |
| Reader single post | `mockups/reader-post.html` |
| Admin dashboard | `mockups/admin-dashboard.html` |
| Admin post editor | `mockups/admin-editor.html` |

### Fonts

Three-font stack, self-hosted as latin woff2 under `/assets/fonts/` (OFL; no Google Fonts requests, which the CSP forbids):

- **Fraunces** (variable serif) — Display headings, post titles, blog name. Provides editorial character.
- **DM Sans** (geometric sans-serif) — Body text, UI labels, navigation. Clean and readable.
- **JetBrains Mono** — Code blocks and the markdown editor textarea.

### Color Palette

Warm editorial palette. Avoids the cold blue/gray SaaS aesthetic.

| Role | Color | Hex |
|------|-------|-----|
| Background (reader) | Cream | `#f5f0e8` |
| Background (admin) | Cool cream | `#f0ede8` |
| Primary text | Dark charcoal | `#2a2520` |
| Accent | Forest green | `#1b6b52` |
| Secondary | Terracotta | `#c4593a` |
| Tertiary | Muted gold | `#b8a47e` |

Green is used for links, active states, and the "Served from [POP]" indicator. Terracotta for tags, alerts, and destructive actions. Gold for borders, subtle highlights, and metadata.

### Reader Layout

Two-column layout — content on the left (~70%), sidebar on the right (~30%). Max-width `1180px`, centered. Collapses to a single column on viewports below `768px`, with the sidebar moving below the content.

The sidebar displays the category tree, external links, and an edge performance badge showing the serving POP and response time.

### Admin Layout

Same Fraunces + DM Sans pairing, but utilitarian. Background shifts slightly cooler (`#f0ede8`) to visually distinguish admin from reader. A persistent dark top bar (`#2a2520`) with white text carries the blog name, nav links, and logout button.

The post editor uses a split-pane layout: markdown textarea on the left, live HTML preview on the right. Metadata fields (title, slug, tags, status, excerpt, image) sit above the editor panes.

### Distinguishing Touches

- **"Served from [POP]" footer**: a green pulse dot and the Fastly POP code that served the response. Cached HTML never embeds per-POP data: `/assets/site.js` fills it in client-side from `GET /api/edge-info`.
- **Edge performance badge**: Sidebar widget showing response time and cache status (`HIT`/`MISS`/`PASS`, read from the `Server-Timing` header the VCL service adds). Makes the Fastly caching story visible.
- **Tag pills**: Rounded badges using category-specific colors derived from the palette. Tags get terracotta; status badges (draft/published) get green/gold.

---

## Build Process

Each implementation embeds templates, CSS, JS and fonts from `shared/` at compile time. No runtime file I/O — everything is baked into the Compute binary.

### Rust

No `build.rs`. Templates are embedded with `include_str!` and assets with `include_bytes!`, both with paths relative to `../shared/`. The Handlebars registry is built once per instance in a `OnceLock`.

```bash
cd rust && fastly compute build      # cargo build --target wasm32-wasip1
```

### TypeScript

Webpack bundles `.hbs`, `.css`, `.js` and font files as source/inline assets, then `js-compute-runtime` builds the WASM. Uses `@fastly/js-compute`, `handlebars`, `marked` and `xss`.

```bash
cd typescript && npm ci && fastly compute build    # prebuild runs webpack
```

### Go

`go/shared` is a copy of `../shared` (untracked; Go's `embed` cannot follow `..`). The Makefile refreshes it before every build and test.

```bash
cd go && make build      # copy-shared, then fastly compute build
```

### Shared Assets

- **CSS:** `style.css` (reader) and `admin.css` (admin and login). CSS custom properties, WCAG contrast tokens, focus styles, dark mode and reduced-motion support; no preprocessor.
- **JS:** `site.js` (edge-info badge, copy-link, share) and `admin.js` (editor, tag input, sidebar). Vanilla JS, CSP-safe (no inline handlers, DOM-safe sinks).
- **Templates** reference `/assets/style.css`, `/assets/admin.css`, `/assets/site.js`, `/assets/admin.js` and `/assets/fonts/*` with `?v={{asset_version}}`; each backend serves them from its embedded copy and returns `404` for anything else.

---

## Deployment & Initial Setup

The README is the authoritative runbook; this is the shape of it.

**Infrastructure is Terraform.** `terraform/` defines the VCL service (snippets, three dictionaries, compression, Image Optimizer), the Rust Compute service, the content KV store (delete-protected), the Config Store, an empty Secret Store, the generated origin auth token and the two Object Storage access keys. Go and TypeScript Compute services are managed outside Terraform; `go_backend_host` and `ts_backend_host` add a VCL backend and DNS record for them.

**Post-apply steps** (cannot be Terraform-managed; all secrets go in via `--stdin` or `read -rs`):

1. Write Secret Store entries: `origin_auth_token`, `admin_password`, `hmac_key`, `fastly_api_token`, `purge_service_id`, `fos_access_key_id`/`fos_secret_key` (read-write key), `fos_region`, `fos_bucket`.
2. Write the private dictionaries: `edge_cms_private` (`origin_auth_token`, same value) and `edge_cms_fos_creds` (read-only key).
3. Enable Edge Rate Limiting on the VCL service.
4. Create the Object Storage bucket once with a temporary admin key, then delete that key.
5. Seed `_index` and `_sidebar` in KV.
6. Create the DNS records (`terraform output dns_routing_records`) and the wildcard TLS subscription.

**Origin auth is the coupling to get right:** the token must be in both the Secret Store and `edge_cms_private`, and before the Compute package that enforces it goes live — otherwise every request is `403`. The README's upgrade runbook orders the steps (VCL first, secrets, then Compute) so an existing site never sees that window, and lists rollback by re-activating the previous service versions.

**Local development** needs no Fastly account: `fastly compute serve` with fixtures in `tests/`. Local requests must send `Edge-CMS-Origin-Auth: local-dev-origin-auth` (there is no VCL service to inject it), and the admin password fixture is `admin`.

---

## Error Handling

### Reader Errors

| Scenario | Status | Behavior |
|----------|--------|----------|
| Post not found, out-of-range page, unknown route | `404` | Styled error page using the site layout; `noindex` |
| KV read failure (anything other than not-found) | `500` | Generic error page; detail goes to the log only; `private, no-store` |
| Origin auth missing or wrong | `403` | Plain `Forbidden`; `private, no-store` |

Error pages are never cached and never expose stack traces, store IDs or internal paths.

### Admin Errors

| Scenario | Status | Behavior |
|----------|--------|----------|
| Missing, invalid, expired or revoked session | `302` | Redirect to `/admin/login?error=expired` |
| CSRF check fails | `403` | `Forbidden`, no cookie set |
| Validation failure | `400` / `409` / `413` | Editor re-rendered with the error and the user's input; JSON callers get `{"error": "..."}` |
| Upload: too large / wrong type | `413` / `415` | Error message; editor state preserved |
| KV failure | `500` | Generic error; nothing is partially indexed |
| Login rate limit | `429` | `Too many login attempts`, `Retry-After: 900` |
| Purge failure | redirect | `?purge=failed` banner on the dashboard |

### Cross-Cutting Patterns

- Appropriate HTTP status codes — no `200 OK` with an error body.
- Errors are logged as structured JSON with a truncated client IP.
- Error pages are self-contained and do not depend on KV reads.

---

## Testing Strategy

How to run everything is in the README. What is covered:

### Unit tests (per language)

Run with `cargo test` (rust), `make test` (go) and `npm test -- --coverage` (typescript; coverage threshold enforced in `jest.config.js`). They cover pure logic in isolation: markdown rendering and sanitizer policy (`<script>`, `onerror=`, `javascript:` hrefs, allowed and disallowed iframes, tables, `language-*` classes), session token creation and verification (tampering, expiry, revocation key), validation rules, CSRF decisions, sidebar schema, pagination, SEO and JSON-LD, routing, and model (de)serialization including missing optional fields.

### Integration tests (Viceroy)

One bash suite, `rust/tests/integration.sh`, encodes the hardening contract and runs against **all three backends** through `scripts/run-integration.sh <rust|typescript|go>` (also in CI). It sends the origin auth header on every request and covers: origin auth (missing, wrong, same-length-wrong tokens), security headers, CSRF cases, login and session lifecycle (legacy and tampered tokens, logout revocation), the admin CRUD flow, `409` conflicts, validation limits, sidebar validation, and `404` for `/images/*`. Viceroy may stub ERL, so the login limit's decision logic is unit tested and the live limit is checked in production smoke tests rather than asserted end to end.

### Parity

Parity is the same suite on three backends: a behavior difference fails the corresponding CI job. Fixtures under `shared/test-fixtures/` and each backend's `tests/` directory hold the sample post, index and sidebar data.

### Edge layer

VCL lives inline in `terraform/vcl.tf`. CI extracts each snippet with `scripts/extract-vcl.sh`, wraps it in its subroutine and lints it with `falco`. There is no local VCL integration test: after any VCL change run the production smoke tests from the README (HTTPS and HSTS, `app.<domain>` direct access `403`, login).
