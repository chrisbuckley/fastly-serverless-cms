# Edge CMS — Design Document (In Progress)

An open-source CMS running entirely on Fastly's edge platform. Implemented in Rust, TypeScript, and Go with shared Handlebars templates. Demonstrates how Fastly's product suite composes into a real, deployable application.

---

## Fastly Products Used

| Product | Purpose |
|---------|---------|
| **Compute** | Application runtime — all logic runs at the edge |
| **KV Store** | Post content, post index, sidebar config |
| **Object Store** | Image uploads (binary blobs) |
| **Secret Store** | Admin password (bcrypt hash), HMAC signing key |
| **Image Optimizer** | On-the-fly image transformation via query params |
| **CDN Caching** | Cache all reader-facing responses at the edge |
| **Surrogate Keys + Purge API** | Targeted cache invalidation on content changes |
| **Rate Limiting** | Brute-force protection on admin login |
| **Geolocation** | Localized details for readers (date format, nearest POP) |
| **Real-time Log Streaming** | Request logging to external drain |

---

## Directory Structure

```
edge-cms/                  ← One self-contained example
├── shared/                ← Handlebars templates, CSS, admin JS
│   ├── templates/
│   │   ├── layout.hbs         ← Base layout (header, sidebar, footer)
│   │   ├── home.hbs           ← Post listing page
│   │   ├── post.hbs           ← Single post page
│   │   ├── tag.hbs            ← Posts filtered by tag
│   │   ├── login.hbs          ← Admin login form
│   │   ├── admin-dashboard.hbs
│   │   ├── admin-editor.hbs   ← Split-pane markdown editor
│   │   └── admin-sidebar.hbs  ← Sidebar management
│   ├── css/
│   ├── js/                    ← Admin JS (editor, sidebar management)
│   └── static/                ← Fonts, icons
├── rust/
├── typescript/
└── go/
```

Each language directory contains a complete Fastly Compute application that reads templates from `shared/` at build time.

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
      "tags": ["fastly", "edge"],
      "featured_image": "/images/my-first-post/hero.jpg"
    }
  ]
}
```

Sorted by `created_at` descending. Contains enough metadata to render listing pages without reading individual posts. Updated atomically on every post CRUD operation.

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
      "type": "category",
      "label": "Advanced",
      "slug": "advanced",
      "children": ["edge-routing"]
    },
    {
      "type": "link",
      "label": "GitHub",
      "url": "https://github.com/...",
      "icon": "github"
    },
    {
      "type": "link",
      "label": "Fastly Docs",
      "url": "https://docs.fastly.com"
    }
  ]
}
```

Categories contain post slugs as children. Links are arbitrary URLs. Array order = display order.

### Images (Object Store, key: `images/<slug>/<filename>`)

Binary image data. Served through `/images/*` route with Fastly Image Optimizer query params (e.g., `?width=800&format=webp`).

### Secrets (Secret Store)

- `admin_password` — bcrypt hash of the admin password
- `hmac_key` — key for signing session cookies

---

## URL Routing

### Public Routes (reader-facing, cached)

| Route | Behavior | Surrogate Keys |
|-------|----------|----------------|
| `GET /` | Paginated post listing from index | `post-index sidebar` |
| `GET /post/<slug>` | Read post from KV, render markdown → HTML via template | `post-<slug> sidebar` |
| `GET /tag/<tag>` | Filter index by tag, render listing | `post-index sidebar` |
| `GET /images/<slug>/<file>` | Read from Object Store, serve with IO headers | `image-<slug>` |
| `GET /assets/*` | Static CSS/JS/fonts | `assets` |
| `GET /robots.txt` | Generated from config | `config` |
| `GET /sitemap.xml` | Generated from post index | `post-index` |
| `GET /feed.xml` | RSS/Atom feed from post index | `post-index` |

### Admin Routes (behind auth, never cached)

| Route | Behavior |
|-------|----------|
| `GET /admin/login` | Login form (password only) |
| `POST /admin/login` | Validate password against Secret Store, set signed HMAC cookie |
| `GET /admin` | Dashboard — post list with edit/delete, sidebar editor link |
| `GET /admin/posts/new` | New post form (split-pane markdown editor) |
| `POST /admin/posts` | Create post → write to KV, update index, purge `post-index` |
| `GET /admin/posts/<slug>/edit` | Edit post form, pre-populated |
| `PUT /admin/posts/<slug>` | Update post → write to KV, update index, purge `post-<slug> post-index` |
| `DELETE /admin/posts/<slug>` | Delete post → remove from KV + index, purge `post-<slug> post-index` |
| `POST /admin/images` | Upload image to Object Store |
| `GET /admin/sidebar` | Sidebar editor |
| `PUT /admin/sidebar` | Update sidebar config in KV, purge `sidebar` |
| `POST /admin/logout` | Clear session cookie |

---

## Authentication

1. Admin navigates to `/admin/login`, enters password (no username)
2. Compute app reads bcrypt hash from Secret Store, validates
3. On success: generate HMAC-signed token containing expiry timestamp, set as `HttpOnly; Secure; SameSite=Strict` cookie
4. HMAC signing key lives in Secret Store
5. Every `/admin/*` request (except login) validates the cookie signature and expiry
6. Invalid/missing/expired → redirect to `/admin/login`

### Rate Limiting

Admin login endpoint: 5 attempts per minute per client IP. Uses Fastly's edge rate limiting product. Readers are unaffected.

---

## Cache Strategy

### Reader Responses

```
Surrogate-Control: max-age=3600
Cache-Control: max-age=60, public
Surrogate-Key: <relevant keys>
```

- `Surrogate-Control` — tells Fastly's edge cache to hold the response for 1 hour
- `Cache-Control` — tells the browser to hold for 1 minute (short so purges propagate quickly)
- Surrogate keys enable targeted purging without flushing the entire cache

### Admin Responses

```
Cache-Control: private, no-store
```

Never cached. Every admin request hits Compute.

### Purge Flow

On any admin write operation (create/update/delete post, update sidebar):

1. Write to KV Store
2. Call Fastly Purge API with relevant surrogate keys
3. Return response to admin

Purge happens synchronously before the admin gets a response, so the next reader request gets fresh content.

---

## Markdown Rendering

Rendered on every Compute invocation (cache miss). Markdown → HTML conversion happens at the edge using language-native libraries:

- **Rust:** `pulldown-cmark`
- **TypeScript:** `marked` or `markdown-it`
- **Go:** `goldmark`

Since all reader responses are CDN-cached, the markdown parsing only runs on cache misses. The Compute cost per reader is effectively zero for repeat visits.

---

## Image Handling

1. Admin uploads image via the editor UI
2. Compute app writes binary data to Object Store at key `images/<post-slug>/<filename>`
3. In markdown, author references: `![Alt text](/images/my-post/hero.jpg?width=800)`
4. Reader requests to `/images/*` → Compute reads from Object Store and serves with appropriate `Content-Type`
5. Fastly Image Optimizer processes the image based on query params (`?width=`, `?height=`, `?format=`, `?quality=`)
6. Response is CDN-cached with surrogate key `image-<slug>`

---

## Geolocation

Reader pages use Fastly's `Fastly-Geo-*` request headers to add localized touches:

- Date formatting based on detected region
- Footer note: "Served from Fastly's [POP city] edge"
- Demonstrates edge-native capability with minimal code

---

## Logging

Real-time log streaming configured to an external endpoint. Demonstrates Fastly's observability story. Configuration-level — minimal application code, primarily `fastly.toml` and service config.

---

## Template System

Shared Handlebars templates in `edge-cms/shared/templates/`. All three language implementations render the same template files using language-native Handlebars libraries:

- **Rust:** `handlebars` crate
- **TypeScript:** `handlebars` npm package
- **Go:** `raymond` package

Templates are compiled into each Compute binary at build time. A reader comparing the Rust and Go implementations sees identical template files — the differences are in how each language handles routing, KV Store access, and response construction.

---

## Admin UI

### Dashboard

Post list table with title, status, date, and edit/delete actions. Link to sidebar editor. Link to create new post.

### Post Editor

Split-pane markdown editor:
- **Left pane:** Raw markdown textarea
- **Right pane:** Live rendered preview (client-side JS using the same markdown library)
- **Above editor:** Metadata fields — title, slug (auto-generated from title, editable), tags, status (draft/published), excerpt, featured image upload
- Image upload button inserts markdown image reference at cursor position

### Sidebar Editor

List-based management (MVP — drag-and-drop as future enhancement):
- Add/remove categories and links
- Reorder with up/down buttons
- Assign posts to categories via dropdown
- Save serializes to the sidebar config JSON and writes to KV Store

---

## Social & SEO

- **Open Graph tags** on every post page (title, description, image, URL)
- **Twitter Card meta tags**
- **Canonical URLs**
- **RSS/Atom feed** at `/feed.xml`
- **Sitemap** at `/sitemap.xml`
- **robots.txt** allowing all crawlers
- **Structured data** (JSON-LD Article schema) on post pages

---

## Visual Design

Mockup files live in `edge-cms/mockups/`. These are static HTML files that demonstrate the design system without any backend — open them directly in a browser.

| Mockup | File |
|--------|------|
| Reader homepage | `mockups/reader.html` |
| Reader single post | `mockups/reader-post.html` |
| Admin dashboard | `mockups/admin-dashboard.html` |
| Admin post editor | `mockups/admin-editor.html` |

### Fonts

Three-font stack, all variable/web fonts:

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

- **"Served from [POP]" footer**: Reader pages show the Fastly POP that served the response, with a green pulse dot indicating edge delivery. Demonstrates geolocation without being intrusive.
- **Edge performance badge**: Sidebar widget showing response time and cache status (`HIT`/`MISS`). Makes the Fastly caching story visible.
- **Tag pills**: Rounded badges using category-specific colors derived from the palette. Tags get terracotta; status badges (draft/published) get green/gold.

---

## Build Process

Each language implementation embeds templates, CSS, and JS from `shared/` at compile time. No runtime file I/O — everything is baked into the Compute binary.

### Rust

`build.rs` handles the shared asset pipeline:

1. `build.rs` copies `../shared/templates/`, `../shared/css/`, and `../shared/js/` into the build output directory
2. Templates embedded into the binary via `include_str!()` macros
3. CSS and JS embedded as static byte arrays (`include_bytes!()`)
4. Handlebars templates pre-compiled at startup using `lazy_static` (one-time cost on first request, then reused for the lifetime of the Compute instance)

```bash
cargo build --target wasm32-wasi    # via `fastly compute build`
```

### TypeScript

Webpack or esbuild bundles shared assets as string imports:

1. Bundler plugin (e.g., `raw-loader` for Webpack, text loader for esbuild) imports `.hbs`, `.css`, and `.js` files as raw strings
2. Templates registered with the `handlebars` npm package at module initialization
3. CSS and JS served as static responses from embedded strings
4. Uses `@fastly/js-compute` SDK for the Compute runtime

```bash
npm run build           # bundle step
fastly compute build    # package WASM
```

### Go

Go's `embed` package handles everything natively:

1. `//go:embed shared/templates/*` directive embeds the entire template directory into the binary
2. `embed.FS` provides filesystem-like access to templates at runtime
3. `raymond` (Handlebars for Go) compiles templates from the embedded FS at `init()`
4. CSS and JS similarly embedded via `//go:embed` directives

```bash
GOARCH=wasm GOOS=wasip1 go build    # via `fastly compute build`
```

### Shared Assets

- **CSS**: Single `style.css` in `shared/css/`. Uses CSS custom properties (variables) for theming — no preprocessor needed.
- **JS**: Minimal vanilla JavaScript in `shared/js/` for admin functionality — markdown preview, tag input widget, sidebar reordering. No framework dependency.
- **Templates**: Handlebars `.hbs` files reference CSS and JS via paths (`/assets/style.css`, `/assets/admin.js`) that each Compute app serves from its embedded assets.

---

## Deployment & Initial Setup

Step-by-step for getting a fresh Edge CMS running. Assumes one of the three language implementations; the process is identical except for the build toolchain.

### Prerequisites

- Fastly account with Compute enabled
- Fastly CLI installed and authenticated (`fastly profile create`)
- Language toolchain: Rust (with `wasm32-wasi` target), Node.js, or Go

### 1. Create Stores

```bash
fastly kv-store create --name=edge-cms-content
# → Returns store ID — save this

fastly kv-store create --name=edge-cms-images
# → Returns store ID — save this

fastly secret-store create --name=edge-cms-secrets
# → Returns store ID — save this
```

### 2. Set Initial Secrets

Generate a bcrypt hash of your chosen admin password and a random HMAC signing key:

```bash
# Generate bcrypt hash (requires htpasswd, python, or similar)
BCRYPT_HASH=$(python3 -c "import bcrypt; print(bcrypt.hashpw(b'your-password', bcrypt.gensalt()).decode())")

# Generate HMAC key (32 bytes, base64-encoded)
HMAC_KEY=$(openssl rand -base64 32)

# Store both in Secret Store
fastly secret-store-entry create --store-id=<secrets-store-id> --name=admin_password --secret="$BCRYPT_HASH"
fastly secret-store-entry create --store-id=<secrets-store-id> --name=hmac_key --secret="$HMAC_KEY"
```

### 3. Configure Environment

Per repo conventions, store IDs and tokens go in `.env` (never committed). Each language directory includes a `.env.example`:

```
FASTLY_API_TOKEN=your-api-token-here
FASTLY_SERVICE_ID=your-service-id-here
KV_STORE_ID_CONTENT=your-kv-store-id-here
KV_STORE_ID_IMAGES=your-image-store-id-here
SECRET_STORE_ID=your-secret-store-id-here
```

Copy to `.env` and fill in real values. The `.env` file is in `.gitignore`.

### 4. Configure `fastly.toml`

Link store IDs to the Compute service. The committed `fastly.toml` uses placeholder values — replace with your store IDs or source them from `.env` in your deploy script.

### 5. Seed Initial Data (Optional)

A helper script writes the minimum KV entries for a functional site:

```bash
# Write empty post index
fastly kv-store-entry create --store-id=<content-store-id> --key=_index --value='{"posts":[]}'

# Write default sidebar config
fastly kv-store-entry create --store-id=<content-store-id> --key=_sidebar --value='{"items":[]}'
```

Without seeding, the site renders with empty content and the admin can create posts immediately.

### 6. Build & Deploy

```bash
cd edge-cms/<language>/
fastly compute build
fastly compute deploy
```

### 7. First Run

1. Visit `https://<your-domain>/admin/login`
2. Enter the admin password set in step 2
3. Create your first post from the admin dashboard

---

## Error Handling

### Reader Errors

| Scenario | Status | Behavior |
|----------|--------|----------|
| Post not found | `404` | Styled 404 page using the blog template (same header, sidebar, footer). Friendly message with a link back to the homepage. |
| KV Store read failure | `503` | Clean error page with a "temporarily unavailable" message. Full error details logged to real-time log streaming. Never exposed to the reader. |
| Template render failure | `500` | Minimal error page (not dependent on the broken template). Error context logged. |

Reader error pages look like they belong to the site — same fonts, colors, and navigation. They never expose stack traces, store IDs, or internal paths.

### Admin Errors

| Scenario | Status | Behavior |
|----------|--------|----------|
| Invalid/expired session | `302` | Redirect to `/admin/login?error=expired` or `?error=invalid`. Login page renders the appropriate message. |
| Form validation failure | `422` | Re-render the form with validation errors inline next to the relevant fields. All form data preserved — the user never loses work. |
| KV Store write failure | `500` | Error banner at the top of the admin page. Form state preserved in the response body so the user can retry without re-entering data. |
| Image upload failure | `422` | Error message with the specific reason (file too large, invalid format, etc.). Post editor state preserved. |
| Login rate limit exceeded | `429` | "Too many attempts, try again in X seconds" message on the login page. |

Admin error messages include the error type (e.g., "Store write failed") but never internal details like store IDs, key paths, or stack traces.

### Cross-Cutting Patterns

- All error responses use appropriate HTTP status codes — no `200 OK` with an error body.
- All errors logged to the real-time log streaming endpoint. Log entries include: ISO 8601 timestamp, error type/category, request path, and client IP (hashed for privacy).
- Every error page includes navigation back to a working page (homepage for readers, dashboard for admins).
- Error pages are self-contained — they don't depend on KV Store reads or template partials that might themselves be failing.

---

## Testing Strategy

### Unit Tests (Per Language)

Each language implementation includes unit tests covering core logic in isolation:

- **Markdown rendering**: Verify HTML output for edge cases — nested formatting, code blocks with language hints, image references with IO query params, empty input, malformed markdown
- **Authentication**: HMAC cookie signing/verification round-trip, expiry validation (fresh cookie, expired cookie, tampered cookie), bcrypt password checking against known hashes
- **Data model**: JSON serialization/deserialization of posts, post index, and sidebar config. Verify handling of missing optional fields, empty arrays, malformed JSON
- **URL routing**: Path matching returns the correct handler — verify all public and admin routes, trailing slash normalization, unknown paths return 404 handler
- **Template rendering**: Spot-check that rendered HTML contains expected elements for given input data (post title in `<h1>`, tags as list items, sidebar categories)

### Integration Tests (Viceroy)

Full request/response cycle tests running against `fastly compute serve`:

- **Reader routes**: GET every public route, verify status codes and response body contains expected content
- **Admin CRUD flow**: Create post → verify it appears in listing → edit title → verify change → delete → verify removal from listing
- **Auth flow**: Login with correct password → receive cookie → access admin with cookie → wait for expiry → verify redirect to login
- **Cache headers**: Reader responses include `Surrogate-Control`, `Cache-Control: max-age=60, public`, and correct `Surrogate-Key` values
- **Admin cache absence**: All admin responses include `Cache-Control: private, no-store`
- **Image round-trip**: Upload image via admin → retrieve via reader route → verify Content-Type and binary content
- **Rate limiting**: Hit the login endpoint beyond threshold → verify `429` response

### Cross-Language Parity Tests

An HTTP-level test suite that runs identical requests against all three implementations and compares behavior:

- **Test runner**: Shell scripts using `curl` or `httpie`, or a lightweight test harness. Runs each implementation via Viceroy, executes the same request sequence, and diffs the results.
- **What's compared**: HTTP status codes, cache-related headers, redirect behavior, and HTML structure (same DOM elements and hierarchy — not byte-identical output, since whitespace and attribute order may differ).
- **Shared test fixtures**: `edge-cms/shared/test-fixtures/` contains sample post JSON, index JSON, sidebar config JSON, and expected response fragments. Used by both unit tests (deserialization) and integration tests (seeded into local KV Store via Viceroy config).
- **CI execution**: Build all three implementations → start each with Viceroy on different ports → run the parity suite against each → compare results and fail on divergence.

### Test Data

Fixtures directory at `edge-cms/shared/test-fixtures/` containing:

- Sample posts (published, draft, with images, with various tag combinations)
- Post index with multiple entries
- Sidebar config with categories, links, and nested children
- Edge cases: empty index, post with no tags, post with very long content

Fixtures are used by unit tests for deserialization testing and by integration tests for seeding the local KV Store via Viceroy's `fastly.toml` configuration.
