use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use ammonia::Builder;
use pulldown_cmark::{html, Options, Parser};

const ALLOWED_TAGS: [&str; 37] = [
    "p",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "a",
    "img",
    "ul",
    "ol",
    "li",
    "blockquote",
    "pre",
    "code",
    "em",
    "strong",
    "del",
    "s",
    "table",
    "thead",
    "tbody",
    "tr",
    "th",
    "td",
    "hr",
    "br",
    "sup",
    "sub",
    "details",
    "summary",
    "figure",
    "figcaption",
    "span",
    "div",
    "input",
    "iframe",
];

const IFRAME_HOSTS: [&str; 3] = [
    "www.youtube-nocookie.com",
    "www.youtube.com",
    "player.vimeo.com",
];

/// Markdown → HTML (GFM tables, strikethrough, task lists) → allowlist sanitize
/// → responsive image rewrite. This is the only path user content takes to HTML.
pub fn render_post_html(input: &str) -> String {
    rewrite_images(&sanitize(&render_markdown(input)))
}

pub fn render_markdown(input: &str) -> String {
    let mut options = Options::empty();
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_TASKLISTS);
    let parser = Parser::new_ext(input, options);
    let mut output = String::new();
    html::push_html(&mut output, parser);
    output
}

/// `language-[a-z0-9+-]+`
fn is_language_class(v: &str) -> bool {
    v.strip_prefix("language-").is_some_and(|lang| {
        !lang.is_empty()
            && lang
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'+' || b == b'-')
    })
}

fn is_allowed_iframe_src(src: &str) -> bool {
    src.strip_prefix("https://").is_some_and(|rest| {
        let host = rest.split(['/', '?', '#']).next().unwrap_or("");
        IFRAME_HOSTS.contains(&host)
    })
}

fn attribute_filter<'u>(element: &str, attribute: &str, value: &'u str) -> Option<Cow<'u, str>> {
    let keep = match (element, attribute) {
        (_, "class") => is_language_class(value),
        ("th" | "td", "align") => matches!(value, "left" | "center" | "right"),
        ("iframe", "src") => is_allowed_iframe_src(value),
        _ => true,
    };
    keep.then_some(Cow::Borrowed(value))
}

fn sanitizer() -> &'static Builder<'static> {
    static BUILDER: OnceLock<Builder<'static>> = OnceLock::new();
    BUILDER.get_or_init(|| {
        let tag_attributes: HashMap<&str, HashSet<&str>> = [
            ("a", &["href", "title"][..]),
            ("img", &["src", "alt", "title", "width", "height"]),
            ("code", &["class"]),
            ("pre", &["class"]),
            ("span", &["class"]),
            ("div", &["class"]),
            ("th", &["align"]),
            ("td", &["align"]),
            ("input", &["checked"]),
            (
                "iframe",
                &[
                    "src",
                    "width",
                    "height",
                    "title",
                    "allow",
                    "allowfullscreen",
                ],
            ),
        ]
        .into_iter()
        .map(|(tag, attrs)| (tag, attrs.iter().copied().collect()))
        .collect();

        let mut b = Builder::default();
        b.tags(ALLOWED_TAGS.into_iter().collect())
            .clean_content_tags(["script", "style"].into_iter().collect())
            .tag_attributes(tag_attributes)
            .generic_attributes(HashSet::new())
            .generic_attribute_prefixes(HashSet::new())
            .url_schemes(["http", "https", "mailto"].into_iter().collect())
            .link_rel(None)
            .strip_comments(true)
            .set_tag_attribute_value("input", "type", "checkbox")
            .set_tag_attribute_value("input", "disabled", "")
            .attribute_filter(attribute_filter);
        b
    })
}

/// Allowlist sanitizer (contract §11).
pub fn sanitize(html: &str) -> String {
    add_external_link_rel(&drop_unsourced_iframes(
        &sanitizer().clean(html).to_string(),
    ))
}

/// End index (exclusive) of the tag starting at `start`, honouring quoted
/// attribute values so a `>` inside a value doesn't end the tag.
fn tag_end(s: &str, start: usize) -> Option<usize> {
    let mut in_quote = false;
    for (i, b) in s.bytes().enumerate().skip(start) {
        match b {
            b'"' => in_quote = !in_quote,
            b'>' if !in_quote => return Some(i + 1),
            _ => {}
        }
    }
    None
}

/// Ammonia can strip an attribute but not the element carrying it, so an
/// iframe whose `src` failed the host allowlist is removed here. Input is
/// ammonia's normalised serialisation (`<iframe ...></iframe>`).
fn drop_unsourced_iframes(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut rest = html;
    while let Some(start) = rest.find("<iframe") {
        out.push_str(&rest[..start]);
        let Some(open_end) = tag_end(rest, start) else {
            return out;
        };
        let close = rest[open_end..]
            .find("</iframe>")
            .map(|i| open_end + i + "</iframe>".len())
            .unwrap_or(rest.len());
        if rest[start..open_end].contains(" src=\"") {
            out.push_str(&rest[start..close]);
        }
        rest = &rest[close..];
    }
    out.push_str(rest);
    out
}

/// Add `rel="noopener noreferrer"` to absolute http(s) links only.
fn add_external_link_rel(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut rest = html;
    while let Some(start) = rest.find("<a ") {
        let Some(end) = tag_end(rest, start) else {
            break;
        };
        let tag = &rest[start..end];
        out.push_str(&rest[..start]);
        if tag.contains(" href=\"http://") || tag.contains(" href=\"https://") {
            out.push_str(&tag[..tag.len() - 1]);
            out.push_str(" rel=\"noopener noreferrer\">");
        } else {
            out.push_str(tag);
        }
        rest = &rest[end..];
    }
    out.push_str(rest);
    out
}

fn attr_value<'a>(tag: &'a str, name: &str) -> &'a str {
    let needle = format!(" {name}=\"");
    tag.find(&needle)
        .map(|i| {
            let v = &tag[i + needle.len()..];
            &v[..v.find('"').unwrap_or(v.len())]
        })
        .unwrap_or("")
}

/// Ammonia leaves `<`/`>` unescaped inside attribute values; re-escape before
/// placing them into generated markup.
fn escape_attr(v: &str) -> String {
    v.replace('<', "&lt;").replace('>', "&gt;")
}

/// Rewrites `<img src="/images/...">` tags in sanitized HTML to `<picture srcset>`
/// elements with 480w/800w/1280w WebP variants served via Fastly Image Optimizer.
/// Non-`/images/` src values are left unchanged.
pub fn rewrite_images(html: &str) -> String {
    let mut out = String::with_capacity(html.len() * 2);
    let mut rest = html;
    while let Some(start) = rest.find("<img ") {
        let Some(end) = tag_end(rest, start) else {
            break;
        };
        let tag = &rest[start..end];
        out.push_str(&rest[..start]);
        let src = attr_value(tag, "src");
        if src.starts_with("/images/") {
            out.push_str(&responsive_picture(
                &escape_attr(src),
                &escape_attr(attr_value(tag, "alt")),
            ));
        } else {
            out.push_str(tag);
        }
        rest = &rest[end..];
    }
    out.push_str(rest);
    out
}

fn responsive_picture(src: &str, alt: &str) -> String {
    format!(
        concat!(
            "<picture>",
            r#"<source type="image/webp" "#,
            r#"srcset="{src}?width=480&format=webp 480w, "#,
            r#"{src}?width=800&format=webp 800w, "#,
            r#"{src}?width=1280&format=webp 1280w" "#,
            r#"sizes="(max-width: 640px) 100vw, 680px">"#,
            r#"<img alt="{alt}" src="{src}?width=680" loading="lazy">"#,
            "</picture>",
        ),
        src = src,
        alt = alt,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_heading() {
        assert!(render_markdown("# Hello").contains("<h1>Hello</h1>"));
    }

    #[test]
    fn renders_bold_and_italic() {
        let html = render_markdown("**bold** and *italic*");
        assert!(html.contains("<strong>bold</strong>"));
        assert!(html.contains("<em>italic</em>"));
    }

    #[test]
    fn renders_code_block() {
        let html = render_markdown("```rust\nfn main() {}\n```");
        assert!(html.contains("<code"));
        assert!(html.contains("fn main() {}"));
    }

    #[test]
    fn renders_list() {
        let html = render_markdown("- one\n- two");
        assert!(html.contains("<li>one</li>"));
    }

    #[test]
    fn renders_image() {
        let html = render_markdown("![Alt](/img.jpg)");
        assert!(html.contains("src=\"/img.jpg\""));
        assert!(html.contains("alt=\"Alt\""));
    }

    #[test]
    fn empty_input() {
        assert_eq!(render_markdown("").trim(), "");
    }

    #[test]
    fn sanitize_removes_script() {
        let out = sanitize("<p>hi</p><script>alert(1)</script>");
        assert!(!out.contains("<script"));
        assert!(!out.contains("alert(1)"));
        assert!(out.contains("<p>hi</p>"));
    }

    #[test]
    fn sanitize_removes_event_handlers() {
        let out = sanitize(r#"<img src="/a.jpg" onerror="alert(1)">"#);
        assert!(!out.contains("onerror"));
        assert!(out.contains(r#"src="/a.jpg""#));
    }

    #[test]
    fn sanitize_strips_dangerous_schemes() {
        for href in [
            "javascript:alert(1)",
            "JaVaScRiPt:alert(1)",
            "data:text/html,x",
            "vbscript:x",
        ] {
            let out = sanitize(&format!(r#"<a href="{href}">x</a>"#));
            assert!(!out.contains("href"), "{href}: {out}");
        }
        let out = sanitize(&render_markdown("[x](javascript:alert(1))"));
        assert!(!out.contains("javascript"), "{out}");
        let out = sanitize(r#"<img src="data:image/png;base64,AAAA">"#);
        assert!(!out.contains("data:"), "{out}");
        let out = sanitize(r#"<a href="mailto:a@b.c">m</a><a href="/rel">r</a>"#);
        assert!(out.contains("mailto:a@b.c"));
        assert!(out.contains(r#"href="/rel""#));
    }

    #[test]
    fn sanitize_keeps_allowed_iframe() {
        let out = sanitize(
            r#"<iframe src="https://www.youtube-nocookie.com/embed/x" width="560" height="315" title="t" allowfullscreen onload="x()"></iframe>"#,
        );
        assert!(
            out.contains(r#"<iframe src="https://www.youtube-nocookie.com/embed/x""#),
            "{out}"
        );
        assert!(out.contains("allowfullscreen"));
        assert!(!out.contains("onload"));
        assert!(
            sanitize(r#"<iframe src="https://player.vimeo.com/video/1"></iframe>"#)
                .contains("<iframe")
        );
    }

    #[test]
    fn sanitize_removes_other_iframes() {
        for src in [
            "https://evil.com/embed",
            "http://www.youtube.com/embed/x",
            "https://www.youtube.com.evil.com/x",
            "https://user@evil.com/",
            "https://www.youtube.com:8443/x",
            "javascript:alert(1)",
        ] {
            let out = sanitize(&format!(r#"<p>a</p><iframe src="{src}"></iframe><p>b</p>"#));
            assert!(!out.contains("iframe"), "{src}: {out}");
            assert!(out.contains("<p>b</p>"));
        }
        assert!(!sanitize("<iframe></iframe>").contains("iframe"));
    }

    #[test]
    fn sanitize_keeps_tables() {
        let out = sanitize(&render_markdown("| a | b |\n|---|---|\n| 1 | 2 |"));
        for t in ["<table>", "<thead>", "<tbody>", "<th>", "<td>"] {
            assert!(out.contains(t), "{t}: {out}");
        }
    }

    #[test]
    fn sanitize_keeps_language_class_only() {
        let out = sanitize(&render_markdown("```rust\nfn main() {}\n```"));
        assert!(out.contains(r#"class="language-rust""#), "{out}");
        let out = sanitize(r#"<span class="evil">x</span><div class="language-c++">y</div>"#);
        assert!(!out.contains("evil"));
        assert!(out.contains(r#"class="language-c++""#));
    }

    #[test]
    fn sanitize_task_list_checkbox_forced_disabled() {
        let out = sanitize(&render_markdown("- [x] done\n- [ ] todo"));
        assert!(out.contains("checked"), "{out}");
        assert_eq!(out.matches("disabled").count(), 2, "{out}");
        let out = sanitize(r#"<input type="text" name="password">"#);
        assert!(out.contains(r#"type="checkbox""#), "{out}");
        assert!(!out.contains("password"));
    }

    #[test]
    fn sanitize_adds_rel_to_absolute_links_only() {
        let out = sanitize(r#"<a href="https://x.com" rel="opener">x</a><a href="/post/y">y</a>"#);
        assert!(
            out.contains(r#"<a href="https://x.com" rel="noopener noreferrer">"#),
            "{out}"
        );
        assert!(out.contains(r#"<a href="/post/y">"#), "{out}");
        assert!(!out.contains("rel=\"opener\""), "{out}");
    }

    #[test]
    fn sanitize_drops_style_and_unknown_tags() {
        let out = sanitize(
            r#"<p style="color:red">x</p><object data="x"></object><form><button>b</button></form><style>p{}</style>"#,
        );
        assert!(!out.contains("style"));
        assert!(!out.contains("<object"));
        assert!(!out.contains("<form"));
        assert!(!out.contains("<button"));
    }

    #[test]
    fn render_post_html_pipeline() {
        let out = render_post_html("# T\n\n![a](/images/s/p.jpg)\n\n<script>x</script>");
        assert!(out.contains("<h1>T</h1>"));
        assert!(out.contains("<picture>"));
        assert!(!out.contains("<script"));
    }

    #[test]
    fn rewrite_images_alt_with_angle_brackets_cannot_inject() {
        let out = render_post_html("![x><script>alert(1)</script>](/images/a/b.jpg)");
        assert!(!out.contains("<script"), "{out}");
        let out =
            render_post_html(r#"<img src="/images/a.jpg" alt="x><script>alert(1)</script>">"#);
        assert!(!out.contains("<script"), "{out}");
    }

    #[test]
    fn rewrite_images_wraps_images_path() {
        let input = r#"<p><img src="/images/post/photo.jpg" alt="A photo"></p>"#;
        let out = rewrite_images(input);
        assert!(out.contains("<picture>"), "should contain picture element");
        assert!(
            out.contains(r#"type="image/webp""#),
            "should have webp source"
        );
        assert!(
            out.contains("/images/post/photo.jpg?width=480&format=webp 480w"),
            "should have 480w srcset entry"
        );
        assert!(
            out.contains("/images/post/photo.jpg?width=800&format=webp 800w"),
            "should have 800w srcset entry"
        );
        assert!(
            out.contains("/images/post/photo.jpg?width=1280&format=webp 1280w"),
            "should have 1280w srcset entry"
        );
        assert!(
            out.contains(r#"src="/images/post/photo.jpg?width=680""#),
            "fallback img should have width=680"
        );
        assert!(out.contains(r#"alt="A photo""#), "alt text preserved");
        assert!(out.contains("loading=\"lazy\""), "lazy loading set");
        assert!(!out.contains("<img src=\"/images/"), "raw img tag removed");
    }

    #[test]
    fn rewrite_images_ignores_non_images_paths() {
        let input = r#"<img src="/static/logo.png" alt="Logo">"#;
        let out = rewrite_images(input);
        assert_eq!(out, input, "non-/images/ src must be left unchanged");
    }

    #[test]
    fn rewrite_images_handles_multiple_images() {
        let input = concat!(
            r#"<img src="/images/a/one.jpg" alt="One">"#,
            r#"<img src="/images/b/two.jpg" alt="Two">"#,
        );
        let out = rewrite_images(input);
        assert_eq!(out.matches("<picture>").count(), 2, "both images wrapped");
        assert!(out.contains("alt=\"One\""));
        assert!(out.contains("alt=\"Two\""));
    }

    #[test]
    fn rewrite_images_passthrough_empty() {
        assert_eq!(rewrite_images(""), "");
    }

    #[test]
    fn rewrite_images_malformed_no_close() {
        let input = "<img src=\"/images/a.jpg\" alt=\"X\"";
        assert_eq!(rewrite_images(input), input);
    }
}
