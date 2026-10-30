//! Pure input-validation rules (contract §5). No Fastly hostcalls here so
//! everything is unit-testable on the host target.

use crate::models::{SidebarConfig, SidebarItem};

pub const MAX_TITLE_CHARS: usize = 200;
pub const MAX_EXCERPT_CHARS: usize = 500;
pub const MAX_CONTENT_BYTES: usize = 512 * 1024;
pub const MAX_BODY_BYTES: usize = 1024 * 1024;
pub const MAX_SIDEBAR_BYTES: usize = 64 * 1024;
pub const MAX_SIDEBAR_ITEMS: usize = 50;
pub const MAX_UPLOAD_BYTES: usize = 10 * 1024 * 1024;
const MAX_TAGS: usize = 20;
const MAX_LABEL_CHARS: usize = 100;

fn is_lower_alnum(b: u8) -> bool {
    b.is_ascii_lowercase() || b.is_ascii_digit()
}

/// `^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$`
pub fn is_valid_slug(s: &str) -> bool {
    let b = s.as_bytes();
    match b {
        [] => false,
        [only] => is_lower_alnum(*only),
        [first, middle @ .., last] => {
            b.len() <= 100
                && is_lower_alnum(*first)
                && is_lower_alnum(*last)
                && middle.iter().all(|&c| is_lower_alnum(c) || c == b'-')
        }
    }
}

/// `^[a-z0-9][a-z0-9-]{0,49}$`
pub fn is_valid_tag(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 50
        && is_lower_alnum(b[0])
        && b[1..].iter().all(|&c| is_lower_alnum(c) || c == b'-')
}

/// Split on `,`, trim, lowercase, spaces→`-`, keep valid, dedupe, max 20.
pub fn normalize_tags(raw: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for part in raw.split(',') {
        let tag = part.trim().to_lowercase().replace(' ', "-");
        if is_valid_tag(&tag) && !out.contains(&tag) {
            out.push(tag);
            if out.len() == MAX_TAGS {
                break;
            }
        }
    }
    out
}

/// Trimmed title, 1–200 chars.
pub fn validate_title(raw: &str) -> Result<String, &'static str> {
    let t = raw.trim();
    let n = t.chars().count();
    if n == 0 || n > MAX_TITLE_CHARS {
        Err("Title must be 1-200 characters")
    } else {
        Ok(t.to_string())
    }
}

pub fn validate_excerpt(raw: &str) -> Result<(), &'static str> {
    if raw.chars().count() > MAX_EXCERPT_CHARS {
        Err("Excerpt must be at most 500 characters")
    } else {
        Ok(())
    }
}

pub fn content_too_large(content: &str) -> bool {
    content.len() > MAX_CONTENT_BYTES
}

/// Image type detected from magic bytes; the only types Object Storage accepts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageType {
    Jpeg,
    Png,
    Gif,
    Webp,
}

impl ImageType {
    pub fn content_type(self) -> &'static str {
        match self {
            Self::Jpeg => "image/jpeg",
            Self::Png => "image/png",
            Self::Gif => "image/gif",
            Self::Webp => "image/webp",
        }
    }

    fn from_extension(ext: &str) -> Option<Self> {
        match ext {
            "jpg" | "jpeg" => Some(Self::Jpeg),
            "png" => Some(Self::Png),
            "gif" => Some(Self::Gif),
            "webp" => Some(Self::Webp),
            _ => None,
        }
    }
}

pub fn detect_image_type(bytes: &[u8]) -> Option<ImageType> {
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some(ImageType::Jpeg)
    } else if bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) {
        Some(ImageType::Png)
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some(ImageType::Gif)
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some(ImageType::Webp)
    } else {
        None
    }
}

/// `^[a-z0-9][a-z0-9_-]{0,63}\.(jpg|jpeg|png|webp|gif)$` → the type implied by the extension.
pub fn upload_filename_type(name: &str) -> Option<ImageType> {
    let (stem, ext) = name.rsplit_once('.')?;
    let s = stem.as_bytes();
    let stem_ok = !s.is_empty()
        && s.len() <= 64
        && is_lower_alnum(s[0])
        && s[1..]
            .iter()
            .all(|&c| is_lower_alnum(c) || c == b'-' || c == b'_');
    if stem_ok {
        ImageType::from_extension(ext)
    } else {
        None
    }
}

/// Sidebar link URL rule U: `https://…`, `http://…`, or `/…` but not `//…`.
/// Backslashes and whitespace are rejected anywhere (browsers treat `/\` as `//`).
pub fn is_safe_link_url(url: &str) -> bool {
    if url.contains('\\') || url.chars().any(char::is_whitespace) {
        return false;
    }
    url.starts_with("https://")
        || url.starts_with("http://")
        || (url.starts_with('/') && !url.starts_with("//"))
}

/// `^[a-z0-9-]{1,32}$`
fn is_valid_icon(icon: &str) -> bool {
    let b = icon.as_bytes();
    !b.is_empty() && b.len() <= 32 && b.iter().all(|&c| is_lower_alnum(c) || c == b'-')
}

fn is_valid_label(label: &str) -> bool {
    let n = label.trim().chars().count();
    (1..=MAX_LABEL_CHARS).contains(&n)
}

/// Parse and validate a sidebar JSON body. Unknown fields are dropped by
/// typed deserialisation.
pub fn parse_sidebar(body: &[u8]) -> Result<SidebarConfig, &'static str> {
    if body.len() > MAX_SIDEBAR_BYTES {
        return Err("Sidebar JSON exceeds 64 KiB");
    }
    let sidebar: SidebarConfig =
        serde_json::from_slice(body).map_err(|_| "Invalid sidebar JSON")?;
    if sidebar.items.len() > MAX_SIDEBAR_ITEMS {
        return Err("Sidebar has more than 50 items");
    }
    for item in &sidebar.items {
        let ok = match item {
            SidebarItem::Category {
                label,
                slug,
                children,
            } => {
                is_valid_label(label)
                    && is_valid_slug(slug)
                    && children.iter().all(|c| is_valid_slug(c))
            }
            SidebarItem::Link { label, url, icon } => {
                is_valid_label(label)
                    && is_safe_link_url(url)
                    && icon.as_deref().is_none_or(is_valid_icon)
            }
        };
        if !ok {
            return Err("Invalid sidebar item");
        }
    }
    Ok(sidebar)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_accepts_valid() {
        for s in ["a", "0", "hello-world", "a1-b2", &"a".repeat(100)] {
            assert!(is_valid_slug(s), "{s}");
        }
    }

    #[test]
    fn slug_rejects_invalid() {
        for s in [
            "",
            "-a",
            "a-",
            "A",
            "hello_world",
            "hello world",
            "../etc",
            "a/b",
            "é",
            &"a".repeat(101),
        ] {
            assert!(!is_valid_slug(s), "{s}");
        }
    }

    #[test]
    fn tag_rules() {
        assert!(is_valid_tag("rust"));
        assert!(is_valid_tag("a-"));
        assert!(is_valid_tag(&"a".repeat(50)));
        assert!(!is_valid_tag(&"a".repeat(51)));
        assert!(!is_valid_tag("-a"));
        assert!(!is_valid_tag(""));
        assert!(!is_valid_tag("<script>"));
    }

    #[test]
    fn normalize_tags_cleans_and_dedupes() {
        assert_eq!(
            normalize_tags(" Rust , edge computing,rust,,bad<tag>,-x"),
            vec!["rust", "edge-computing"]
        );
    }

    #[test]
    fn normalize_tags_caps_at_twenty() {
        let raw: Vec<String> = (0..30).map(|i| format!("t{i}")).collect();
        let tags = normalize_tags(&raw.join(","));
        assert_eq!(tags.len(), 20);
        assert_eq!(tags[19], "t19");
    }

    #[test]
    fn title_rules() {
        assert_eq!(validate_title("  Hi  ").unwrap(), "Hi");
        assert!(validate_title("   ").is_err());
        assert!(validate_title(&"é".repeat(200)).is_ok());
        assert!(validate_title(&"x".repeat(201)).is_err());
    }

    #[test]
    fn excerpt_and_content_limits() {
        assert!(validate_excerpt(&"x".repeat(500)).is_ok());
        assert!(validate_excerpt(&"x".repeat(501)).is_err());
        assert!(!content_too_large(&"x".repeat(MAX_CONTENT_BYTES)));
        assert!(content_too_large(&"x".repeat(MAX_CONTENT_BYTES + 1)));
    }

    #[test]
    fn magic_bytes() {
        assert_eq!(
            detect_image_type(&[0xFF, 0xD8, 0xFF, 0xE0]),
            Some(ImageType::Jpeg)
        );
        assert_eq!(
            detect_image_type(b"\x89PNG\r\n\x1a\n...."),
            Some(ImageType::Png)
        );
        assert_eq!(detect_image_type(b"GIF89a.."), Some(ImageType::Gif));
        assert_eq!(detect_image_type(b"GIF87a.."), Some(ImageType::Gif));
        assert_eq!(
            detect_image_type(b"RIFF\0\0\0\0WEBPVP8 "),
            Some(ImageType::Webp)
        );
        assert_eq!(detect_image_type(b"RIFF\0\0\0\0WAVE"), None);
        assert_eq!(detect_image_type(b"<svg xmlns="), None);
        assert_eq!(detect_image_type(b""), None);
        assert_eq!(detect_image_type(&[0xFF, 0xD8]), None);
    }

    #[test]
    fn upload_filename_rules() {
        assert_eq!(upload_filename_type("hero.jpg"), Some(ImageType::Jpeg));
        assert_eq!(upload_filename_type("hero_1-a.jpeg"), Some(ImageType::Jpeg));
        assert_eq!(upload_filename_type("x.png"), Some(ImageType::Png));
        assert_eq!(upload_filename_type("x.webp"), Some(ImageType::Webp));
        assert_eq!(upload_filename_type("x.gif"), Some(ImageType::Gif));
        for bad in [
            "x.svg",
            "X.jpg",
            "_x.jpg",
            ".jpg",
            "x.JPG",
            "../x.jpg",
            "a/b.jpg",
            "x.jpg.svg",
            "x",
            &format!("{}.jpg", "a".repeat(65)),
        ] {
            assert_eq!(upload_filename_type(bad), None, "{bad}");
        }
        assert!(upload_filename_type(&format!("{}.jpg", "a".repeat(64))).is_some());
    }

    #[test]
    fn link_url_rule() {
        assert!(is_safe_link_url("https://example.com"));
        assert!(is_safe_link_url("http://example.com"));
        assert!(is_safe_link_url("/post/x"));
        assert!(!is_safe_link_url("//evil.com"));
        assert!(!is_safe_link_url("javascript:alert(1)"));
        assert!(!is_safe_link_url("JAVASCRIPT:alert(1)"));
        assert!(!is_safe_link_url("data:text/html,x"));
        assert!(!is_safe_link_url(""));
        assert!(!is_safe_link_url("/\\evil.com"));
        assert!(!is_safe_link_url("https://a.com\\@evil.com"));
        assert!(!is_safe_link_url("/a b"));
        assert!(!is_safe_link_url("/\tx"));
        assert!(!is_safe_link_url("https://a.com/\n"));
    }

    #[test]
    fn sidebar_valid_and_unknown_fields_dropped() {
        let body = br#"{"items":[{"type":"category","label":"A","slug":"a","children":["x"],"evil":1},{"type":"link","label":"G","url":"https://g.com","icon":"github"}],"extra":true}"#;
        let s = parse_sidebar(body).unwrap();
        assert_eq!(s.items.len(), 2);
        let out = serde_json::to_string(&s).unwrap();
        assert!(!out.contains("evil"));
        assert!(!out.contains("extra"));
    }

    #[test]
    fn sidebar_rejects_bad_items() {
        let cases: [&[u8]; 8] = [
            br#"{"items":[{"type":"link","label":"x","url":"javascript:alert(1)"}]}"#,
            br#"{"items":[{"type":"link","label":"","url":"/x"}]}"#,
            br#"{"items":[{"type":"link","label":"x","url":"/x","icon":"Bad Icon"}]}"#,
            br#"{"items":[{"type":"category","label":"x","slug":"Bad","children":[]}]}"#,
            br#"{"items":[{"type":"category","label":"x","slug":"a","children":["../x"]}]}"#,
            br#"{"items":[{"type":"script","label":"x"}]}"#,
            br#"not json"#,
            br#"{"items":"x"}"#,
        ];
        for c in cases {
            assert!(parse_sidebar(c).is_err(), "{}", String::from_utf8_lossy(c));
        }
    }

    #[test]
    fn sidebar_limits() {
        let item = r#"{"type":"link","label":"x","url":"/x"}"#;
        let fifty = format!(r#"{{"items":[{}]}}"#, vec![item; 50].join(","));
        assert!(parse_sidebar(fifty.as_bytes()).is_ok());
        let fifty_one = format!(r#"{{"items":[{}]}}"#, vec![item; 51].join(","));
        assert!(parse_sidebar(fifty_one.as_bytes()).is_err());
        let big = vec![b' '; MAX_SIDEBAR_BYTES + 1];
        assert!(parse_sidebar(&big).is_err());
        let long_label = format!(
            r#"{{"items":[{{"type":"link","label":"{}","url":"/x"}}]}}"#,
            "l".repeat(101)
        );
        assert!(parse_sidebar(long_label.as_bytes()).is_err());
    }
}
