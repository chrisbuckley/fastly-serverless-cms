use fastly::http::StatusCode;
use fastly::{Error, Request, Response};
use serde_json::{json, Value};

use crate::cache;
use crate::config::{self, Ctx};
use crate::dates;
use crate::error;
use crate::kv;
use crate::markdown;
use crate::models::{Post, PostMeta, PostStatus};
use crate::pagination;
use crate::templates::{self, PageMeta, DEFAULT_DESCRIPTION};
use crate::validation::{is_valid_slug, is_valid_tag};

const SITE_NAME: &str = "edge/cms";
const FEED_ITEMS: usize = 20;

/// Real-time edge info — returns the Compute POP and nothing else.
/// Responds with Cache-Control: no-store so the VCL CDN never caches it.
/// Client JS reads the VCL edge POP from the X-Served-By response header.
pub fn edge_info() -> Result<Response, Error> {
    let pop = std::env::var("FASTLY_POP").unwrap_or_else(|_| "local".to_string());
    Ok(Response::from_status(StatusCode::OK)
        .with_header("Content-Type", "application/json")
        .with_header("Cache-Control", "no-store")
        .with_header("Surrogate-Control", "no-store")
        .with_body(json!({ "pop": pop }).to_string()))
}

fn html(body: String) -> Response {
    Response::from_status(StatusCode::OK)
        .with_header("Content-Type", "text/html; charset=utf-8")
        .with_body(body)
}

/// XML-escape a string for safe inclusion in RSS/XML output.
fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// Shared listing render for home and tag pages.
struct Listing<'a> {
    template: &'a str,
    base: &'a str,
    title: &'a str,
    description: &'a str,
    posts: Vec<&'a PostMeta>,
    all_tags: Vec<String>,
    extra: Value,
    keys: Vec<String>,
}

fn render_listing(req: &Request, ctx: &Ctx, listing: Listing) -> Result<Response, Error> {
    let sidebar = kv::read_sidebar(&kv::content()?)?;
    let Some(page) = pagination::paginate(
        listing.posts.len(),
        config::page_size(),
        req.get_query_parameter("page"),
    ) else {
        return Ok(error::not_found(ctx, listing.base));
    };
    let canonical = pagination::canonical_path(listing.base, page.page);

    let mut data = json!({
        "posts": &listing.posts[page.start..page.end],
        "sidebar": templates::sidebar_view(&sidebar),
        "all_tags": listing.all_tags,
        "pagination": pagination::to_json(listing.base, &page),
    });
    if let (Some(obj), Value::Object(extra)) = (data.as_object_mut(), listing.extra) {
        obj.extend(extra);
    }
    let meta = PageMeta::public(listing.title, listing.description, &canonical);
    let body = templates::render_page(listing.template, &templates::with_layout(ctx, &meta, data))?;
    let keys: Vec<&str> = listing.keys.iter().map(String::as_str).collect();
    Ok(cache::page(html(body), &keys))
}

pub fn home(req: &Request, ctx: &Ctx) -> Result<Response, Error> {
    let index = kv::read_index(&kv::content()?)?;
    render_listing(
        req,
        ctx,
        Listing {
            template: "home",
            base: "/",
            title: "Home",
            description: DEFAULT_DESCRIPTION,
            posts: index.published(),
            all_tags: index.all_tags(),
            extra: json!({}),
            keys: vec!["post-index".into(), "sidebar".into()],
        },
    )
}

pub fn tag(req: &Request, ctx: &Ctx, tag_name: &str) -> Result<Response, Error> {
    let base = format!("/tag/{tag_name}");
    if !is_valid_tag(tag_name) {
        return Ok(error::not_found(ctx, &base));
    }
    let index = kv::read_index(&kv::content()?)?;
    let title = format!("Posts tagged \"{tag_name}\"");
    render_listing(
        req,
        ctx,
        Listing {
            template: "tag",
            base: &base,
            title: &title,
            description: &title,
            posts: index.by_tag(tag_name),
            all_tags: index.all_tags(),
            extra: json!({ "tag": tag_name }),
            keys: vec![
                "post-index".into(),
                "sidebar".into(),
                format!("tag-{tag_name}"),
            ],
        },
    )
}

/// schema.org `BlogPosting` for the post page.
pub fn json_ld(post: &Post, canonical_url: &str, image_url: &str) -> Value {
    let mut ld = json!({
        "@context": "https://schema.org",
        "@type": "BlogPosting",
        "headline": post.title,
        "description": post.excerpt,
        "datePublished": post.created_at,
        "dateModified": post.updated_at,
        "author": { "@type": "Person", "name": post.author },
        "mainEntityOfPage": canonical_url,
        "publisher": { "@type": "Organization", "name": SITE_NAME },
    });
    if !image_url.is_empty() {
        ld["image"] = Value::String(image_url.to_string());
    }
    ld
}

pub fn post(ctx: &Ctx, slug: &str) -> Result<Response, Error> {
    let path = format!("/post/{slug}");
    if !is_valid_slug(slug) {
        return Ok(error::not_found(ctx, &path));
    }
    let store = kv::content()?;
    let post = match kv::get_json::<Post>(&store, &kv::post_key(slug))? {
        Some(p) if p.status == PostStatus::Published => p,
        _ => return Ok(error::not_found(ctx, &path)),
    };

    let index = kv::read_index(&store)?;
    let sidebar = kv::read_sidebar(&store)?;
    let canonical_url = ctx.absolute(&path);
    let image_url = templates::absolute_url(&ctx.site_url, post.featured_image.as_deref());
    let description = if post.excerpt.trim().is_empty() {
        DEFAULT_DESCRIPTION
    } else {
        post.excerpt.as_str()
    };

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
        "rendered_content": markdown::render_post_html(&post.content),
        "json_ld": templates::script_safe_json(&json_ld(&post, &canonical_url, &image_url)),
        "share_url_encoded": templates::percent_encode(&canonical_url),
        "share_title_encoded": templates::percent_encode(&post.title),
        "sidebar": templates::sidebar_view(&sidebar),
        "all_tags": index.all_tags(),
    });
    let meta = PageMeta {
        og_type: "article",
        og_image: post.featured_image.as_deref(),
        ..PageMeta::public(&post.title, description, &path)
    };
    let body = templates::render_page("post", &templates::with_layout(ctx, &meta, data))?;
    let post_key = format!("post-{slug}");
    Ok(cache::page(html(body), &[&post_key, "sidebar"]))
}

pub fn build_feed(site_url: &str, posts: &[&PostMeta], now: u64) -> String {
    let last_build = posts
        .iter()
        .filter_map(|p| dates::rfc822(p.last_modified()))
        .next()
        .unwrap_or_else(|| dates::rfc822_from_unix(now));
    let mut xml = format!(
        concat!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n",
            "<rss version=\"2.0\" xmlns:atom=\"http://www.w3.org/2005/Atom\">\n",
            "<channel>\n",
            "  <title>{name}</title>\n",
            "  <description>{desc}</description>\n",
            "  <link>{site}/</link>\n",
            "  <atom:link href=\"{site}/feed.xml\" rel=\"self\" type=\"application/rss+xml\"/>\n",
            "  <lastBuildDate>{build}</lastBuildDate>\n",
        ),
        name = xml_escape(SITE_NAME),
        desc = xml_escape(DEFAULT_DESCRIPTION),
        site = xml_escape(site_url),
        build = last_build,
    );
    for post in posts {
        let link = xml_escape(&format!("{site_url}/post/{}", post.slug));
        xml.push_str("  <item>\n");
        xml.push_str(&format!("    <title>{}</title>\n", xml_escape(&post.title)));
        xml.push_str(&format!("    <link>{link}</link>\n"));
        xml.push_str(&format!("    <guid isPermaLink=\"true\">{link}</guid>\n"));
        xml.push_str(&format!(
            "    <description>{}</description>\n",
            xml_escape(&post.excerpt)
        ));
        if let Some(date) = dates::rfc822(&post.created_at) {
            xml.push_str(&format!("    <pubDate>{date}</pubDate>\n"));
        }
        xml.push_str("  </item>\n");
    }
    xml.push_str("</channel>\n</rss>\n");
    xml
}

pub fn feed(ctx: &Ctx) -> Result<Response, Error> {
    let index = kv::read_index(&kv::content()?)?;
    let published = index.published();
    let items = &published[..published.len().min(FEED_ITEMS)];
    let resp = Response::from_status(StatusCode::OK)
        .with_header("Content-Type", "application/rss+xml; charset=utf-8")
        .with_body(build_feed(&ctx.site_url, items, dates::unix_now()));
    Ok(cache::feed(resp))
}

pub fn build_sitemap(site_url: &str, posts: &[&PostMeta], tags: &[String]) -> String {
    let url = |loc: &str, lastmod: Option<&str>| {
        let mut s = format!("  <url>\n    <loc>{}</loc>\n", xml_escape(loc));
        if let Some(m) = lastmod {
            s.push_str(&format!("    <lastmod>{}</lastmod>\n", xml_escape(m)));
        }
        s.push_str("  </url>\n");
        s
    };
    let mut xml = String::from(concat!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n",
        "<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n",
    ));
    xml.push_str(&url(&format!("{site_url}/"), None));
    for tag in tags {
        xml.push_str(&url(&format!("{site_url}/tag/{tag}"), None));
    }
    for post in posts {
        xml.push_str(&url(
            &format!("{site_url}/post/{}", post.slug),
            Some(post.last_modified()),
        ));
    }
    xml.push_str("</urlset>\n");
    xml
}

pub fn sitemap(ctx: &Ctx) -> Result<Response, Error> {
    let index = kv::read_index(&kv::content()?)?;
    let resp = Response::from_status(StatusCode::OK)
        .with_header("Content-Type", "application/xml; charset=utf-8")
        .with_body(build_sitemap(
            &ctx.site_url,
            &index.published(),
            &index.all_tags(),
        ));
    Ok(cache::feed(resp))
}

pub fn robots_txt(site_url: &str) -> String {
    format!("User-agent: *\nDisallow: /admin\nDisallow: /api/\nSitemap: {site_url}/sitemap.xml\n")
}

pub fn robots(ctx: &Ctx) -> Result<Response, Error> {
    let resp = Response::from_status(StatusCode::OK)
        .with_header("Content-Type", "text/plain; charset=utf-8")
        .with_body(robots_txt(&ctx.site_url));
    Ok(cache::feed(resp))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SITE: &str = "https://blog.example.com";

    fn meta(slug: &str, title: &str, updated: Option<&str>) -> PostMeta {
        PostMeta {
            slug: slug.into(),
            title: title.into(),
            excerpt: "x & y".into(),
            status: PostStatus::Published,
            created_at: "2026-05-20T14:30:00Z".into(),
            updated_at: updated.map(Into::into),
            tags: vec![],
            featured_image: None,
        }
    }

    #[test]
    fn robots_content() {
        assert_eq!(
            robots_txt(SITE),
            "User-agent: *\nDisallow: /admin\nDisallow: /api/\nSitemap: https://blog.example.com/sitemap.xml\n"
        );
    }

    #[test]
    fn feed_is_absolute_escaped_and_rfc822() {
        let p = meta("a", "<b>Tom & Jerry</b>", Some("2026-06-01T08:00:00Z"));
        let xml = build_feed(SITE, &[&p], 0);
        assert!(xml.contains("<link>https://blog.example.com/post/a</link>"));
        assert!(xml.contains("<title>&lt;b&gt;Tom &amp; Jerry&lt;/b&gt;</title>"));
        assert!(xml.contains("<description>x &amp; y</description>"));
        assert!(xml.contains("<pubDate>Wed, 20 May 2026 14:30:00 +0000</pubDate>"));
        assert!(xml.contains("<lastBuildDate>Mon, 01 Jun 2026 08:00:00 +0000</lastBuildDate>"));
        assert!(xml.contains(
            r#"<atom:link href="https://blog.example.com/feed.xml" rel="self" type="application/rss+xml"/>"#
        ));
        assert!(xml.contains(r#"xmlns:atom="http://www.w3.org/2005/Atom""#));
    }

    #[test]
    fn feed_empty_uses_now_for_last_build() {
        let xml = build_feed(SITE, &[], 0);
        assert!(xml.contains("<lastBuildDate>Thu, 01 Jan 1970 00:00:00 +0000</lastBuildDate>"));
    }

    #[test]
    fn sitemap_absolute_with_lastmod_fallback() {
        let a = meta("a", "A", Some("2026-06-01T08:00:00Z"));
        let b = meta("b", "B", None);
        let xml = build_sitemap(SITE, &[&a, &b], &["rust".to_string()]);
        assert!(xml.contains("<loc>https://blog.example.com/</loc>"));
        assert!(xml.contains("<loc>https://blog.example.com/tag/rust</loc>"));
        assert!(xml.contains("<loc>https://blog.example.com/post/a</loc>\n    <lastmod>2026-06-01T08:00:00Z</lastmod>"));
        assert!(xml.contains("<loc>https://blog.example.com/post/b</loc>\n    <lastmod>2026-05-20T14:30:00Z</lastmod>"));
    }

    #[test]
    fn json_ld_shape() {
        let post = Post {
            slug: "a".into(),
            title: "T".into(),
            content: String::new(),
            excerpt: "E".into(),
            status: PostStatus::Published,
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-02T00:00:00Z".into(),
            tags: vec![],
            featured_image: None,
            author: "Admin".into(),
        };
        let ld = json_ld(&post, "https://x/post/a", "https://x/images/a.jpg");
        assert_eq!(ld["@type"], "BlogPosting");
        assert_eq!(ld["headline"], "T");
        assert_eq!(ld["description"], "E");
        assert_eq!(ld["datePublished"], "2026-01-01T00:00:00Z");
        assert_eq!(ld["dateModified"], "2026-01-02T00:00:00Z");
        assert_eq!(ld["author"]["name"], "Admin");
        assert_eq!(ld["image"], "https://x/images/a.jpg");
        assert_eq!(ld["mainEntityOfPage"], "https://x/post/a");
        assert_eq!(ld["publisher"]["name"], "edge/cms");
        assert!(json_ld(&post, "u", "").get("image").is_none());
    }
}
