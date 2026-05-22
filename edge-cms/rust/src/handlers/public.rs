use fastly::http::StatusCode;
use fastly::kv_store::KVStoreError;
use fastly::{Error, KVStore, Request, Response};
use serde_json::json;

use crate::cache::CacheHeaders;
use crate::markdown;
use crate::models::{Post, PostIndex, PostStatus, SidebarConfig};
use crate::templates;

pub(crate) fn read_index() -> Result<PostIndex, Error> {
    let store = KVStore::open("content")?.ok_or_else(|| Error::msg("content store not found"))?;
    match store.lookup("_index") {
        Ok(mut resp) => {
            let json = resp.take_body().into_string();
            Ok(serde_json::from_str(&json)?)
        }
        Err(KVStoreError::ItemNotFound) => Ok(PostIndex { posts: vec![] }),
        Err(e) => Err(e.into()),
    }
}

pub(crate) fn read_sidebar() -> Result<SidebarConfig, Error> {
    let store = KVStore::open("content")?.ok_or_else(|| Error::msg("content store not found"))?;
    match store.lookup("_sidebar") {
        Ok(mut resp) => {
            let json = resp.take_body().into_string();
            Ok(serde_json::from_str(&json)?)
        }
        Err(KVStoreError::ItemNotFound) => Ok(SidebarConfig { items: vec![] }),
        Err(e) => Err(e.into()),
    }
}

/// Real-time edge info — returns the Compute POP and nothing else.
/// Responds with Cache-Control: no-store so the VCL CDN never caches it.
/// Client JS reads the VCL edge POP from the X-Served-By response header.
pub fn edge_info(_req: &Request) -> Result<Response, Error> {
    let pop = std::env::var("FASTLY_POP").unwrap_or_else(|_| "local".to_string());
    Ok(Response::from_status(StatusCode::OK)
        .with_header("Content-Type", "application/json")
        .with_header("Cache-Control", "no-store")
        .with_header("Surrogate-Control", "no-store")
        .with_body(json!({ "pop": pop }).to_string()))
}

/// Extract city and POP code from the client's IP via Fastly geo lookup.
fn geo_context(req: &Request) -> (String, String) {
    req.get_client_ip_addr()
        .and_then(fastly::geo::geo_lookup)
        .map(|geo| {
            let city = geo.city().to_string();
            let city = if city.is_empty() || city == "?" {
                "Edge".to_string()
            } else {
                city
            };
            let code = geo.as_name().to_string();
            let code = if code.is_empty() || code == "?" {
                "CDN".to_string()
            } else {
                code
            };
            (city, code)
        })
        .unwrap_or_else(|| ("Edge".into(), "CDN".into()))
}

/// XML-escape a string for safe inclusion in RSS/XML output.
fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

// ---------------------------------------------------------------------------
// Reader-facing route handlers
// ---------------------------------------------------------------------------

pub fn home(req: &Request) -> Result<Response, Error> {
    let index = read_index()?;
    let sidebar = read_sidebar()?;
    let (pop_city, pop_code) = geo_context(req);

    let published: Vec<_> = index.published().into_iter().cloned().collect();

    let data = json!({
        "posts": published,
        "sidebar": sidebar,
        "pop_city": pop_city,
        "pop_code": pop_code,
    });

    let html = templates::render_page("home", &data)?;
    let resp = Response::from_status(StatusCode::OK)
        .with_header("Content-Type", "text/html; charset=utf-8")
        .with_body(html);

    Ok(CacheHeaders::reader(vec!["post-index", "sidebar"]).apply(resp))
}

pub fn post(req: &Request, slug: &str) -> Result<Response, Error> {
    let store = KVStore::open("content")?.ok_or_else(|| Error::msg("content store not found"))?;
    let key = format!("post:{}", slug);

    let post: Post = match store.lookup(&key) {
        Ok(mut resp) => {
            let json = resp.take_body().into_string();
            serde_json::from_str(&json)?
        }
        Err(KVStoreError::ItemNotFound) => {
            return crate::error::not_found();
        }
        Err(e) => return Err(e.into()),
    };

    // Draft posts are not publicly visible
    if post.status == PostStatus::Draft {
        return crate::error::not_found();
    }

    let sidebar = read_sidebar()?;
    let (pop_city, pop_code) = geo_context(req);
    let rendered_content = markdown::rewrite_images(&markdown::render_markdown(&post.content));
    let canonical_url = format!("/post/{}", slug);

    let data = json!({
        "slug": post.slug,
        "title": post.title,
        "content": post.content,
        "excerpt": post.excerpt,
        "created_at": post.created_at,
        "updated_at": post.updated_at,
        "tags": post.tags,
        "featured_image": post.featured_image,
        "author": post.author,
        "rendered_content": rendered_content,
        "canonical_url": canonical_url,
        "page_title": post.title,
        "og_title": post.title,
        "og_description": post.excerpt,
        "og_type": "article",
        "og_image": post.featured_image,
        "og_url": canonical_url,
        "sidebar": sidebar,
        "pop_city": pop_city,
        "pop_code": pop_code,
    });

    let html = templates::render_page("post", &data)?;
    let surrogate_key = format!("post-{}", slug);
    let resp = Response::from_status(StatusCode::OK)
        .with_header("Content-Type", "text/html; charset=utf-8")
        .with_body(html);

    Ok(CacheHeaders::reader(vec![&surrogate_key, "sidebar"]).apply(resp))
}

pub fn tag(req: &Request, tag_name: &str) -> Result<Response, Error> {
    let index = read_index()?;
    let sidebar = read_sidebar()?;
    let (pop_city, pop_code) = geo_context(req);

    let filtered: Vec<_> = index.by_tag(tag_name).into_iter().cloned().collect();

    let data = json!({
        "tag": tag_name,
        "posts": filtered,
        "sidebar": sidebar,
        "pop_city": pop_city,
        "pop_code": pop_code,
        "page_title": format!("Posts tagged \"{}\"", tag_name),
    });

    let html = templates::render_page("tag", &data)?;
    let resp = Response::from_status(StatusCode::OK)
        .with_header("Content-Type", "text/html; charset=utf-8")
        .with_body(html);

    Ok(CacheHeaders::reader(vec!["post-index", "sidebar"]).apply(resp))
}

pub fn feed(_req: &Request) -> Result<Response, Error> {
    let index = read_index()?;
    let published: Vec<_> = index.published();
    let items: Vec<_> = published.into_iter().take(20).collect();

    let mut xml = String::from(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title>edge/cms</title>
  <description>A CMS running entirely on Fastly Compute</description>
  <link>/</link>
"#,
    );

    for post in &items {
        xml.push_str("  <item>\n");
        xml.push_str(&format!("    <title>{}</title>\n", xml_escape(&post.title)));
        xml.push_str(&format!("    <link>/post/{}</link>\n", post.slug));
        xml.push_str(&format!(
            "    <guid isPermaLink=\"true\">/post/{}</guid>\n",
            post.slug
        ));
        xml.push_str(&format!(
            "    <description>{}</description>\n",
            xml_escape(&post.excerpt)
        ));
        xml.push_str(&format!("    <pubDate>{}</pubDate>\n", post.created_at));
        xml.push_str("  </item>\n");
    }

    xml.push_str("</channel>\n</rss>\n");

    let resp = Response::from_status(StatusCode::OK)
        .with_header("Content-Type", "application/rss+xml; charset=utf-8")
        .with_body(xml);

    Ok(CacheHeaders::reader(vec!["post-index"]).apply(resp))
}

pub fn sitemap(_req: &Request) -> Result<Response, Error> {
    let index = read_index()?;
    let published = index.published();

    let mut xml = String::from(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>/</loc>
  </url>
"#,
    );

    for post in &published {
        xml.push_str("  <url>\n");
        xml.push_str(&format!("    <loc>/post/{}</loc>\n", post.slug));
        xml.push_str(&format!(
            "    <lastmod>{}</lastmod>\n",
            &post.created_at[..10]
        ));
        xml.push_str("  </url>\n");
    }

    xml.push_str("</urlset>\n");

    let resp = Response::from_status(StatusCode::OK)
        .with_header("Content-Type", "application/xml; charset=utf-8")
        .with_body(xml);

    Ok(CacheHeaders::reader(vec!["post-index"]).apply(resp))
}

pub fn robots() -> Result<Response, Error> {
    let body = "User-agent: *\nAllow: /\nSitemap: /sitemap.xml\n";
    Ok(Response::from_status(StatusCode::OK)
        .with_header("Content-Type", "text/plain; charset=utf-8")
        .with_body(body))
}
