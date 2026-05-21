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

/// Rewrites `<img src="/images/...">` tags in rendered HTML to `<picture srcset>`
/// elements with 480w/800w/1280w WebP variants served via Fastly Image Optimizer.
/// Non-`/images/` src values are left unchanged.
#[allow(dead_code)]
pub fn rewrite_images(html: &str) -> String {
    let mut out = String::with_capacity(html.len() * 2);
    let mut rest = html;
    let marker = "<img src=\"/images/";

    while let Some(img_start) = rest.find(marker) {
        out.push_str(&rest[..img_start]);
        let after_marker = &rest[img_start + marker.len()..];

        let src_end = after_marker.find('"').unwrap_or(after_marker.len());
        let src_path = format!("/images/{}", &after_marker[..src_end]);

        let tag_end = after_marker.find('>').unwrap_or(after_marker.len());
        let tag_inner = &after_marker[..tag_end];
        let alt = if let Some(alt_start) = tag_inner.find("alt=\"") {
            let after_alt = &tag_inner[alt_start + 5..];
            let alt_end = after_alt.find('"').unwrap_or(after_alt.len());
            &after_alt[..alt_end]
        } else {
            ""
        };

        out.push_str(&responsive_picture(&src_path, alt));
        rest = &after_marker[tag_end + 1..];
    }
    out.push_str(rest);
    out
}

#[allow(dead_code)]
fn responsive_picture(src: &str, alt: &str) -> String {
    format!(
        concat!(
            "<picture>",
            r#"<source type="image/webp" "#,
            r#"srcset="{src}?width=480&format=webp 480w, "#,
            r#"{src}?width=800&format=webp 800w, "#,
            r#"{src}?width=1280&format=webp 1280w" "#,
            r#"sizes="(max-width: 640px) 100vw, 800px">"#,
            r#"<img alt="{alt}" src="{src}?width=800" loading="lazy">"#,
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
    fn rewrite_images_wraps_images_path() {
        let input = r#"<p><img src="/images/post/photo.jpg" alt="A photo" /></p>"#;
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
            out.contains(r#"src="/images/post/photo.jpg?width=800""#),
            "fallback img should have width=800"
        );
        assert!(out.contains(r#"alt="A photo""#), "alt text preserved");
        assert!(out.contains("loading=\"lazy\""), "lazy loading set");
        assert!(!out.contains("<img src=\"/images/"), "raw img tag removed");
    }

    #[test]
    fn rewrite_images_ignores_non_images_paths() {
        let input = r#"<img src="/static/logo.png" alt="Logo" />"#;
        let out = rewrite_images(input);
        assert_eq!(out, input, "non-/images/ src must be left unchanged");
    }

    #[test]
    fn rewrite_images_handles_multiple_images() {
        let input = concat!(
            r#"<img src="/images/a/one.jpg" alt="One" />"#,
            r#"<img src="/images/b/two.jpg" alt="Two" />"#,
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
}
