use handlebars::{Context, Handlebars, Helper, HelperResult, Output, RenderContext, RenderError};
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::sync::OnceLock;

use crate::config::Ctx;
use crate::models::{SidebarConfig, SidebarItem};
use crate::validation::is_safe_link_url;

static REGISTRY: OnceLock<Handlebars<'static>> = OnceLock::new();

macro_rules! template {
    ($name:expr) => {
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../shared/templates/",
            $name
        ))
    };
}

pub const DEFAULT_DESCRIPTION: &str = "A CMS running entirely on Fastly's edge platform";

// Use handlebars_helper! macro so `eq` returns a boolean value usable in
// {{#if (eq field "value")}} subexpressions. The macro-generated helper
// returns a serde_json::Value which handlebars-rs evaluates for truthiness.
// Takes raw JSON values (not `str`) so a missing/null field — e.g. a sidebar
// link without an icon — compares false instead of erroring (TS: `a === b`).
handlebars::handlebars_helper!(eq_helper: |a: Json, b: Json| a == b);

fn init_registry() -> Handlebars<'static> {
    let mut hbs = Handlebars::new();
    hbs.set_strict_mode(false); // allow missing fields to render as empty

    let templates = [
        ("layout", template!("layout.hbs")),
        ("home", template!("home.hbs")),
        ("post", template!("post.hbs")),
        ("tag", template!("tag.hbs")),
        ("error", template!("error.hbs")),
        ("login", template!("login.hbs")),
        ("admin-dashboard", template!("admin-dashboard.hbs")),
        ("admin-editor", template!("admin-editor.hbs")),
        ("admin-sidebar", template!("admin-sidebar.hbs")),
    ];
    for (name, source) in templates {
        hbs.register_template_string(name, source).expect(name);
    }
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

pub fn render_page(template: &str, data: &Value) -> Result<String, RenderError> {
    let body = registry().render(template, data)?;
    let mut layout_data = data.clone();
    if let Some(obj) = layout_data.as_object_mut() {
        obj.insert("body".into(), Value::String(body));
    }
    registry().render("layout", &layout_data)
}

/// Per-page values behind the layout variables of contract §10.
pub struct PageMeta<'a> {
    pub title: &'a str,
    pub description: &'a str,
    /// Path (plus query for paginated pages) the canonical URL points at.
    pub path: &'a str,
    pub og_type: &'a str,
    pub og_image: Option<&'a str>,
    pub noindex: bool,
    pub is_admin: bool,
}

impl<'a> PageMeta<'a> {
    pub fn public(title: &'a str, description: &'a str, path: &'a str) -> Self {
        Self {
            title,
            description,
            path,
            og_type: "website",
            og_image: None,
            noindex: false,
            is_admin: false,
        }
    }

    pub fn admin(title: &'a str, path: &'a str) -> Self {
        Self {
            title,
            description: "edge/cms administration",
            path,
            og_type: "website",
            og_image: None,
            noindex: true,
            is_admin: true,
        }
    }
}

/// Absolute URL for an image reference, or empty when unusable.
pub fn absolute_url(site_url: &str, url: Option<&str>) -> String {
    match url {
        Some(u) if u.starts_with("https://") || u.starts_with("http://") => u.to_string(),
        Some(u) if u.starts_with('/') && !u.starts_with("//") => format!("{site_url}{u}"),
        _ => String::new(),
    }
}

/// Merge the layout variables every render must carry into `data`.
pub fn with_layout(ctx: &Ctx, meta: &PageMeta, data: Value) -> Value {
    let mut obj = match data {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    let layout = json!({
        "site_url": ctx.site_url,
        "page_title": meta.title,
        "meta_description": meta.description,
        "canonical_url": ctx.absolute(meta.path),
        "og_type": meta.og_type,
        "og_image": absolute_url(&ctx.site_url, meta.og_image),
        "noindex": meta.noindex,
        "asset_version": ctx.asset_version,
        "is_admin": meta.is_admin,
    });
    if let Value::Object(layout) = layout {
        obj.extend(layout);
    }
    Value::Object(obj)
}

/// Sidebar shaped for templates: `is_category`/`is_link` flags, `children_csv`,
/// and links failing the URL rule omitted (render-time defence).
pub fn sidebar_view(sidebar: &SidebarConfig) -> Value {
    let items: Vec<Value> = sidebar
        .items
        .iter()
        .filter_map(|item| match item {
            SidebarItem::Category {
                label,
                slug,
                children,
            } => Some(json!({
                "type": "category",
                "label": label,
                "slug": slug,
                "children": children,
                "children_csv": children.join(","),
                "is_category": true,
                "is_link": false,
            })),
            SidebarItem::Link { label, url, icon } => is_safe_link_url(url).then(|| {
                json!({
                    "type": "link",
                    "label": label,
                    "url": url,
                    "icon": icon,
                    "is_category": false,
                    "is_link": true,
                })
            }),
        })
        .collect();
    json!({ "items": items })
}

/// `encodeURIComponent` semantics: everything except `A-Z a-z 0-9 - _ . ! ~ * ' ( )`.
pub fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Serialise JSON for embedding inside `<script type="application/ld+json">`.
pub fn script_safe_json(v: &Value) -> String {
    v.to_string().replace("</", "<\\/")
}

// format_date: convert "2026-05-20T14:30:00Z" -> "May 20, 2026"
fn format_date_helper(
    h: &Helper,
    _: &Handlebars,
    _: &Context,
    _: &mut RenderContext,
    out: &mut dyn Output,
) -> HelperResult {
    let date_str = h.param(0).and_then(|v| v.value().as_str()).unwrap_or("");
    let parts: Vec<&str> = date_str.get(..10).unwrap_or("").split('-').collect();
    if parts.len() == 3 {
        let month = match parts[1] {
            "01" => "Jan",
            "02" => "Feb",
            "03" => "Mar",
            "04" => "Apr",
            "05" => "May",
            "06" => "Jun",
            "07" => "Jul",
            "08" => "Aug",
            "09" => "Sep",
            "10" => "Oct",
            "11" => "Nov",
            "12" => "Dec",
            _ => "???",
        };
        let day: u32 = parts[2].parse().unwrap_or(0);
        out.write(&format!("{} {}, {}", month, day, parts[0]))?;
        return Ok(());
    }
    out.write(&handlebars::html_escape(date_str))?;
    Ok(())
}

// reading_time: estimate minutes from word count (200 wpm, min 1)
fn reading_time_helper(
    h: &Helper,
    _: &Handlebars,
    _: &Context,
    _: &mut RenderContext,
    out: &mut dyn Output,
) -> HelperResult {
    let content = h.param(0).and_then(|v| v.value().as_str()).unwrap_or("");
    let minutes = (content.split_whitespace().count() / 200).max(1);
    out.write(&minutes.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn render_eq(data: Value) -> String {
        let mut hbs = Handlebars::new();
        hbs.set_strict_mode(false);
        hbs.register_helper("eq", Box::new(eq_helper));
        hbs.render_template(r#"{{#if (eq icon "github")}}Y{{else}}N{{/if}}"#, &data)
            .expect("eq must not error")
    }

    fn ctx() -> Ctx {
        Ctx {
            site_url: "https://blog.example.com".into(),
            client_ip: None,
            asset_version: "42".into(),
        }
    }

    #[test]
    fn eq_matches_string() {
        assert_eq!(render_eq(json!({"icon": "github"})), "Y");
    }

    #[test]
    fn eq_non_matching_string() {
        assert_eq!(render_eq(json!({"icon": "book"})), "N");
    }

    #[test]
    fn eq_missing_field_does_not_error() {
        assert_eq!(render_eq(json!({"label": "x"})), "N");
    }

    #[test]
    fn eq_null_field_does_not_error() {
        assert_eq!(render_eq(json!({"icon": null})), "N");
    }

    #[test]
    fn layout_vars_present_and_absolute() {
        let meta = PageMeta {
            og_type: "article",
            og_image: Some("/images/a/b.jpg"),
            ..PageMeta::public("T", "D", "/post/a")
        };
        let v = with_layout(&ctx(), &meta, json!({"posts": []}));
        assert_eq!(v["site_url"], "https://blog.example.com");
        assert_eq!(v["page_title"], "T");
        assert_eq!(v["meta_description"], "D");
        assert_eq!(v["canonical_url"], "https://blog.example.com/post/a");
        assert_eq!(v["og_type"], "article");
        assert_eq!(v["og_image"], "https://blog.example.com/images/a/b.jpg");
        assert_eq!(v["noindex"], false);
        assert_eq!(v["asset_version"], "42");
        assert_eq!(v["is_admin"], false);
        assert!(v.get("posts").is_some());
        for removed in [
            "og_url",
            "og_title",
            "og_description",
            "pop_city",
            "pop_code",
        ] {
            assert!(v.get(removed).is_none(), "{removed}");
        }
    }

    #[test]
    fn admin_meta_is_noindex() {
        let v = with_layout(&ctx(), &PageMeta::admin("A", "/admin"), json!({}));
        assert_eq!(v["noindex"], true);
        assert_eq!(v["is_admin"], true);
        assert_eq!(v["og_image"], "");
    }

    #[test]
    fn absolute_url_rules() {
        let s = "https://x.com";
        assert_eq!(absolute_url(s, Some("/a.jpg")), "https://x.com/a.jpg");
        assert_eq!(
            absolute_url(s, Some("https://cdn/a.jpg")),
            "https://cdn/a.jpg"
        );
        assert_eq!(absolute_url(s, Some("//evil/a.jpg")), "");
        assert_eq!(absolute_url(s, Some("javascript:x")), "");
        assert_eq!(absolute_url(s, None), "");
    }

    #[test]
    fn sidebar_view_shapes_items_and_drops_unsafe_links() {
        let sidebar: SidebarConfig = serde_json::from_value(json!({"items": [
            {"type": "category", "label": "C", "slug": "c", "children": ["a", "b"]},
            {"type": "link", "label": "L", "url": "https://x.com", "icon": "github"},
            {"type": "link", "label": "Bad", "url": "javascript:alert(1)"}
        ]}))
        .unwrap();
        let v = sidebar_view(&sidebar);
        let items = v["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["children_csv"], "a,b");
        assert_eq!(items[0]["is_category"], true);
        assert_eq!(items[0]["is_link"], false);
        assert_eq!(items[1]["is_link"], true);
        assert_eq!(items[1]["icon"], "github");
    }

    #[test]
    fn percent_encoding() {
        assert_eq!(
            percent_encode("https://x.com/post/a b?q=1&r=é"),
            "https%3A%2F%2Fx.com%2Fpost%2Fa%20b%3Fq%3D1%26r%3D%C3%A9"
        );
        assert_eq!(percent_encode("It's (ok)!*~"), "It's%20(ok)!*~");
    }

    #[test]
    fn json_ld_cannot_break_out_of_script() {
        let v = json!({"headline": "</script><script>alert(1)</script>"});
        let s = script_safe_json(&v);
        assert!(!s.contains("</"));
        let back: Value = serde_json::from_str(&s).unwrap();
        assert_eq!(back, v);
    }
}
