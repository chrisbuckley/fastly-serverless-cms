# Edge CMS: A CMS Running Entirely on Fastly

A fully-functional content management system that runs entirely at the edge -- no origin servers, no databases, no traditional infrastructure. Every request is handled by Fastly Compute, with content stored in KV Store and images in Object Store.

Edge CMS demonstrates how Fastly's product suite composes into a real, deployable application. It ships with a reader-facing blog, an admin interface with a split-pane markdown editor, image uploads, RSS feeds, sitemaps, and cache management -- all running on Fastly's global edge network.

## Fastly Products Used

| Product | Purpose |
|---------|---------|
| **Compute** | Application runtime -- all logic runs at the edge |
| **KV Store** | Post content, post index, sidebar configuration |
| **Object Store** | Image uploads (binary blobs) |
| **Secret Store** | Admin password (bcrypt hash), HMAC signing key |
| **Image Optimizer** | On-the-fly image transformation via query params |
| **CDN Caching** | Cache all reader-facing responses at the edge |
| **Surrogate Keys + Purge API** | Targeted cache invalidation on content changes |
| **Rate Limiting** | Brute-force protection on admin login |
| **Geolocation** | Localized details for readers (nearest POP, footer badge) |
| **Real-time Log Streaming** | Request logging to external drain |

## Quick Start

### Prerequisites

- Fastly account with Compute enabled
- Fastly CLI installed and authenticated (`fastly profile create`)
- Rust toolchain with `wasm32-wasip1` target (`rustup target add wasm32-wasip1`)

### 1. Create Stores

```bash
fastly kv-store create --name=edge-cms-content
fastly kv-store create --name=edge-cms-images
fastly secret-store create --name=edge-cms-secrets
```

### 2. Set Secrets

```bash
# Generate bcrypt hash of your admin password
BCRYPT_HASH=$(python3 -c "import bcrypt; print(bcrypt.hashpw(b'your-password', bcrypt.gensalt()).decode())")

# Generate HMAC signing key
HMAC_KEY=$(openssl rand -base64 32)

# Store both
fastly secret-store-entry create --store-id=<secrets-store-id> --name=admin_password --secret="$BCRYPT_HASH"
fastly secret-store-entry create --store-id=<secrets-store-id> --name=hmac_key --secret="$HMAC_KEY"
```

### 3. Configure

Copy `.env.example` to `.env` and fill in your store IDs and API token. Update `fastly.toml` with your store IDs for the `[setup]` section.

### 4. Build and Deploy

```bash
cd edge-cms/rust/
fastly compute build
fastly compute deploy
```

### 5. First Run

1. Visit `https://<your-domain>/admin/login`
2. Enter the admin password you set in step 2
3. Create your first post from the admin dashboard

## Local Development

Run locally with Viceroy (Fastly's local Compute runtime):

```bash
cd edge-cms/rust/
fastly compute serve
```

This starts a local server at `http://127.0.0.1:7676` with test data pre-loaded. The `fastly.toml` file configures local KV and Secret stores using fixture files in `tests/`.

### Test Data

- `tests/kv-content.json` -- Sample posts and sidebar config
- `tests/kv-images.json` -- Empty image store placeholder

The local secret store includes test credentials for development use.  <!-- pragma: allowlist secret -->

### Integration Tests

With Viceroy running, execute the integration test script:

```bash
./tests/integration.sh
```

This exercises all reader routes, cache headers, JSON-LD structured data, and admin auth redirects.

## Architecture Overview

### Data Model

- **Posts** stored in KV Store at key `post:<slug>` as JSON
- **Post Index** at key `_index` -- contains metadata for all posts, sorted by date. Enables listing pages without reading individual posts.
- **Sidebar Config** at key `_sidebar` -- categories (with child post slugs) and external links
- **Images** in Object Store at key `images/<slug>/<filename>`
- **Secrets** in Secret Store -- `admin_password` (bcrypt hash) and `hmac_key`

### Routing

Reader routes (`/`, `/post/<slug>`, `/tag/<tag>`, `/feed.xml`, etc.) are CDN-cached with surrogate keys for targeted purging. Admin routes (`/admin/*`) are never cached -- every request hits Compute.

### Caching Strategy

Reader responses set:
- `Surrogate-Control: max-age=3600` (Fastly edge cache holds for 1 hour)
- `Cache-Control: max-age=60, public` (browser holds for 1 minute)
- `Surrogate-Key: <relevant keys>` (enables targeted purging)

On any admin write (create/update/delete), the app purges the relevant surrogate keys so readers get fresh content on the next request.

### Authentication

Password-only admin login. The Compute app validates the password against a bcrypt hash in Secret Store, then issues an HMAC-signed session cookie with an expiry timestamp. Every admin request validates the cookie signature and expiry.

## Directory Structure

```
edge-cms/
├── DESIGN.md              # Full design document
├── README.md              # This file
├── shared/                # Shared across all language implementations
│   ├── templates/         # Handlebars templates (.hbs)
│   ├── css/               # Stylesheet
│   └── js/                # Admin JavaScript
├── rust/                  # Rust/Compute implementation (complete)
│   ├── src/
│   ├── tests/
│   ├── Cargo.toml
│   └── fastly.toml
├── typescript/            # TypeScript implementation (planned)
├── go/                    # Go implementation (planned)
└── mockups/               # Static HTML design mockups
```

Templates, CSS, and JS are shared -- each language implementation reads from `shared/` at build time and embeds everything into the Compute binary. No runtime file I/O.

## Available Implementations

| Language | Status | Notes |
|----------|--------|-------|
| **Rust** | Complete | Primary implementation. All features working. |
| TypeScript | Planned | Will use `@fastly/js-compute` SDK |
| Go | Planned | Will use `compute-sdk-go` |

All implementations render the same shared templates and produce identical behavior. The differences are in how each language handles routing, KV Store access, and response construction.

## Built with Fastly Agent Skills

This project was built using Claude Code with Fastly-specific agent skills.

| Skill | Purpose | How It Was Used |
|-------|---------|-----------------|
| `fastly` | CDN platform configuration | Product enablement, cache strategy design, Surrogate-Key patterns, Purge API integration, geolocation |
| `fastly-cli` | CLI command execution | Store creation (KV, Object, Secret), secret management, deployment, fastly.toml configuration |
| `viceroy` | Local Compute development | Local dev server, fastly.toml store definitions, integration testing |

### Skills Not Used

| Skill | Why Not |
|-------|---------|
| `falco` | VCL linting/testing -- this project uses Compute, not VCL |
