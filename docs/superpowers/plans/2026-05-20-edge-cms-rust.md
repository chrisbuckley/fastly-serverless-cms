# Edge CMS — Rust Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a complete CMS running entirely on Fastly Compute in Rust — reader-facing blog + admin content management — with shared Handlebars templates and CSS.

**Architecture:** Single Fastly Compute application serving both reader (cached) and admin (uncached) routes. Content in KV Store (JSON + markdown), images in Object Store, auth credentials in Secret Store. Markdown rendered at edge on cache miss. Surrogate keys enable targeted purging on writes.

**Tech Stack:** Rust (wasm32-wasi), `fastly` crate (0.11.x), `handlebars`, `pulldown-cmark`, `serde`/`serde_json`, `bcrypt`, `hmac`/`sha2`, `base64`, `time`

**Fastly Skills Used:**
- `viceroy` — local dev server setup, `fastly.toml` backend overrides, store definitions for local testing
- `fastly-cli` — store creation, secret management, deployment, service configuration
- `fastly` — product configuration (rate limiting, image optimizer, cache purging, geolocation, logging)

**Reference:** Design doc at `edge-cms/DESIGN.md`, visual mockups in `edge-cms/mockups/`

---

## File Structure

### Shared assets (all implementations consume these)

```
edge-cms/shared/
├── css/
│   └── style.css              ← Full design system extracted from mockups
├── templates/
│   ├── layout.hbs             ← Base layout (header, sidebar, footer wrapper)
│   ├── _sidebar.hbs           ← Sidebar partial (categories, links, edge badge)
│   ├── home.hbs               ← Post listing page
│   ├── post.hbs               ← Single post page
│   ├── tag.hbs                ← Tag-filtered listing
│   ├── error.hbs              ← Error pages (404, 500, 503)
│   ├── login.hbs              ← Admin login form
│   ├── admin-dashboard.hbs    ← Post management table
│   ├── admin-editor.hbs       ← Split-pane markdown editor
│   └── admin-sidebar.hbs      ← Sidebar configuration
├── js/
│   └── admin.js               ← Editor preview, tag input, sidebar mgmt
└── test-fixtures/
    ├── sample-post.json
    ├── sample-index.json
    └── sample-sidebar.json
```

### Rust application

```
edge-cms/rust/
├── Cargo.toml
├── fastly.toml
├── build.rs                   ← Copies shared/ assets into build dir
├── .env.example
└── src/
    ├── main.rs                ← #[fastly::main], router dispatch
    ├── router.rs              ← URL pattern matching → Route enum
    ├── models.rs              ← Post, PostIndex, SidebarConfig structs
    ├── templates.rs           ← Handlebars registry, helpers, render fn
    ├── markdown.rs            ← pulldown-cmark wrapper
    ├── auth.rs                ← HMAC cookie signing, bcrypt validation
    ├── cache.rs               ← Surrogate key builder, cache headers
    ├── error.rs               ← Error types, error page rendering
    └── handlers/
        ├── mod.rs             ← Re-exports
        ├── public.rs          ← Reader route handlers
        ├── admin.rs           ← Admin route handlers
        └── assets.rs          ← Static files + image serving
```

---

## Phase 1: Foundation

### Task 1: Project Scaffold

**Files:**
- Create: `edge-cms/rust/Cargo.toml`
- Create: `edge-cms/rust/fastly.toml`
- Create: `edge-cms/rust/.env.example`
- Create: `edge-cms/rust/src/main.rs`

**Fastly skill:** Invoke `fastly-cli` to verify `fastly.toml` structure and store linking syntax.

- [ ] **Step 1: Create Cargo.toml**

```toml
[package]
name = "edge-cms"
version = "0.1.0"
edition = "2021"
publish = false

[dependencies]
fastly = "0.11"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
handlebars = "5"
pulldown-cmark = "0.10"
bcrypt = "0.15"
hmac = "0.12"
sha2 = "0.10"
base64 = "0.22"
time = { version = "0.3", features = ["formatting", "parsing"] }

[profile.release]
lto = true
opt-level = "s"
strip = true
```

- [ ] **Step 2: Create fastly.toml**

```toml
manifest_version = 3
name = "edge-cms"
language = "rust"
description = "A CMS running entirely on Fastly's edge platform"

[local_server]

  [local_server.kv_stores]

    [local_server.kv_stores.content]
      file = "tests/kv-content.json"

    [local_server.kv_stores.images]
      file = "tests/kv-images.json"

  [local_server.secret_stores]

    [local_server.secret_stores.secrets]

      [[local_server.secret_stores.secrets.entries]]
        key = "admin_password"
        data = "$2b$12$LJ3m4ys7of5rMhBQ5MmQ4OhOsJrSey1UTLuFRHOoKOcVPuRSWPYm6"

      [[local_server.secret_stores.secrets.entries]]
        key = "hmac_key"
        data = "dGVzdC1obWFjLWtleS1mb3ItbG9jYWwtZGV2ZWxvcG1lbnQ="  # pragma: allowlist secret

[setup]

  [setup.kv_stores]

    [setup.kv_stores.content]

    [setup.kv_stores.images]

  [setup.secret_stores]

    [setup.secret_stores.secrets]

      [[setup.secret_stores.secrets.entries]]
        key = "admin_password"
        data = "$2b$12$LJ3m4ys7of5rMhBQ5MmQ4OhOsJrSey1UTLuFRHOoKOcVPuRSWPYm6"

      [[setup.secret_stores.secrets.entries]]
        key = "hmac_key"
        data = "dGVzdC1obWFjLWtleS1mb3ItbG9jYWwtZGV2ZWxvcG1lbnQ="  # pragma: allowlist secret
```

- [ ] **Step 3: Create .env.example**

```
FASTLY_API_TOKEN=your-api-token-here
FASTLY_SERVICE_ID=your-service-id-here
```

- [ ] **Step 4: Create minimal main.rs**

```rust
use fastly::http::StatusCode;
use fastly::{Error, Request, Response};

#[fastly::main]
fn main(_req: Request) -> Result<Response, Error> {
    Ok(Response::from_status(StatusCode::OK)
        .with_body_text_plain("edge/cms is running\n"))
}
```

- [ ] **Step 5: Create local test data**

Create `edge-cms/rust/tests/kv-content.json`:
```json
{
  "data": {
    "_index": "{\"posts\":[{\"slug\":\"hello-world\",\"title\":\"Hello World\",\"excerpt\":\"First post on edge/cms\",\"status\":\"published\",\"created_at\":\"2026-05-20T14:30:00Z\",\"tags\":[\"fastly\",\"edge\"],\"featured_image\":null}]}",
    "post:hello-world": "{\"slug\":\"hello-world\",\"title\":\"Hello World\",\"content\":\"# Hello World\\n\\nThis is the first post.\",\"excerpt\":\"First post on edge/cms\",\"status\":\"published\",\"created_at\":\"2026-05-20T14:30:00Z\",\"updated_at\":\"2026-05-20T14:30:00Z\",\"tags\":[\"fastly\",\"edge\"],\"featured_image\":null,\"author\":\"Admin\"}",
    "_sidebar": "{\"items\":[{\"type\":\"category\",\"label\":\"Getting Started\",\"slug\":\"getting-started\",\"children\":[\"hello-world\"]},{\"type\":\"link\",\"label\":\"GitHub\",\"url\":\"https://github.com\",\"icon\":\"github\"}]}"
  }
}
```

- [ ] **Step 6: Verify build**

Run: `cd edge-cms/rust && cargo check --target wasm32-wasi`
Expected: compiles without errors

- [ ] **Step 7: Commit**

```bash
git add edge-cms/rust/
git commit -m "feat(edge-cms): scaffold Rust Compute project with dependencies and local test data"
```

---

### Task 2: Data Model + Tests

**Files:**
- Create: `edge-cms/rust/src/models.rs`
- Create: `edge-cms/shared/test-fixtures/sample-post.json`
- Create: `edge-cms/shared/test-fixtures/sample-index.json`
- Create: `edge-cms/shared/test-fixtures/sample-sidebar.json`

- [ ] **Step 1: Write test fixtures**

Create `edge-cms/shared/test-fixtures/sample-post.json`:
```json
{
  "slug": "hello-world",
  "title": "Hello World",
  "content": "# Hello\n\nThis is **markdown** content.\n\n## Section\n\n- item one\n- item two\n\n```rust\nfn main() {\n    println!(\"hello\");\n}\n```",
  "excerpt": "First post on edge/cms",
  "status": "published",
  "created_at": "2026-05-20T14:30:00Z",
  "updated_at": "2026-05-20T15:00:00Z",
  "tags": ["fastly", "edge"],
  "featured_image": "/images/hello-world/hero.jpg",
  "author": "Admin"
}
```

Create `edge-cms/shared/test-fixtures/sample-index.json`:
```json
{
  "posts": [
    {
      "slug": "hello-world",
      "title": "Hello World",
      "excerpt": "First post on edge/cms",
      "status": "published",
      "created_at": "2026-05-20T14:30:00Z",
      "tags": ["fastly", "edge"],
      "featured_image": "/images/hello-world/hero.jpg"
    },
    {
      "slug": "draft-post",
      "title": "Draft Post",
      "excerpt": "Not yet published",
      "status": "draft",
      "created_at": "2026-05-19T10:00:00Z",
      "tags": ["wip"],
      "featured_image": null
    }
  ]
}
```

Create `edge-cms/shared/test-fixtures/sample-sidebar.json`:
```json
{
  "items": [
    {
      "type": "category",
      "label": "Getting Started",
      "slug": "getting-started",
      "children": ["hello-world"]
    },
    {
      "type": "link",
      "label": "GitHub",
      "url": "https://github.com",
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

- [ ] **Step 2: Write models.rs with tests**

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum PostStatus {
    Published,
    Draft,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Post {
    pub slug: String,
    pub title: String,
    pub content: String,
    pub excerpt: String,
    pub status: PostStatus,
    pub created_at: String,
    pub updated_at: String,
    pub tags: Vec<String>,
    pub featured_image: Option<String>,
    pub author: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PostMeta {
    pub slug: String,
    pub title: String,
    pub excerpt: String,
    pub status: PostStatus,
    pub created_at: String,
    pub tags: Vec<String>,
    pub featured_image: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PostIndex {
    pub posts: Vec<PostMeta>,
}

impl PostIndex {
    pub fn published(&self) -> Vec<&PostMeta> {
        self.posts
            .iter()
            .filter(|p| p.status == PostStatus::Published)
            .collect()
    }

    pub fn by_tag(&self, tag: &str) -> Vec<&PostMeta> {
        self.posts
            .iter()
            .filter(|p| p.status == PostStatus::Published && p.tags.contains(&tag.to_string()))
            .collect()
    }

    pub fn add(&mut self, post: &Post) {
        self.posts.retain(|p| p.slug != post.slug);
        self.posts.insert(
            0,
            PostMeta {
                slug: post.slug.clone(),
                title: post.title.clone(),
                excerpt: post.excerpt.clone(),
                status: post.status.clone(),
                created_at: post.created_at.clone(),
                tags: post.tags.clone(),
                featured_image: post.featured_image.clone(),
            },
        );
    }

    pub fn remove(&mut self, slug: &str) {
        self.posts.retain(|p| p.slug != slug);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum SidebarItem {
    #[serde(rename = "category")]
    Category {
        label: String,
        slug: String,
        children: Vec<String>,
    },
    #[serde(rename = "link")]
    Link {
        label: String,
        url: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        icon: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SidebarConfig {
    pub items: Vec<SidebarItem>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deserialize_post() {
        let json = include_str!("../../shared/test-fixtures/sample-post.json");
        let post: Post = serde_json::from_str(json).unwrap();
        assert_eq!(post.slug, "hello-world");
        assert_eq!(post.title, "Hello World");
        assert_eq!(post.status, PostStatus::Published);
        assert_eq!(post.tags, vec!["fastly", "edge"]);
        assert!(post.content.contains("# Hello"));
    }

    #[test]
    fn deserialize_index() {
        let json = include_str!("../../shared/test-fixtures/sample-index.json");
        let index: PostIndex = serde_json::from_str(json).unwrap();
        assert_eq!(index.posts.len(), 2);
        assert_eq!(index.published().len(), 1);
        assert_eq!(index.by_tag("fastly").len(), 1);
        assert_eq!(index.by_tag("nonexistent").len(), 0);
    }

    #[test]
    fn deserialize_sidebar() {
        let json = include_str!("../../shared/test-fixtures/sample-sidebar.json");
        let sidebar: SidebarConfig = serde_json::from_str(json).unwrap();
        assert_eq!(sidebar.items.len(), 3);
        match &sidebar.items[0] {
            SidebarItem::Category { label, children, .. } => {
                assert_eq!(label, "Getting Started");
                assert_eq!(children, &vec!["hello-world"]);
            }
            _ => panic!("expected category"),
        }
        match &sidebar.items[2] {
            SidebarItem::Link { label, icon, .. } => {
                assert_eq!(label, "Fastly Docs");
                assert!(icon.is_none());
            }
            _ => panic!("expected link"),
        }
    }

    #[test]
    fn index_add_and_remove() {
        let mut index = PostIndex { posts: vec![] };
        let post = Post {
            slug: "test".into(),
            title: "Test".into(),
            content: "# Test".into(),
            excerpt: "A test".into(),
            status: PostStatus::Published,
            created_at: "2026-05-20T00:00:00Z".into(),
            updated_at: "2026-05-20T00:00:00Z".into(),
            tags: vec!["test".into()],
            featured_image: None,
            author: "Admin".into(),
        };
        index.add(&post);
        assert_eq!(index.posts.len(), 1);
        assert_eq!(index.posts[0].slug, "test");

        index.add(&post);
        assert_eq!(index.posts.len(), 1, "add should deduplicate by slug");

        index.remove("test");
        assert_eq!(index.posts.len(), 0);
    }

    #[test]
    fn post_roundtrip_json() {
        let post = Post {
            slug: "rt".into(),
            title: "Roundtrip".into(),
            content: "body".into(),
            excerpt: "ex".into(),
            status: PostStatus::Draft,
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
            tags: vec![],
            featured_image: None,
            author: "Admin".into(),
        };
        let json = serde_json::to_string(&post).unwrap();
        let back: Post = serde_json::from_str(&json).unwrap();
        assert_eq!(back.slug, "rt");
        assert_eq!(back.status, PostStatus::Draft);
    }
}
```

- [ ] **Step 3: Add module to main.rs**

Add `mod models;` to `src/main.rs`.

- [ ] **Step 4: Run tests**

Run: `cd edge-cms/rust && cargo test`
Expected: all 5 tests pass

- [ ] **Step 5: Commit**

```bash
git add edge-cms/rust/src/models.rs edge-cms/shared/test-fixtures/
git commit -m "feat(edge-cms): add data model with serde serialization and unit tests"
```

---

### Task 3: Shared CSS

**Files:**
- Create: `edge-cms/shared/css/style.css`

The CSS design system is defined in the mockup files. Extract and consolidate into a single stylesheet.

- [ ] **Step 1: Extract CSS from mockups**

Open each mockup file and extract the `<style>` content:
- `edge-cms/mockups/reader.html` — reader layout, post cards, sidebar, footer, header
- `edge-cms/mockups/reader-post.html` — post body typography, code blocks, blockquotes, share buttons
- `edge-cms/mockups/admin-dashboard.html` — admin top bar, stats cards, posts table, filters
- `edge-cms/mockups/admin-editor.html` — metadata form, split-pane editor, image upload zone

Consolidate into `edge-cms/shared/css/style.css` with these sections:
```css
/* === Variables === */
:root { /* all design tokens from mockups */ }

/* === Reset === */
/* === Typography === */
/* === Header === */
/* === Main Layout (two-column) === */
/* === Post Cards === */
/* === Sidebar === */
/* === Edge Badge === */
/* === Footer === */
/* === Post Body (single post typography) === */
/* === Code Blocks === */
/* === Share Buttons === */
/* === Pagination === */
/* === Tags === */
/* === Admin: Top Bar === */
/* === Admin: Stats Cards === */
/* === Admin: Posts Table === */
/* === Admin: Filters/Actions === */
/* === Admin: Editor Metadata === */
/* === Admin: Split Pane Editor === */
/* === Admin: Image Upload === */
/* === Error Pages === */
/* === Animations === */
/* === Responsive === */
```

Ensure CSS variables match the design doc:
```css
:root {
  --bg: #f5f0e8;
  --bg-card: #fffdf9;
  --bg-admin: #f0ede8;
  --text: #2a2520;
  --text-muted: #7a7068;
  --text-light: #a89e94;
  --accent: #1b6b52;
  --accent-hover: #14503e;
  --accent-light: #e8f3ef;
  --terracotta: #c4593a;
  --terracotta-light: #fdf0ec;
  --gold: #b8a47e;
  --gold-light: #f5f0e5;
  --border: #e5ddd3;
  --border-light: #ede7de;
  --font-display: 'Fraunces', serif;
  --font-body: 'DM Sans', sans-serif;
  --font-mono: 'JetBrains Mono', monospace;
  --max-width: 1180px;
}
```

- [ ] **Step 2: Verify CSS is self-contained**

Open a mockup, replace its `<style>` block with `<link rel="stylesheet" href="../shared/css/style.css">` and verify it renders identically. Fix any missing styles.

- [ ] **Step 3: Commit**

```bash
git add edge-cms/shared/css/
git commit -m "feat(edge-cms): extract shared CSS design system from mockups"
```

---

### Task 4: Shared Handlebars Templates

**Files:**
- Create: `edge-cms/shared/templates/layout.hbs`
- Create: `edge-cms/shared/templates/_sidebar.hbs`
- Create: `edge-cms/shared/templates/home.hbs`
- Create: `edge-cms/shared/templates/post.hbs`
- Create: `edge-cms/shared/templates/tag.hbs`
- Create: `edge-cms/shared/templates/error.hbs`
- Create: `edge-cms/shared/templates/login.hbs`
- Create: `edge-cms/shared/templates/admin-dashboard.hbs`
- Create: `edge-cms/shared/templates/admin-editor.hbs`
- Create: `edge-cms/shared/templates/admin-sidebar.hbs`

Convert mockup HTML into Handlebars templates. Replace hardcoded content with template expressions.

- [ ] **Step 1: Create layout.hbs**

Base layout wrapping all pages. The `{{{body}}}` triple-brace renders unescaped HTML from page templates.

```handlebars
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{{#if page_title}}{{page_title}} — {{/if}}edge/cms</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300;0,9..144,400;0,9..144,600;0,9..144,700;0,9..144,800;1,9..144,400&family=DM+Sans:ital,wght@0,400;0,500;0,700;1,400&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/assets/style.css">
  <link rel="alternate" type="application/rss+xml" title="edge/cms RSS" href="/feed.xml">
  {{#if og_title}}
  <meta property="og:title" content="{{og_title}}">
  <meta property="og:description" content="{{og_description}}">
  <meta property="og:type" content="{{og_type}}">
  <meta property="og:url" content="{{canonical_url}}">
  {{#if og_image}}<meta property="og:image" content="{{og_image}}">{{/if}}
  <meta name="twitter:card" content="summary_large_image">
  {{/if}}
  {{#if canonical_url}}<link rel="canonical" href="{{canonical_url}}">{{/if}}
</head>
<body{{#if body_class}} class="{{body_class}}"{{/if}}>

  {{#unless is_admin}}
  <header class="site-header">
    <div class="header-inner">
      <a href="/" class="site-title">edge<span>/</span>cms</a>
      <nav class="header-nav">
        <a href="/">Home</a>
        <a href="/feed.xml" class="nav-rss">RSS</a>
      </nav>
    </div>
  </header>
  {{else}}
  <header class="admin-topbar">
    <div class="topbar-inner">
      <a href="/" class="site-title">edge<span>/</span>cms</a>
      <span class="admin-badge">Admin</span>
      <div class="topbar-right">
        <a href="/" class="topbar-link">View Blog</a>
        <form method="post" action="/admin/logout" class="inline">
          <button type="submit" class="topbar-logout">Log out</button>
        </form>
      </div>
    </div>
  </header>
  {{/unless}}

  <main class="{{#if is_admin}}admin-layout{{else}}main-layout{{/if}}">
    {{{body}}}

    {{#unless is_admin}}
    <aside class="sidebar">
      {{> _sidebar}}
    </aside>
    {{/unless}}
  </main>

  {{#unless is_admin}}
  <footer class="site-footer">
    <div class="footer-inner">
      <div class="footer-edge">
        <span class="pop-dot"></span>
        Served from Fastly's {{pop_city}} ({{pop_code}}) edge
      </div>
      <div class="footer-links">
        <a href="/sitemap.xml">Sitemap</a>
        <a href="/feed.xml">RSS Feed</a>
      </div>
    </div>
  </footer>
  {{/unless}}

</body>
</html>
```

- [ ] **Step 2: Create _sidebar.hbs partial**

```handlebars
{{#if sidebar.items}}
<div class="sidebar-block">
  <h3 class="sidebar-heading">Categories</h3>
  {{#each sidebar.items}}
  {{#if (eq type "category")}}
  <div class="sidebar-category">
    <div class="sidebar-category-label">{{label}}</div>
    <ul class="sidebar-category-posts">
      {{#each children}}
      <li><a href="/post/{{this}}">{{this}}</a></li>
      {{/each}}
    </ul>
  </div>
  {{/if}}
  {{/each}}
</div>

<div class="sidebar-block">
  <h3 class="sidebar-heading">Links</h3>
  <ul class="sidebar-links">
    {{#each sidebar.items}}
    {{#if (eq type "link")}}
    <li><a href="{{url}}">{{label}}</a></li>
    {{/if}}
    {{/each}}
  </ul>
</div>
{{/if}}

<div class="edge-badge">
  <div class="edge-badge-title">Powered by Fastly Edge</div>
  <p>This CMS runs entirely on Fastly Compute. No origin servers.</p>
</div>
```

- [ ] **Step 3: Create reader page templates**

Create `home.hbs`:
```handlebars
<section class="posts-feed">
  {{#each posts}}
  <article class="post-card">
    {{#if featured_image}}
    <div class="post-card-featured">
      <img src="{{featured_image}}?width=800&format=webp" alt="{{title}}">
    </div>
    {{/if}}
    <div class="post-card-body">
      <div class="post-card-meta">
        <span>{{format_date created_at}}</span>
        <span class="dot"></span>
        <span>{{reading_time ../content}} min read</span>
      </div>
      <h2 class="post-card-title">
        <a href="/post/{{slug}}">{{title}}</a>
      </h2>
      <p class="post-card-excerpt">{{excerpt}}</p>
      <div class="post-card-footer">
        <div class="post-tags">
          {{#each tags}}
          <a href="/tag/{{this}}" class="tag tag-accent">{{this}}</a>
          {{/each}}
        </div>
        <a href="/post/{{slug}}" class="read-more">Read →</a>
      </div>
    </div>
  </article>
  {{/each}}

  {{#unless posts}}
  <div class="empty-state">
    <h2>No posts yet</h2>
    <p>Check back soon — content is on its way.</p>
  </div>
  {{/unless}}
</section>
```

Create `post.hbs`:
```handlebars
<article class="post-full">
  {{#if featured_image}}
  <img class="post-hero" src="{{featured_image}}?width=1000&format=webp" alt="{{title}}">
  {{/if}}

  <header class="post-header">
    <h1 class="post-title">{{title}}</h1>
    <div class="post-card-meta">
      <span>{{format_date created_at}}</span>
      <span class="dot"></span>
      <span>{{reading_time content}} min read</span>
      <span class="dot"></span>
      <span>{{author}}</span>
    </div>
    <div class="post-tags">
      {{#each tags}}
      <a href="/tag/{{this}}" class="tag tag-accent">{{this}}</a>
      {{/each}}
    </div>
  </header>

  <div class="post-body">
    {{{rendered_content}}}
  </div>

  <footer class="post-footer">
    <div class="share-buttons">
      <a href="https://twitter.com/intent/tweet?url={{canonical_url}}&text={{title}}" class="share-btn" target="_blank" rel="noopener">Share on X</a>
      <a href="https://www.linkedin.com/sharing/share-offsite/?url={{canonical_url}}" class="share-btn" target="_blank" rel="noopener">Share on LinkedIn</a>
      <button class="share-btn copy-link" data-url="{{canonical_url}}">Copy Link</button>
    </div>
  </footer>
</article>
```

Create `tag.hbs`:
```handlebars
<section class="posts-feed">
  <h1 class="tag-page-title">Posts tagged "{{tag}}"</h1>
  {{#each posts}}
  <article class="post-card">
    {{#if featured_image}}
    <div class="post-card-featured">
      <img src="{{featured_image}}?width=800&format=webp" alt="{{title}}">
    </div>
    {{/if}}
    <div class="post-card-body">
      <div class="post-card-meta">
        <span>{{format_date created_at}}</span>
      </div>
      <h2 class="post-card-title">
        <a href="/post/{{slug}}">{{title}}</a>
      </h2>
      <p class="post-card-excerpt">{{excerpt}}</p>
    </div>
  </article>
  {{/each}}

  {{#unless posts}}
  <div class="empty-state">
    <h2>No posts found</h2>
    <p>No published posts with tag "{{tag}}".</p>
  </div>
  {{/unless}}
</section>
```

Create `error.hbs`:
```handlebars
<section class="error-page">
  <h1 class="error-code">{{error_code}}</h1>
  <p class="error-message">{{error_message}}</p>
  <a href="/" class="error-home-link">← Back to homepage</a>
</section>
```

- [ ] **Step 4: Create admin templates**

Create `login.hbs`:
```handlebars
<div class="login-container">
  <div class="login-card">
    <h1 class="login-title">edge<span>/</span>cms</h1>
    <p class="login-subtitle">Admin login</p>
    {{#if error}}
    <div class="login-error">{{error}}</div>
    {{/if}}
    <form method="post" action="/admin/login">
      <label for="password" class="login-label">Password</label>
      <input type="password" id="password" name="password" class="login-input" required autofocus>
      <button type="submit" class="login-button">Log in</button>
    </form>
  </div>
</div>
```

Create `admin-dashboard.hbs` — convert mockup `admin-dashboard.html` to Handlebars:
- Replace hardcoded post rows with `{{#each posts}}` loop
- Replace hardcoded stats with `{{total_posts}}`, `{{published_count}}`, `{{draft_count}}`
- Status badges use `{{#if (eq status "published")}}` helper

Create `admin-editor.hbs` — convert mockup `admin-editor.html` to Handlebars:
- Pre-populate fields with `{{post.title}}`, `{{post.slug}}`, etc. for edit mode
- Empty fields for create mode (use `{{#if editing}}` flag)
- Form action: `{{#if editing}}/admin/posts/{{post.slug}}{{else}}/admin/posts{{/if}}`
- Method override: include hidden `_method` field for PUT

Create `admin-sidebar.hbs` — sidebar management form:
- List current items from `{{#each sidebar.items}}`
- Add category / add link forms
- Reorder with up/down buttons
- Form posts to `PUT /admin/sidebar`

- [ ] **Step 5: Commit**

```bash
git add edge-cms/shared/templates/
git commit -m "feat(edge-cms): create shared Handlebars templates for reader and admin pages"
```

---

### Task 5: Shared Admin JavaScript

**Files:**
- Create: `edge-cms/shared/js/admin.js`

- [ ] **Step 1: Extract JS from admin mockups**

Open `edge-cms/mockups/admin-editor.html` and `admin-dashboard.html`. Extract the `<script>` content and consolidate into `edge-cms/shared/js/admin.js`.

Key functionality:
- **Slug auto-generation**: title input → lowercase, replace spaces with hyphens, strip special chars
- **Tag input**: Enter to add pill, click X to remove, prevent duplicates
- **Markdown preview**: basic markdown → HTML (headings, bold, italic, code blocks, lists, links, images)
- **Dashboard search**: filter table rows by title
- **Dashboard filter**: filter by status dropdown
- **Dashboard sort**: sort by column header click

Structure as an IIFE that checks which page it's on and initializes relevant functionality:

```javascript
(function() {
  'use strict';
  if (document.querySelector('.editor-pane')) initEditor();
  if (document.querySelector('.posts-table')) initDashboard();
})();
```

- [ ] **Step 2: Commit**

```bash
git add edge-cms/shared/js/
git commit -m "feat(edge-cms): add shared admin JavaScript for editor and dashboard"
```

---

### Task 6: Build System

**Files:**
- Create: `edge-cms/rust/build.rs`

- [ ] **Step 1: Write build.rs**

```rust
use std::env;
use std::fs;
use std::path::Path;

fn copy_dir_recursive(src: &Path, dst: &Path) {
    if !dst.exists() {
        fs::create_dir_all(dst).unwrap();
    }
    for entry in fs::read_dir(src).unwrap() {
        let entry = entry.unwrap();
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dst_path);
        } else {
            fs::copy(&src_path, &dst_path).unwrap();
        }
    }
}

fn main() {
    let out_dir = env::var("OUT_DIR").unwrap();
    let shared_dir = Path::new("../shared");

    let templates_dst = Path::new(&out_dir).join("templates");
    let css_dst = Path::new(&out_dir).join("css");
    let js_dst = Path::new(&out_dir).join("js");

    copy_dir_recursive(&shared_dir.join("templates"), &templates_dst);
    copy_dir_recursive(&shared_dir.join("css"), &css_dst);
    copy_dir_recursive(&shared_dir.join("js"), &js_dst);

    println!("cargo:rerun-if-changed=../shared/templates");
    println!("cargo:rerun-if-changed=../shared/css");
    println!("cargo:rerun-if-changed=../shared/js");
}
```

- [ ] **Step 2: Verify build copies assets**

Run: `cd edge-cms/rust && cargo build --target wasm32-wasi 2>&1 | head -20`
Expected: builds without errors. Verify assets exist in target build dir.

- [ ] **Step 3: Commit**

```bash
git add edge-cms/rust/build.rs
git commit -m "feat(edge-cms): add build.rs to embed shared templates, CSS, and JS at compile time"
```

---

## Phase 2: Core Modules

### Task 7: Template Engine + Helpers

**Files:**
- Create: `edge-cms/rust/src/templates.rs`

- [ ] **Step 1: Write templates.rs**

```rust
use handlebars::{
    Context, Handlebars, Helper, HelperResult, Output, RenderContext, RenderError,
};
use serde::Serialize;
use std::sync::OnceLock;

static REGISTRY: OnceLock<Handlebars<'static>> = OnceLock::new();

macro_rules! template {
    ($name:expr) => {
        include_str!(concat!(env!("OUT_DIR"), "/templates/", $name))
    };
}

macro_rules! asset {
    ($name:expr) => {
        include_str!(concat!(env!("OUT_DIR"), "/css/", $name))
    };
}

macro_rules! js_asset {
    ($name:expr) => {
        include_str!(concat!(env!("OUT_DIR"), "/js/", $name))
    };
}

pub static CSS: &str = asset!("style.css");
pub static ADMIN_JS: &str = js_asset!("admin.js");

fn init_registry() -> Handlebars<'static> {
    let mut hbs = Handlebars::new();
    hbs.set_strict_mode(true);

    hbs.register_template_string("layout", template!("layout.hbs"))
        .expect("layout template");
    hbs.register_template_string("home", template!("home.hbs"))
        .expect("home template");
    hbs.register_template_string("post", template!("post.hbs"))
        .expect("post template");
    hbs.register_template_string("tag", template!("tag.hbs"))
        .expect("tag template");
    hbs.register_template_string("error", template!("error.hbs"))
        .expect("error template");
    hbs.register_template_string("login", template!("login.hbs"))
        .expect("login template");
    hbs.register_template_string("admin-dashboard", template!("admin-dashboard.hbs"))
        .expect("admin-dashboard template");
    hbs.register_template_string("admin-editor", template!("admin-editor.hbs"))
        .expect("admin-editor template");
    hbs.register_template_string("admin-sidebar", template!("admin-sidebar.hbs"))
        .expect("admin-sidebar template");

    hbs.register_partial("_sidebar", template!("_sidebar.hbs"))
        .expect("sidebar partial");

    hbs.register_helper("format_date", Box::new(format_date_helper));
    hbs.register_helper("reading_time", Box::new(reading_time_helper));
    hbs.register_helper("eq", Box::new(eq_helper));

    hbs
}

pub fn registry() -> &'static Handlebars<'static> {
    REGISTRY.get_or_init(init_registry)
}

pub fn render<T: Serialize>(template: &str, data: &T) -> Result<String, RenderError> {
    registry().render(template, data)
}

fn format_date_helper(
    h: &Helper,
    _: &Handlebars,
    _: &Context,
    _: &mut RenderContext,
    out: &mut dyn Output,
) -> HelperResult {
    let date_str = h
        .param(0)
        .and_then(|v| v.value().as_str())
        .unwrap_or("");
    // Parse ISO 8601, output "May 20, 2026"
    let formatted = if date_str.len() >= 10 {
        let parts: Vec<&str> = date_str[..10].split('-').collect();
        if parts.len() == 3 {
            let month = match parts[1] {
                "01" => "Jan", "02" => "Feb", "03" => "Mar", "04" => "Apr",
                "05" => "May", "06" => "Jun", "07" => "Jul", "08" => "Aug",
                "09" => "Sep", "10" => "Oct", "11" => "Nov", "12" => "Dec",
                _ => "???",
            };
            let day: u32 = parts[2].parse().unwrap_or(0);
            format!("{} {}, {}", month, day, parts[0])
        } else {
            date_str.to_string()
        }
    } else {
        date_str.to_string()
    };
    out.write(&formatted)?;
    Ok(())
}

fn reading_time_helper(
    h: &Helper,
    _: &Handlebars,
    _: &Context,
    _: &mut RenderContext,
    out: &mut dyn Output,
) -> HelperResult {
    let content = h
        .param(0)
        .and_then(|v| v.value().as_str())
        .unwrap_or("");
    let words = content.split_whitespace().count();
    let minutes = (words / 200).max(1);
    out.write(&minutes.to_string())?;
    Ok(())
}

fn eq_helper(
    h: &Helper,
    _: &Handlebars,
    _: &Context,
    _: &mut RenderContext,
    out: &mut dyn Output,
) -> HelperResult {
    let a = h.param(0).and_then(|v| v.value().as_str()).unwrap_or("");
    let b = h.param(1).and_then(|v| v.value().as_str()).unwrap_or("");
    if a == b {
        out.write("true")?;
    }
    Ok(())
}
```

- [ ] **Step 2: Add module to main.rs**

Add `mod templates;` to `src/main.rs`.

- [ ] **Step 3: Verify compilation**

Run: `cd edge-cms/rust && cargo check --target wasm32-wasi`
Expected: compiles (templates must exist in shared/ for this to work)

- [ ] **Step 4: Commit**

```bash
git add edge-cms/rust/src/templates.rs
git commit -m "feat(edge-cms): add Handlebars template engine with format_date and reading_time helpers"
```

---

### Task 8: Markdown Rendering + Tests

**Files:**
- Create: `edge-cms/rust/src/markdown.rs`

- [ ] **Step 1: Write failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_heading() {
        let html = render_markdown("# Hello");
        assert!(html.contains("<h1>Hello</h1>"));
    }

    #[test]
    fn renders_paragraph() {
        let html = render_markdown("Some text here.");
        assert!(html.contains("<p>Some text here.</p>"));
    }

    #[test]
    fn renders_bold_and_italic() {
        let html = render_markdown("**bold** and *italic*");
        assert!(html.contains("<strong>bold</strong>"));
        assert!(html.contains("<em>italic</em>"));
    }

    #[test]
    fn renders_code_block() {
        let md = "```rust\nfn main() {}\n```";
        let html = render_markdown(md);
        assert!(html.contains("<code"));
        assert!(html.contains("fn main() {}"));
    }

    #[test]
    fn renders_list() {
        let md = "- one\n- two\n- three";
        let html = render_markdown(md);
        assert!(html.contains("<li>one</li>"));
        assert!(html.contains("<ul>"));
    }

    #[test]
    fn renders_image() {
        let md = "![Alt text](/images/test/hero.jpg)";
        let html = render_markdown(md);
        assert!(html.contains("<img"));
        assert!(html.contains("src=\"/images/test/hero.jpg\""));
        assert!(html.contains("alt=\"Alt text\""));
    }

    #[test]
    fn empty_input() {
        let html = render_markdown("");
        assert_eq!(html.trim(), "");
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd edge-cms/rust && cargo test markdown`
Expected: FAIL — `render_markdown` not defined

- [ ] **Step 3: Write implementation**

```rust
use pulldown_cmark::{html, Options, Parser};

pub fn render_markdown(input: &str) -> String {
    let mut options = Options::empty();
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_TABLES);

    let parser = Parser::new_ext(input, options);
    let mut output = String::new();
    html::push_html(&mut output, parser);
    output
}
```

- [ ] **Step 4: Run tests**

Run: `cd edge-cms/rust && cargo test markdown`
Expected: all 7 tests pass

- [ ] **Step 5: Commit**

```bash
git add edge-cms/rust/src/markdown.rs
git commit -m "feat(edge-cms): add markdown rendering with pulldown-cmark"
```

---

### Task 9: Auth Module + Tests

**Files:**
- Create: `edge-cms/rust/src/auth.rs`

- [ ] **Step 1: Write failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sign_and_verify_token() {
        let key = b"test-hmac-key-for-local-development";
        let token = create_session_token(key, 3600);
        assert!(verify_session_token(key, &token).is_ok());
    }

    #[test]
    fn expired_token_rejected() {
        let key = b"test-key";
        let token = create_session_token(key, -1); // expired
        assert!(verify_session_token(key, &token).is_err());
    }

    #[test]
    fn tampered_token_rejected() {
        let key = b"test-key";
        let token = create_session_token(key, 3600);
        let tampered = format!("{}x", token);
        assert!(verify_session_token(key, &tampered).is_err());
    }

    #[test]
    fn wrong_key_rejected() {
        let token = create_session_token(b"key-one", 3600);
        assert!(verify_session_token(b"key-two", &token).is_err());
    }

    #[test]
    fn parse_cookie_header() {
        let header = "session=abc123; other=xyz";
        assert_eq!(extract_cookie(header, "session"), Some("abc123".to_string()));
        assert_eq!(extract_cookie(header, "other"), Some("xyz".to_string()));
        assert_eq!(extract_cookie(header, "missing"), None);
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd edge-cms/rust && cargo test auth`
Expected: FAIL — functions not defined

- [ ] **Step 3: Write implementation**

```rust
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::time::{SystemTime, UNIX_EPOCH};

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug)]
pub enum AuthError {
    InvalidToken,
    Expired,
    InvalidPassword,
}

impl std::fmt::Display for AuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AuthError::InvalidToken => write!(f, "invalid session token"),
            AuthError::Expired => write!(f, "session expired"),
            AuthError::InvalidPassword => write!(f, "invalid password"),
        }
    }
}

pub fn create_session_token(key: &[u8], ttl_seconds: i64) -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let expires = (now as i64 + ttl_seconds) as u64;
    let payload = expires.to_string();

    let mut mac = HmacSha256::new_from_slice(key).unwrap();
    mac.update(payload.as_bytes());
    let signature = mac.finalize().into_bytes();

    format!("{}.{}", payload, BASE64.encode(signature))
}

pub fn verify_session_token(key: &[u8], token: &str) -> Result<(), AuthError> {
    let parts: Vec<&str> = token.splitn(2, '.').collect();
    if parts.len() != 2 {
        return Err(AuthError::InvalidToken);
    }

    let payload = parts[0];
    let sig_bytes = BASE64.decode(parts[1]).map_err(|_| AuthError::InvalidToken)?;

    let mut mac = HmacSha256::new_from_slice(key).unwrap();
    mac.update(payload.as_bytes());
    mac.verify_slice(&sig_bytes)
        .map_err(|_| AuthError::InvalidToken)?;

    let expires: u64 = payload.parse().map_err(|_| AuthError::InvalidToken)?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();

    if now > expires {
        return Err(AuthError::Expired);
    }

    Ok(())
}

pub fn verify_password(password: &str, hash: &str) -> Result<(), AuthError> {
    bcrypt::verify(password, hash).map_err(|_| AuthError::InvalidPassword)?;
    Ok(())
}

pub fn extract_cookie(header: &str, name: &str) -> Option<String> {
    header
        .split(';')
        .map(|s| s.trim())
        .find_map(|pair| {
            let mut parts = pair.splitn(2, '=');
            let key = parts.next()?.trim();
            let value = parts.next()?.trim();
            if key == name {
                Some(value.to_string())
            } else {
                None
            }
        })
}

pub fn session_cookie(token: &str) -> String {
    format!(
        "session={}; HttpOnly; Secure; SameSite=Strict; Path=/admin; Max-Age=3600",
        token
    )
}

pub fn clear_session_cookie() -> String {
    "session=; HttpOnly; Secure; SameSite=Strict; Path=/admin; Max-Age=0".to_string()
}
```

- [ ] **Step 4: Run tests**

Run: `cd edge-cms/rust && cargo test auth`
Expected: all 5 tests pass

- [ ] **Step 5: Commit**

```bash
git add edge-cms/rust/src/auth.rs
git commit -m "feat(edge-cms): add HMAC session tokens and bcrypt password verification"
```

---

### Task 10: Cache Helpers

**Files:**
- Create: `edge-cms/rust/src/cache.rs`

- [ ] **Step 1: Write cache.rs**

```rust
use fastly::Response;

pub struct CacheHeaders {
    pub surrogate_keys: Vec<String>,
    pub edge_ttl: u32,
    pub browser_ttl: u32,
}

impl CacheHeaders {
    pub fn reader(keys: Vec<&str>) -> Self {
        Self {
            surrogate_keys: keys.into_iter().map(String::from).collect(),
            edge_ttl: 3600,
            browser_ttl: 60,
        }
    }

    pub fn apply(self, mut resp: Response) -> Response {
        resp.set_header(
            "Surrogate-Control",
            format!("max-age={}", self.edge_ttl),
        );
        resp.set_header(
            "Cache-Control",
            format!("max-age={}, public", self.browser_ttl),
        );
        if !self.surrogate_keys.is_empty() {
            resp.set_header("Surrogate-Key", self.surrogate_keys.join(" "));
        }
        resp
    }
}

pub fn no_cache(mut resp: Response) -> Response {
    resp.set_header("Cache-Control", "private, no-store");
    resp
}

pub fn purge_keys(keys: &[&str]) -> Result<(), fastly::Error> {
    for key in keys {
        fastly::purge::purge_surrogate_key(key)?;
    }
    Ok(())
}
```

- [ ] **Step 2: Add module to main.rs**

Add `mod cache;` to `src/main.rs`.

- [ ] **Step 3: Verify compilation**

Run: `cd edge-cms/rust && cargo check --target wasm32-wasi`
Expected: compiles

- [ ] **Step 4: Commit**

```bash
git add edge-cms/rust/src/cache.rs
git commit -m "feat(edge-cms): add cache header helpers and surrogate key purging"
```

---

## Phase 3: App Shell

### Task 11: Router + Main Entry Point

**Files:**
- Create: `edge-cms/rust/src/router.rs`
- Modify: `edge-cms/rust/src/main.rs`

- [ ] **Step 1: Write router.rs with tests**

```rust
pub enum Route {
    // Reader
    Home,
    Post { slug: String },
    Tag { tag: String },
    Image { path: String },
    Asset { path: String },
    Feed,
    Sitemap,
    Robots,
    // Admin
    AdminLogin,
    AdminLoginPost,
    AdminDashboard,
    AdminNewPost,
    AdminCreatePost,
    AdminEditPost { slug: String },
    AdminUpdatePost { slug: String },
    AdminDeletePost { slug: String },
    AdminUploadImage,
    AdminSidebar,
    AdminUpdateSidebar,
    AdminLogout,
    // Fallback
    NotFound,
}

pub fn match_route(method: &str, path: &str) -> Route {
    match (method, path) {
        // Reader routes
        ("GET", "/") => Route::Home,
        ("GET", "/feed.xml") => Route::Feed,
        ("GET", "/sitemap.xml") => Route::Sitemap,
        ("GET", "/robots.txt") => Route::Robots,
        // Admin routes
        ("GET", "/admin/login") => Route::AdminLogin,
        ("POST", "/admin/login") => Route::AdminLoginPost,
        ("POST", "/admin/logout") => Route::AdminLogout,
        ("GET", "/admin") => Route::AdminDashboard,
        ("GET", "/admin/posts/new") => Route::AdminNewPost,
        ("POST", "/admin/posts") => Route::AdminCreatePost,
        ("GET", "/admin/sidebar") => Route::AdminSidebar,
        ("PUT", "/admin/sidebar") => Route::AdminUpdateSidebar,
        ("POST", "/admin/images") => Route::AdminUploadImage,
        // Dynamic routes
        ("GET", p) => {
            if let Some(slug) = p.strip_prefix("/post/") {
                Route::Post { slug: slug.to_string() }
            } else if let Some(tag) = p.strip_prefix("/tag/") {
                Route::Tag { tag: tag.to_string() }
            } else if let Some(path) = p.strip_prefix("/images/") {
                Route::Image { path: path.to_string() }
            } else if let Some(path) = p.strip_prefix("/assets/") {
                Route::Asset { path: path.to_string() }
            } else if p.starts_with("/admin/posts/") && p.ends_with("/edit") {
                let slug = p.strip_prefix("/admin/posts/")
                    .unwrap()
                    .strip_suffix("/edit")
                    .unwrap()
                    .to_string();
                Route::AdminEditPost { slug }
            } else {
                Route::NotFound
            }
        }
        ("PUT", p) if p.starts_with("/admin/posts/") => {
            let slug = p.strip_prefix("/admin/posts/").unwrap().to_string();
            Route::AdminUpdatePost { slug }
        }
        ("DELETE", p) if p.starts_with("/admin/posts/") => {
            let slug = p.strip_prefix("/admin/posts/").unwrap().to_string();
            Route::AdminDeletePost { slug }
        }
        _ => Route::NotFound,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_home() {
        assert!(matches!(match_route("GET", "/"), Route::Home));
    }

    #[test]
    fn routes_post() {
        match match_route("GET", "/post/hello-world") {
            Route::Post { slug } => assert_eq!(slug, "hello-world"),
            _ => panic!("expected Post route"),
        }
    }

    #[test]
    fn routes_tag() {
        match match_route("GET", "/tag/fastly") {
            Route::Tag { tag } => assert_eq!(tag, "fastly"),
            _ => panic!("expected Tag route"),
        }
    }

    #[test]
    fn routes_admin_login() {
        assert!(matches!(match_route("GET", "/admin/login"), Route::AdminLogin));
        assert!(matches!(match_route("POST", "/admin/login"), Route::AdminLoginPost));
    }

    #[test]
    fn routes_admin_edit() {
        match match_route("GET", "/admin/posts/my-post/edit") {
            Route::AdminEditPost { slug } => assert_eq!(slug, "my-post"),
            _ => panic!("expected AdminEditPost route"),
        }
    }

    #[test]
    fn routes_admin_delete() {
        match match_route("DELETE", "/admin/posts/my-post") {
            Route::AdminDeletePost { slug } => assert_eq!(slug, "my-post"),
            _ => panic!("expected AdminDeletePost route"),
        }
    }

    #[test]
    fn routes_unknown() {
        assert!(matches!(match_route("GET", "/nonexistent"), Route::NotFound));
        assert!(matches!(match_route("PATCH", "/"), Route::NotFound));
    }
}
```

- [ ] **Step 2: Write main.rs with full dispatch**

```rust
use fastly::http::StatusCode;
use fastly::{Error, Request, Response};

mod auth;
mod cache;
mod error;
mod handlers;
mod markdown;
mod models;
mod router;
mod templates;

#[fastly::main]
fn main(req: Request) -> Result<Response, Error> {
    let method = req.get_method_str().to_string();
    let path = req.get_path().to_string();

    let result = match router::match_route(&method, &path) {
        // Reader
        router::Route::Home => handlers::public::home(&req),
        router::Route::Post { slug } => handlers::public::post(&req, &slug),
        router::Route::Tag { tag } => handlers::public::tag(&req, &tag),
        router::Route::Image { path } => handlers::assets::image(&req, &path),
        router::Route::Asset { path } => handlers::assets::static_file(&path),
        router::Route::Feed => handlers::public::feed(&req),
        router::Route::Sitemap => handlers::public::sitemap(&req),
        router::Route::Robots => handlers::public::robots(),
        // Admin
        router::Route::AdminLogin => handlers::admin::login_page(&req),
        router::Route::AdminLoginPost => handlers::admin::login_submit(req),
        router::Route::AdminLogout => handlers::admin::logout(),
        router::Route::AdminDashboard => handlers::admin::dashboard(&req),
        router::Route::AdminNewPost => handlers::admin::new_post(&req),
        router::Route::AdminCreatePost => handlers::admin::create_post(req),
        router::Route::AdminEditPost { slug } => handlers::admin::edit_post(&req, &slug),
        router::Route::AdminUpdatePost { slug } => handlers::admin::update_post(req, &slug),
        router::Route::AdminDeletePost { slug } => handlers::admin::delete_post(&req, &slug),
        router::Route::AdminUploadImage => handlers::admin::upload_image(req),
        router::Route::AdminSidebar => handlers::admin::sidebar_page(&req),
        router::Route::AdminUpdateSidebar => handlers::admin::update_sidebar(req),
        // Fallback
        router::Route::NotFound => error::not_found(),
    };

    match result {
        Ok(resp) => Ok(resp),
        Err(e) => {
            eprintln!("error: {}", e);
            error::internal_error()
        }
    }
}
```

- [ ] **Step 3: Create handler module stubs**

Create `edge-cms/rust/src/handlers/mod.rs`:
```rust
pub mod admin;
pub mod assets;
pub mod public;
```

Create stub files for `public.rs`, `admin.rs`, and `assets.rs` with placeholder functions that return `501 Not Implemented`. Each function signature must match the calls in main.rs. These stubs will be filled in subsequent tasks.

- [ ] **Step 4: Create error.rs stub**

```rust
use fastly::http::StatusCode;
use fastly::{Error, Response};

pub fn not_found() -> Result<Response, Error> {
    Ok(Response::from_status(StatusCode::NOT_FOUND)
        .with_body_text_plain("404 Not Found\n"))
}

pub fn internal_error() -> Result<Response, Error> {
    Ok(Response::from_status(StatusCode::INTERNAL_SERVER_ERROR)
        .with_body_text_plain("500 Internal Server Error\n"))
}
```

- [ ] **Step 5: Run tests**

Run: `cd edge-cms/rust && cargo test`
Expected: all model, markdown, auth, and router tests pass

- [ ] **Step 6: Commit**

```bash
git add edge-cms/rust/src/
git commit -m "feat(edge-cms): add URL router with full route dispatch and handler stubs"
```

---

### Task 12: Static Asset Serving

**Files:**
- Modify: `edge-cms/rust/src/handlers/assets.rs`

- [ ] **Step 1: Implement asset handler**

```rust
use fastly::http::StatusCode;
use fastly::{Error, KVStore, Response};

use crate::cache::CacheHeaders;
use crate::templates;

pub fn static_file(path: &str) -> Result<Response, Error> {
    let (body, content_type) = match path {
        "style.css" => (templates::CSS, "text/css; charset=utf-8"),
        "admin.js" => (templates::ADMIN_JS, "application/javascript; charset=utf-8"),
        _ => {
            return Ok(Response::from_status(StatusCode::NOT_FOUND)
                .with_body_text_plain("Asset not found\n"));
        }
    };

    let resp = Response::from_status(StatusCode::OK)
        .with_header("Content-Type", content_type)
        .with_body_text_plain(body);

    Ok(CacheHeaders::reader(vec!["assets"]).apply(resp))
}

pub fn image(req: &fastly::Request, path: &str) -> Result<Response, Error> {
    let store = KVStore::open("images")?
        .ok_or_else(|| Error::msg("images store not found"))?;

    let key = format!("images/{}", path);
    match store.lookup_bytes(&key)? {
        Some(bytes) => {
            let content_type = guess_content_type(path);
            let resp = Response::from_status(StatusCode::OK)
                .with_header("Content-Type", content_type)
                .with_body_octet_stream(&bytes);

            let slug = path.split('/').next().unwrap_or("unknown");
            Ok(CacheHeaders::reader(vec![&format!("image-{}", slug)]).apply(resp))
        }
        None => Ok(Response::from_status(StatusCode::NOT_FOUND)
            .with_body_text_plain("Image not found\n")),
    }
}

fn guess_content_type(path: &str) -> &'static str {
    if path.ends_with(".jpg") || path.ends_with(".jpeg") {
        "image/jpeg"
    } else if path.ends_with(".png") {
        "image/png"
    } else if path.ends_with(".gif") {
        "image/gif"
    } else if path.ends_with(".webp") {
        "image/webp"
    } else if path.ends_with(".svg") {
        "image/svg+xml"
    } else {
        "application/octet-stream"
    }
}
```

- [ ] **Step 2: Verify compilation**

Run: `cd edge-cms/rust && cargo check --target wasm32-wasi`

- [ ] **Step 3: Commit**

```bash
git add edge-cms/rust/src/handlers/assets.rs
git commit -m "feat(edge-cms): serve embedded CSS/JS and images from Object Store"
```

---

## Phase 4: Reader Routes

### Task 13: Homepage + Tag Page Handlers

**Files:**
- Modify: `edge-cms/rust/src/handlers/public.rs`

**Fastly skill:** Invoke `viceroy` skill for local testing with `fastly compute serve`.

- [ ] **Step 1: Implement shared helpers for reading store data**

At the top of `public.rs`:

```rust
use fastly::http::StatusCode;
use fastly::{Error, KVStore, Request, Response};
use serde_json::json;

use crate::cache::CacheHeaders;
use crate::models::{PostIndex, PostStatus, SidebarConfig};
use crate::templates;

fn read_index() -> Result<PostIndex, Error> {
    let store = KVStore::open("content")?
        .ok_or_else(|| Error::msg("content store not found"))?;
    match store.lookup_str("_index")? {
        Some(json) => Ok(serde_json::from_str(&json)?),
        None => Ok(PostIndex { posts: vec![] }),
    }
}

fn read_sidebar() -> Result<SidebarConfig, Error> {
    let store = KVStore::open("content")?
        .ok_or_else(|| Error::msg("content store not found"))?;
    match store.lookup_str("_sidebar")? {
        Some(json) => Ok(serde_json::from_str(&json)?),
        None => Ok(SidebarConfig { items: vec![] }),
    }
}

fn geo_context(req: &Request) -> serde_json::Value {
    let client_ip = req.get_client_ip_addr();
    let (city, code) = client_ip
        .and_then(|ip| fastly::geo::geo_lookup(ip))
        .map(|geo| {
            (
                geo.city().map(|c| c.to_string()).unwrap_or_default(),
                geo.as_name().map(|n| n.to_string()).unwrap_or("???".into()),
            )
        })
        .unwrap_or(("Edge".into(), "CDN".into()));
    json!({ "pop_city": city, "pop_code": code })
}
```

- [ ] **Step 2: Implement homepage handler**

```rust
pub fn home(req: &Request) -> Result<Response, Error> {
    let index = read_index()?;
    let sidebar = read_sidebar()?;
    let geo = geo_context(req);

    let published: Vec<_> = index.published().into_iter().cloned().collect();

    let data = json!({
        "page_title": null::<String>,
        "posts": published,
        "sidebar": sidebar,
        "pop_city": geo["pop_city"],
        "pop_code": geo["pop_code"],
    });

    let html = templates::render("home", &data)
        .map_err(|e| Error::msg(format!("template error: {}", e)))?;

    let resp = Response::from_status(StatusCode::OK)
        .with_header("Content-Type", "text/html; charset=utf-8")
        .with_body_text_plain(&html);

    Ok(CacheHeaders::reader(vec!["post-index", "sidebar"]).apply(resp))
}
```

- [ ] **Step 3: Implement tag page handler**

```rust
pub fn tag(req: &Request, tag_name: &str) -> Result<Response, Error> {
    let index = read_index()?;
    let sidebar = read_sidebar()?;
    let geo = geo_context(req);

    let filtered: Vec<_> = index.by_tag(tag_name).into_iter().cloned().collect();

    let data = json!({
        "page_title": format!("Posts tagged \"{}\"", tag_name),
        "tag": tag_name,
        "posts": filtered,
        "sidebar": sidebar,
        "pop_city": geo["pop_city"],
        "pop_code": geo["pop_code"],
    });

    let html = templates::render("tag", &data)
        .map_err(|e| Error::msg(format!("template error: {}", e)))?;

    let resp = Response::from_status(StatusCode::OK)
        .with_header("Content-Type", "text/html; charset=utf-8")
        .with_body_text_plain(&html);

    Ok(CacheHeaders::reader(vec!["post-index", "sidebar"]).apply(resp))
}
```

- [ ] **Step 4: Test locally with Viceroy**

Run: `cd edge-cms/rust && fastly compute serve`
Test: `curl http://localhost:7676/`
Expected: HTML response with blog layout, "Hello World" post from test data

Test: `curl http://localhost:7676/tag/fastly`
Expected: filtered listing showing only posts tagged "fastly"

- [ ] **Step 5: Commit**

```bash
git add edge-cms/rust/src/handlers/public.rs
git commit -m "feat(edge-cms): implement homepage and tag page with KV Store reads and caching"
```

---

### Task 14: Single Post Handler

**Files:**
- Modify: `edge-cms/rust/src/handlers/public.rs`

- [ ] **Step 1: Implement post handler**

Add to `public.rs`:

```rust
use crate::markdown;
use crate::models::Post;

pub fn post(req: &Request, slug: &str) -> Result<Response, Error> {
    let store = KVStore::open("content")?
        .ok_or_else(|| Error::msg("content store not found"))?;

    let key = format!("post:{}", slug);
    let post_json = match store.lookup_str(&key)? {
        Some(json) => json,
        None => return crate::error::not_found(),
    };

    let post: Post = serde_json::from_str(&post_json)?;

    if post.status == PostStatus::Draft {
        return crate::error::not_found();
    }

    let rendered_content = markdown::render_markdown(&post.content);
    let sidebar = read_sidebar()?;
    let geo = geo_context(req);

    let data = json!({
        "page_title": post.title,
        "title": post.title,
        "slug": post.slug,
        "content": post.content,
        "rendered_content": rendered_content,
        "excerpt": post.excerpt,
        "author": post.author,
        "created_at": post.created_at,
        "tags": post.tags,
        "featured_image": post.featured_image,
        "canonical_url": format!("/post/{}", post.slug),
        "og_title": post.title,
        "og_description": post.excerpt,
        "og_type": "article",
        "og_image": post.featured_image,
        "sidebar": sidebar,
        "pop_city": geo["pop_city"],
        "pop_code": geo["pop_code"],
    });

    let html = templates::render("post", &data)
        .map_err(|e| Error::msg(format!("template error: {}", e)))?;

    let resp = Response::from_status(StatusCode::OK)
        .with_header("Content-Type", "text/html; charset=utf-8")
        .with_body_text_plain(&html);

    Ok(CacheHeaders::reader(vec![&format!("post-{}", slug), "sidebar"]).apply(resp))
}
```

- [ ] **Step 2: Test locally**

Run: `cd edge-cms/rust && fastly compute serve`
Test: `curl http://localhost:7676/post/hello-world`
Expected: rendered HTML with markdown converted to HTML, OG tags in head

Test: `curl -o /dev/null -s -w "%{http_code}" http://localhost:7676/post/nonexistent`
Expected: 404

- [ ] **Step 3: Commit**

```bash
git add edge-cms/rust/src/handlers/public.rs
git commit -m "feat(edge-cms): implement single post page with markdown rendering and OG tags"
```

---

### Task 15: Feed Generation

**Files:**
- Modify: `edge-cms/rust/src/handlers/public.rs`

- [ ] **Step 1: Implement RSS feed**

```rust
pub fn feed(req: &Request) -> Result<Response, Error> {
    let index = read_index()?;
    let published: Vec<_> = index.published().into_iter().take(20).collect();

    let mut xml = String::from(r#"<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>edge/cms</title>
  <description>A blog running entirely on Fastly's edge</description>
  <link>/</link>
  <atom:link href="/feed.xml" rel="self" type="application/rss+xml"/>
"#);

    for post in published {
        xml.push_str(&format!(
            "  <item>\n    <title>{}</title>\n    <link>/post/{}</link>\n    <guid>/post/{}</guid>\n    <description>{}</description>\n    <pubDate>{}</pubDate>\n  </item>\n",
            xml_escape(&post.title),
            post.slug,
            post.slug,
            xml_escape(&post.excerpt),
            post.created_at,
        ));
    }

    xml.push_str("</channel>\n</rss>");

    let resp = Response::from_status(StatusCode::OK)
        .with_header("Content-Type", "application/rss+xml; charset=utf-8")
        .with_body_text_plain(&xml);

    Ok(CacheHeaders::reader(vec!["post-index"]).apply(resp))
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}
```

- [ ] **Step 2: Implement sitemap**

```rust
pub fn sitemap(req: &Request) -> Result<Response, Error> {
    let index = read_index()?;

    let mut xml = String::from(r#"<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>/</loc></url>
"#);

    for post in index.published() {
        xml.push_str(&format!(
            "  <url><loc>/post/{}</loc><lastmod>{}</lastmod></url>\n",
            post.slug, post.created_at
        ));
    }

    xml.push_str("</urlset>");

    let resp = Response::from_status(StatusCode::OK)
        .with_header("Content-Type", "application/xml; charset=utf-8")
        .with_body_text_plain(&xml);

    Ok(CacheHeaders::reader(vec!["post-index"]).apply(resp))
}
```

- [ ] **Step 3: Implement robots.txt**

```rust
pub fn robots() -> Result<Response, Error> {
    let body = "User-agent: *\nAllow: /\nSitemap: /sitemap.xml\n";

    let resp = Response::from_status(StatusCode::OK)
        .with_header("Content-Type", "text/plain; charset=utf-8")
        .with_body_text_plain(body);

    Ok(CacheHeaders::reader(vec!["config"]).apply(resp))
}
```

- [ ] **Step 4: Test locally**

Run: `curl http://localhost:7676/feed.xml` → valid RSS XML
Run: `curl http://localhost:7676/sitemap.xml` → valid sitemap XML
Run: `curl http://localhost:7676/robots.txt` → text with Sitemap directive

- [ ] **Step 5: Commit**

```bash
git add edge-cms/rust/src/handlers/public.rs
git commit -m "feat(edge-cms): add RSS feed, sitemap, and robots.txt generation"
```

---

## Phase 5: Admin Routes

### Task 16: Login Handler

**Files:**
- Modify: `edge-cms/rust/src/handlers/admin.rs`

**Fastly skill:** Invoke `fastly` skill for rate limiting configuration.

- [ ] **Step 1: Implement login page and form submission**

```rust
use fastly::http::StatusCode;
use fastly::{Error, Request, Response, SecretStore};
use serde_json::json;

use crate::auth;
use crate::cache;
use crate::templates;

fn require_auth(req: &Request) -> Result<(), Response> {
    let cookie_header = req.get_header_str("Cookie").unwrap_or("");
    let token = auth::extract_cookie(cookie_header, "session")
        .ok_or_else(|| redirect_to_login("expired"))?;

    let secrets = SecretStore::open("secrets")
        .ok()
        .flatten()
        .ok_or_else(|| redirect_to_login("error"))?;

    let hmac_key = secrets
        .get("hmac_key")
        .ok()
        .flatten()
        .ok_or_else(|| redirect_to_login("error"))?;

    auth::verify_session_token(hmac_key.plaintext(), &token)
        .map_err(|_| redirect_to_login("expired"))
}

fn redirect_to_login(reason: &str) -> Response {
    Response::from_status(StatusCode::FOUND)
        .with_header("Location", format!("/admin/login?error={}", reason))
}

pub fn login_page(req: &Request) -> Result<Response, Error> {
    let error = req.get_query_parameter("error").map(|e| match e.as_str() {
        "expired" => "Session expired. Please log in again.",
        "invalid" => "Invalid password.",
        "rate" => "Too many attempts. Try again later.",
        _ => "",
    });

    let data = json!({
        "body_class": "login-page",
        "error": error,
    });

    let html = templates::render("login", &data)
        .map_err(|e| Error::msg(format!("template error: {}", e)))?;

    Ok(cache::no_cache(
        Response::from_status(StatusCode::OK)
            .with_header("Content-Type", "text/html; charset=utf-8")
            .with_body_text_plain(&html),
    ))
}

pub fn login_submit(req: Request) -> Result<Response, Error> {
    let body = req.into_body_str();
    let password = body
        .split('&')
        .find_map(|pair| {
            let mut parts = pair.splitn(2, '=');
            if parts.next() == Some("password") {
                parts.next().map(|v| urlencoding_decode(v))
            } else {
                None
            }
        })
        .unwrap_or_default();

    let secrets = SecretStore::open("secrets")?
        .ok_or_else(|| Error::msg("secrets store not found"))?;

    let hash = secrets.get("admin_password")?
        .ok_or_else(|| Error::msg("admin_password not found"))?;

    if auth::verify_password(&password, std::str::from_utf8(hash.plaintext()).unwrap()).is_err() {
        return Ok(Response::from_status(StatusCode::FOUND)
            .with_header("Location", "/admin/login?error=invalid"));
    }

    let hmac_key = secrets.get("hmac_key")?
        .ok_or_else(|| Error::msg("hmac_key not found"))?;

    let token = auth::create_session_token(hmac_key.plaintext(), 3600);

    Ok(Response::from_status(StatusCode::FOUND)
        .with_header("Location", "/admin")
        .with_header("Set-Cookie", auth::session_cookie(&token)))
}

pub fn logout() -> Result<Response, Error> {
    Ok(Response::from_status(StatusCode::FOUND)
        .with_header("Location", "/")
        .with_header("Set-Cookie", auth::clear_session_cookie()))
}

fn urlencoding_decode(s: &str) -> String {
    s.replace('+', " ")
        .replace("%20", " ")
        .replace("%21", "!")
        .replace("%40", "@")
        .replace("%23", "#")
        .replace("%24", "$")
        .replace("%25", "%")
        .replace("%26", "&")
        .replace("%3D", "=")
}
```

- [ ] **Step 2: Test login flow locally**

Run: `fastly compute serve`
Test: `curl http://localhost:7676/admin/login` → login form HTML
Test: `curl -X POST -d "password=test-password" http://localhost:7676/admin/login -v`
Expected: 302 redirect to `/admin` with `Set-Cookie` header

- [ ] **Step 3: Commit**

```bash
git add edge-cms/rust/src/handlers/admin.rs
git commit -m "feat(edge-cms): implement admin login with bcrypt + HMAC session cookies"
```

---

### Task 17: Admin Dashboard

**Files:**
- Modify: `edge-cms/rust/src/handlers/admin.rs`

- [ ] **Step 1: Implement dashboard handler**

```rust
pub fn dashboard(req: &Request) -> Result<Response, Error> {
    if let Err(resp) = require_auth(req) {
        return Ok(resp);
    }

    let index = super::public::read_index()?;
    let total = index.posts.len();
    let published = index.posts.iter().filter(|p| p.status == crate::models::PostStatus::Published).count();
    let drafts = total - published;

    let data = json!({
        "is_admin": true,
        "page_title": "Dashboard",
        "posts": index.posts,
        "total_posts": total,
        "published_count": published,
        "draft_count": drafts,
    });

    let html = templates::render("admin-dashboard", &data)
        .map_err(|e| Error::msg(format!("template error: {}", e)))?;

    Ok(cache::no_cache(
        Response::from_status(StatusCode::OK)
            .with_header("Content-Type", "text/html; charset=utf-8")
            .with_body_text_plain(&html),
    ))
}
```

Note: Make `read_index()` and `read_sidebar()` in `public.rs` `pub(crate)` so admin handlers can reuse them.

- [ ] **Step 2: Test locally**

Test: Login first to get cookie, then `curl -b "session=<token>" http://localhost:7676/admin`
Expected: admin dashboard HTML with post list

- [ ] **Step 3: Commit**

```bash
git add edge-cms/rust/src/handlers/admin.rs edge-cms/rust/src/handlers/public.rs
git commit -m "feat(edge-cms): implement admin dashboard with post listing and stats"
```

---

### Task 18: Post CRUD Handlers

**Files:**
- Modify: `edge-cms/rust/src/handlers/admin.rs`

- [ ] **Step 1: Implement new post form**

```rust
pub fn new_post(req: &Request) -> Result<Response, Error> {
    if let Err(resp) = require_auth(req) {
        return Ok(resp);
    }

    let data = json!({
        "is_admin": true,
        "page_title": "New Post",
        "editing": false,
    });

    let html = templates::render("admin-editor", &data)
        .map_err(|e| Error::msg(format!("template error: {}", e)))?;

    Ok(cache::no_cache(
        Response::from_status(StatusCode::OK)
            .with_header("Content-Type", "text/html; charset=utf-8")
            .with_body_text_plain(&html),
    ))
}
```

- [ ] **Step 2: Implement create post handler**

```rust
pub fn create_post(req: Request) -> Result<Response, Error> {
    if let Err(resp) = require_auth(&req) {
        return Ok(resp);
    }

    let body = req.into_body_str();
    let params = parse_form_body(&body);

    let now = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default();

    let post = crate::models::Post {
        slug: params.get("slug").cloned().unwrap_or_default(),
        title: params.get("title").cloned().unwrap_or_default(),
        content: params.get("content").cloned().unwrap_or_default(),
        excerpt: params.get("excerpt").cloned().unwrap_or_default(),
        status: if params.get("status").map(|s| s.as_str()) == Some("published") {
            crate::models::PostStatus::Published
        } else {
            crate::models::PostStatus::Draft
        },
        created_at: now.clone(),
        updated_at: now,
        tags: params
            .get("tags")
            .map(|t| t.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect())
            .unwrap_or_default(),
        featured_image: params.get("featured_image").cloned().filter(|s| !s.is_empty()),
        author: "Admin".into(),
    };

    let store = fastly::KVStore::open("content")?
        .ok_or_else(|| Error::msg("content store not found"))?;

    let key = format!("post:{}", post.slug);
    store.insert(&key, serde_json::to_string(&post)?)?;

    let mut index = super::public::read_index()?;
    index.add(&post);
    store.insert("_index", serde_json::to_string(&index)?)?;

    crate::cache::purge_keys(&["post-index"])?;

    Ok(Response::from_status(StatusCode::FOUND)
        .with_header("Location", "/admin"))
}
```

- [ ] **Step 3: Implement edit post handler**

```rust
pub fn edit_post(req: &Request, slug: &str) -> Result<Response, Error> {
    if let Err(resp) = require_auth(req) {
        return Ok(resp);
    }

    let store = fastly::KVStore::open("content")?
        .ok_or_else(|| Error::msg("content store not found"))?;

    let key = format!("post:{}", slug);
    let post_json = match store.lookup_str(&key)? {
        Some(json) => json,
        None => return crate::error::not_found(),
    };

    let post: crate::models::Post = serde_json::from_str(&post_json)?;

    let data = json!({
        "is_admin": true,
        "page_title": format!("Edit: {}", post.title),
        "editing": true,
        "post": post,
    });

    let html = templates::render("admin-editor", &data)
        .map_err(|e| Error::msg(format!("template error: {}", e)))?;

    Ok(cache::no_cache(
        Response::from_status(StatusCode::OK)
            .with_header("Content-Type", "text/html; charset=utf-8")
            .with_body_text_plain(&html),
    ))
}
```

- [ ] **Step 4: Implement update post handler**

```rust
pub fn update_post(req: Request, slug: &str) -> Result<Response, Error> {
    if let Err(resp) = require_auth(&req) {
        return Ok(resp);
    }

    let store = fastly::KVStore::open("content")?
        .ok_or_else(|| Error::msg("content store not found"))?;

    let old_key = format!("post:{}", slug);
    let old_json = store.lookup_str(&old_key)?
        .ok_or_else(|| Error::msg("post not found"))?;
    let old_post: crate::models::Post = serde_json::from_str(&old_json)?;

    let body = req.into_body_str();
    let params = parse_form_body(&body);

    let now = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default();

    let updated = crate::models::Post {
        slug: params.get("slug").cloned().unwrap_or(old_post.slug),
        title: params.get("title").cloned().unwrap_or(old_post.title),
        content: params.get("content").cloned().unwrap_or(old_post.content),
        excerpt: params.get("excerpt").cloned().unwrap_or(old_post.excerpt),
        status: if params.get("status").map(|s| s.as_str()) == Some("published") {
            crate::models::PostStatus::Published
        } else {
            crate::models::PostStatus::Draft
        },
        created_at: old_post.created_at,
        updated_at: now,
        tags: params
            .get("tags")
            .map(|t| t.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect())
            .unwrap_or(old_post.tags),
        featured_image: params.get("featured_image").cloned().filter(|s| !s.is_empty()).or(old_post.featured_image),
        author: old_post.author,
    };

    let new_key = format!("post:{}", updated.slug);
    store.insert(&new_key, serde_json::to_string(&updated)?)?;

    if new_key != old_key {
        store.delete(&old_key)?;
    }

    let mut index = super::public::read_index()?;
    index.add(&updated);
    store.insert("_index", serde_json::to_string(&index)?)?;

    crate::cache::purge_keys(&[
        &format!("post-{}", slug),
        "post-index",
    ])?;

    Ok(Response::from_status(StatusCode::FOUND)
        .with_header("Location", "/admin"))
}
```

- [ ] **Step 5: Implement delete post handler**

```rust
pub fn delete_post(req: &Request, slug: &str) -> Result<Response, Error> {
    if let Err(resp) = require_auth(req) {
        return Ok(resp);
    }

    let store = fastly::KVStore::open("content")?
        .ok_or_else(|| Error::msg("content store not found"))?;

    let key = format!("post:{}", slug);
    store.delete(&key)?;

    let mut index = super::public::read_index()?;
    index.remove(slug);
    store.insert("_index", serde_json::to_string(&index)?)?;

    crate::cache::purge_keys(&[
        &format!("post-{}", slug),
        "post-index",
    ])?;

    Ok(Response::from_status(StatusCode::FOUND)
        .with_header("Location", "/admin"))
}

fn parse_form_body(body: &str) -> std::collections::HashMap<String, String> {
    body.split('&')
        .filter_map(|pair| {
            let mut parts = pair.splitn(2, '=');
            let key = parts.next()?;
            let value = parts.next().unwrap_or("");
            Some((key.to_string(), urlencoding_decode(value)))
        })
        .collect()
}
```

- [ ] **Step 6: Test CRUD flow locally**

Run: `fastly compute serve`
1. Login → get session cookie
2. `POST /admin/posts` with form data → creates post
3. `GET /post/<slug>` → verify post renders
4. `PUT /admin/posts/<slug>` with updated data → verify changes
5. `DELETE /admin/posts/<slug>` → verify post removed from index

- [ ] **Step 7: Commit**

```bash
git add edge-cms/rust/src/handlers/admin.rs
git commit -m "feat(edge-cms): implement post CRUD with KV Store writes and cache purging"
```

---

### Task 19: Image Upload + Sidebar Editor

**Files:**
- Modify: `edge-cms/rust/src/handlers/admin.rs`

- [ ] **Step 1: Implement image upload handler**

```rust
pub fn upload_image(req: Request) -> Result<Response, Error> {
    if let Err(resp) = require_auth(&req) {
        return Ok(resp);
    }

    let content_type = req.get_header_str("Content-Type")
        .unwrap_or("")
        .to_string();

    if !content_type.contains("multipart/form-data") {
        return Ok(Response::from_status(StatusCode::BAD_REQUEST)
            .with_body_text_plain("Expected multipart/form-data\n"));
    }

    let body_bytes = req.into_body_bytes();

    let boundary = content_type
        .split("boundary=")
        .nth(1)
        .unwrap_or("")
        .to_string();

    let (filename, image_data, slug) = parse_multipart(&body_bytes, &boundary)?;

    let store = fastly::KVStore::open("images")?
        .ok_or_else(|| Error::msg("images store not found"))?;

    let key = format!("images/{}/{}", slug, filename);
    store.insert(&key, image_data)?;

    let image_url = format!("/images/{}/{}", slug, filename);

    Ok(cache::no_cache(
        Response::from_status(StatusCode::OK)
            .with_header("Content-Type", "application/json")
            .with_body_text_plain(&json!({ "url": image_url }).to_string()),
    ))
}

fn parse_multipart(body: &[u8], boundary: &str) -> Result<(String, Vec<u8>, String), Error> {
    // Minimal multipart parser — extract first file part and slug field
    // Production would use a proper multipart crate
    let body_str = String::from_utf8_lossy(body);
    let delimiter = format!("--{}", boundary);

    let mut filename = String::new();
    let mut slug = String::new();
    let mut file_data: Vec<u8> = Vec::new();

    for part in body_str.split(&delimiter) {
        if part.contains("name=\"slug\"") {
            slug = part.split("\r\n\r\n").nth(1)
                .unwrap_or("").trim().to_string();
        }
        if part.contains("filename=\"") {
            filename = part
                .split("filename=\"").nth(1)
                .and_then(|s| s.split('"').next())
                .unwrap_or("upload.bin")
                .to_string();
            if let Some(data_start) = part.find("\r\n\r\n") {
                let data = &part[data_start + 4..];
                file_data = data.trim_end().as_bytes().to_vec();
            }
        }
    }

    if filename.is_empty() {
        return Err(Error::msg("no file in upload"));
    }

    Ok((filename, file_data, slug))
}
```

- [ ] **Step 2: Implement sidebar editor handlers**

```rust
pub fn sidebar_page(req: &Request) -> Result<Response, Error> {
    if let Err(resp) = require_auth(req) {
        return Ok(resp);
    }

    let sidebar = super::public::read_sidebar()?;

    let data = json!({
        "is_admin": true,
        "page_title": "Sidebar",
        "sidebar": sidebar,
    });

    let html = templates::render("admin-sidebar", &data)
        .map_err(|e| Error::msg(format!("template error: {}", e)))?;

    Ok(cache::no_cache(
        Response::from_status(StatusCode::OK)
            .with_header("Content-Type", "text/html; charset=utf-8")
            .with_body_text_plain(&html),
    ))
}

pub fn update_sidebar(req: Request) -> Result<Response, Error> {
    if let Err(resp) = require_auth(&req) {
        return Ok(resp);
    }

    let body = req.into_body_str();
    let sidebar: crate::models::SidebarConfig = serde_json::from_str(&body)
        .map_err(|e| Error::msg(format!("invalid sidebar JSON: {}", e)))?;

    let store = fastly::KVStore::open("content")?
        .ok_or_else(|| Error::msg("content store not found"))?;

    store.insert("_sidebar", serde_json::to_string(&sidebar)?)?;

    crate::cache::purge_keys(&["sidebar"])?;

    Ok(cache::no_cache(
        Response::from_status(StatusCode::OK)
            .with_header("Content-Type", "application/json")
            .with_body_text_plain(&json!({ "ok": true }).to_string()),
    ))
}
```

- [ ] **Step 3: Commit**

```bash
git add edge-cms/rust/src/handlers/admin.rs
git commit -m "feat(edge-cms): add image upload to Object Store and sidebar editor"
```

---

## Phase 6: Polish

### Task 20: Error Pages

**Files:**
- Modify: `edge-cms/rust/src/error.rs`

- [ ] **Step 1: Implement templated error pages**

```rust
use fastly::http::StatusCode;
use fastly::{Error, Response};
use serde_json::json;

use crate::templates;

pub fn not_found() -> Result<Response, Error> {
    render_error(StatusCode::NOT_FOUND, "404", "Page not found. The post you're looking for doesn't exist or has been removed.")
}

pub fn internal_error() -> Result<Response, Error> {
    render_error(StatusCode::INTERNAL_SERVER_ERROR, "500", "Something went wrong. We're looking into it.")
}

pub fn service_unavailable() -> Result<Response, Error> {
    render_error(StatusCode::SERVICE_UNAVAILABLE, "503", "Temporarily unavailable. Please try again in a moment.")
}

fn render_error(status: StatusCode, code: &str, message: &str) -> Result<Response, Error> {
    let data = json!({
        "error_code": code,
        "error_message": message,
        "page_title": format!("{} Error", code),
        "sidebar": { "items": [] },
        "pop_city": "Edge",
        "pop_code": "CDN",
    });

    match templates::render("error", &data) {
        Ok(html) => Ok(Response::from_status(status)
            .with_header("Content-Type", "text/html; charset=utf-8")
            .with_body_text_plain(&html)),
        Err(_) => Ok(Response::from_status(status)
            .with_body_text_plain(&format!("{} {}\n", code, message))),
    }
}
```

- [ ] **Step 2: Test error pages**

Run: `curl http://localhost:7676/nonexistent-page`
Expected: styled 404 page using blog template

- [ ] **Step 3: Commit**

```bash
git add edge-cms/rust/src/error.rs
git commit -m "feat(edge-cms): add templated error pages (404, 500, 503)"
```

---

### Task 21: Integration Test Setup

**Files:**
- Create: `edge-cms/rust/tests/integration.sh`

**Fastly skill:** Invoke `viceroy` skill for local testing setup.

- [ ] **Step 1: Write integration test script**

```bash
#!/usr/bin/env bash
set -euo pipefail

BASE="http://localhost:7676"
PASS=0
FAIL=0

check() {
    local desc="$1" url="$2" expect_status="$3" expect_body="${4:-}"
    local status body
    status=$(curl -o /tmp/test-body -s -w "%{http_code}" "$url")
    body=$(cat /tmp/test-body)

    if [ "$status" != "$expect_status" ]; then
        echo "FAIL: $desc — expected $expect_status, got $status"
        FAIL=$((FAIL + 1))
        return
    fi

    if [ -n "$expect_body" ] && ! echo "$body" | grep -q "$expect_body"; then
        echo "FAIL: $desc — body missing '$expect_body'"
        FAIL=$((FAIL + 1))
        return
    fi

    echo "PASS: $desc"
    PASS=$((PASS + 1))
}

echo "=== Edge CMS Integration Tests ==="
echo ""

# Reader routes
check "Homepage returns 200" "$BASE/" "200" "edge/cms"
check "Post page returns 200" "$BASE/post/hello-world" "200" "Hello World"
check "Unknown post returns 404" "$BASE/post/nonexistent" "404"
check "Tag page returns 200" "$BASE/tag/fastly" "200"
check "RSS feed returns 200" "$BASE/feed.xml" "200" "<rss"
check "Sitemap returns 200" "$BASE/sitemap.xml" "200" "<urlset"
check "Robots.txt returns 200" "$BASE/robots.txt" "200" "User-agent"
check "CSS returns 200" "$BASE/assets/style.css" "200"

# Cache headers on reader pages
HEADERS=$(curl -sI "$BASE/")
echo "$HEADERS" | grep -q "Surrogate-Control" && echo "PASS: Homepage has Surrogate-Control" && PASS=$((PASS+1)) || (echo "FAIL: Homepage missing Surrogate-Control" && FAIL=$((FAIL+1)))
echo "$HEADERS" | grep -q "Surrogate-Key" && echo "PASS: Homepage has Surrogate-Key" && PASS=$((PASS+1)) || (echo "FAIL: Homepage missing Surrogate-Key" && FAIL=$((FAIL+1)))

# Admin routes
check "Admin login page returns 200" "$BASE/admin/login" "200" "password"
check "Admin without auth redirects" "$BASE/admin" "302"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ] || exit 1
```

- [ ] **Step 2: Run integration tests**

```bash
cd edge-cms/rust
fastly compute build
fastly compute serve &
sleep 3
bash tests/integration.sh
kill %1
```

Expected: all tests pass

- [ ] **Step 3: Commit**

```bash
git add edge-cms/rust/tests/
git commit -m "test(edge-cms): add integration test script for reader and admin routes"
```

---

### Task 22: README with Fastly Skill Documentation

**Files:**
- Create: `edge-cms/README.md`

- [ ] **Step 1: Write comprehensive README**

The README must cover:

1. **What it is**: CMS running entirely on Fastly — no origin servers
2. **Fastly products used**: table from DESIGN.md
3. **Quick start**: clone, create stores, set secrets, deploy
4. **Local development**: `fastly compute serve` with Viceroy
5. **Architecture overview**: data model, routing, caching, auth
6. **Directory structure**: shared assets + per-language implementations
7. **Available implementations**: Rust (done), TypeScript (planned), Go (planned)

**Fastly Skills documentation section** — how each skill was used during development:

```markdown
## Built with Fastly Agent Skills

This project was built using Claude Code with Fastly-specific agent skills.
These skills provide deep product knowledge and automate platform configuration.

### Skills Used

| Skill | Purpose | How It Was Used |
|-------|---------|-----------------|
| `fastly` | CDN platform configuration | Product enablement (Image Optimizer, rate limiting), cache strategy design, Surrogate-Key patterns, Purge API integration, geolocation setup |
| `fastly-cli` | CLI command execution | Store creation (KV, Object, Secret), secret management, service deployment, `fastly.toml` configuration |
| `viceroy` | Local Compute development | Local dev server setup, `fastly.toml` store definitions for testing, integration test execution, backend override configuration |

### Skills Not Used (and Why)

| Skill | Why Not |
|-------|---------|
| `falco` | VCL linting/testing tool — this project uses Compute (Rust/TS/Go), not VCL. No custom VCL was written. |
```

- [ ] **Step 2: Commit**

```bash
git add edge-cms/README.md
git commit -m "docs(edge-cms): add README with architecture overview and Fastly skill documentation"
```

---

### Task 23: JSON-LD Structured Data

**Files:**
- Modify: `edge-cms/shared/templates/post.hbs`

- [ ] **Step 1: Add JSON-LD to post template**

Add to `post.hbs`, inside the article or at the top:

```handlebars
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Article",
  "headline": "{{title}}",
  "description": "{{excerpt}}",
  "author": {
    "@type": "Person",
    "name": "{{author}}"
  },
  "datePublished": "{{created_at}}",
  "dateModified": "{{updated_at}}",
  {{#if featured_image}}
  "image": "{{featured_image}}",
  {{/if}}
  "mainEntityOfPage": {
    "@type": "WebPage",
    "@id": "{{canonical_url}}"
  }
}
</script>
```

- [ ] **Step 2: Verify in browser**

Run: `fastly compute serve`
View source of a post page — confirm valid JSON-LD in `<script>` tag.

- [ ] **Step 3: Commit**

```bash
git add edge-cms/shared/templates/post.hbs
git commit -m "feat(edge-cms): add JSON-LD Article structured data to post pages"
```

---

### Task 24: Rate Limiting on Login

**Files:**
- Modify: `edge-cms/rust/src/handlers/admin.rs`
- Modify: `edge-cms/rust/fastly.toml`

**Fastly skill:** Invoke `fastly` skill for rate limiting product setup and `fastly-cli` for rate counter/penalty box creation.

- [ ] **Step 1: Add rate limiter config to fastly.toml**

Add to `fastly.toml`:
```toml
[setup]
  [setup.rate_counters]
    [setup.rate_counters.login-counter]

  [setup.penalty_boxes]
    [setup.penalty_boxes.login-penalty]
```

- [ ] **Step 2: Add rate limiting to login_submit**

At the top of `login_submit()`, before password validation:

```rust
use fastly::handle::client_ip_addr;

// Rate limit: 5 attempts per minute
let client_ip = client_ip_addr().map(|ip| ip.to_string()).unwrap_or_default();
let rc = fastly::handle::RateCounter::open("login-counter");
let pb = fastly::handle::PenaltyBox::open("login-penalty");

if pb.has(&client_ip) {
    return Ok(Response::from_status(StatusCode::FOUND)
        .with_header("Location", "/admin/login?error=rate"));
}

rc.increment(&client_ip, 1);
if rc.lookup_rate(&client_ip, 60) > 5 {
    pb.add(&client_ip, 60); // 60 second penalty
    return Ok(Response::from_status(StatusCode::FOUND)
        .with_header("Location", "/admin/login?error=rate"));
}
```

Note: Exact API may vary — invoke the `fastly` skill to verify the rate limiter Rust SDK API before implementing.

- [ ] **Step 3: Test rate limiting locally**

Run 6+ rapid login attempts via curl. 6th should get `?error=rate` redirect.

- [ ] **Step 4: Commit**

```bash
git add edge-cms/rust/src/handlers/admin.rs edge-cms/rust/fastly.toml
git commit -m "feat(edge-cms): add rate limiting on admin login (5 attempts/min)"
```

---

### Task 25: Real-Time Log Streaming

**Files:**
- Modify: `edge-cms/rust/fastly.toml`
- Modify: `edge-cms/rust/src/main.rs`

**Fastly skill:** Invoke `fastly-cli` for logging endpoint creation and `fastly` for log streaming product configuration.

- [ ] **Step 1: Add logging config to fastly.toml**

```toml
[local_server.backends]
  [local_server.backends.logging]
    url = "http://127.0.0.1:8888"
```

- [ ] **Step 2: Add request logging to main.rs**

At the end of the `main()` function, before returning the response, add structured logging:

```rust
// Log request details
let log_entry = json!({
    "timestamp": time::OffsetDateTime::now_utc().format(&time::format_description::well_known::Rfc3339).unwrap_or_default(),
    "method": method,
    "path": path,
    "status": resp.get_status().as_u16(),
    "client_ip_hash": {
        use sha2::{Sha256, Digest};
        let ip = req.get_client_ip_addr().map(|ip| ip.to_string()).unwrap_or_default();
        let mut hasher = Sha256::new();
        hasher.update(ip.as_bytes());
        format!("{:x}", hasher.finalize())[..12].to_string()
    },
});

if let Ok(mut endpoint) = fastly::log::Endpoint::from_name("edge-cms-log") {
    let _ = writeln!(endpoint, "{}", log_entry);
}
```

Note: The logging endpoint name in `fastly.toml` must match. On deployment, create the actual logging endpoint via `fastly-cli` pointing to your preferred log drain (S3, BigQuery, Datadog, etc.).

- [ ] **Step 3: Document logging setup in README**

Add section explaining how to configure the logging endpoint for production:
```bash
fastly logging s3 create --name=edge-cms-log --service-id=$SID \
  --bucket-name=my-logs --access-key=$KEY --secret-key=$SECRET
```

- [ ] **Step 4: Commit**

```bash
git add edge-cms/rust/src/main.rs edge-cms/rust/fastly.toml
git commit -m "feat(edge-cms): add structured request logging via real-time log streaming"
```

---

## Self-Review Checklist

After all tasks complete, verify:

- [ ] All reader routes return correct cache headers (Surrogate-Control, Cache-Control, Surrogate-Key)
- [ ] All admin routes return `Cache-Control: private, no-store`
- [ ] Admin routes reject unauthenticated requests with redirect
- [ ] Post CRUD updates both the post entry and the index
- [ ] Cache purge fires on every write operation
- [ ] Error pages render with blog template, not raw text
- [ ] RSS feed, sitemap, and robots.txt all render valid output
- [ ] Integration tests all pass against Viceroy
- [ ] No secrets or service IDs committed — only `.env.example` with placeholders
