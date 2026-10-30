//! Response security policy, origin authentication and CSRF (contract §1–3, §7, §14).
//! Every response leaving the service passes through [`finalize`].

use fastly::http::StatusCode;
use fastly::Response;

pub const ORIGIN_AUTH_HEADER: &str = "Edge-CMS-Origin-Auth";

const CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; font-src 'self'; connect-src 'self'; frame-src https://www.youtube-nocookie.com https://www.youtube.com https://player.vimeo.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'";

const SECURITY_HEADERS: [(&str, &str); 6] = [
    ("Content-Security-Policy", CSP),
    ("X-Content-Type-Options", "nosniff"),
    ("Referrer-Policy", "strict-origin-when-cross-origin"),
    ("X-Frame-Options", "DENY"),
    (
        "Permissions-Policy",
        "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    ),
    ("Cross-Origin-Opener-Policy", "same-origin"),
];

pub const NO_STORE: &str = "private, no-store";

pub fn is_admin_path(path: &str) -> bool {
    path == "/admin" || path.starts_with("/admin/")
}

/// Apply headers every response must carry. Admin responses and errors are
/// never cacheable: Surrogate-* headers are stripped and Cache-Control is forced.
pub fn finalize(mut resp: Response, path: &str, compute_version: &str) -> Response {
    for (name, value) in SECURITY_HEADERS {
        resp.set_header(name, value);
    }
    let admin = is_admin_path(path);
    if admin {
        resp.set_header("X-Robots-Tag", "noindex, nofollow");
    }
    if admin || resp.get_status().as_u16() >= 400 {
        resp.set_header("Cache-Control", NO_STORE);
        resp.remove_header("Surrogate-Control");
        resp.remove_header("Surrogate-Key");
    }
    resp.set_header("X-Edge-CMS-Compute-Version", compute_version);
    resp
}

fn plain(status: StatusCode, body: &str) -> Response {
    Response::from_status(status)
        .with_header("Content-Type", "text/plain; charset=utf-8")
        .with_header("Cache-Control", NO_STORE)
        .with_body(body)
}

pub fn forbidden() -> Response {
    plain(StatusCode::FORBIDDEN, "Forbidden\n")
}

pub fn too_many_login_attempts() -> Response {
    plain(StatusCode::TOO_MANY_REQUESTS, "Too many login attempts\n")
        .with_header("Retry-After", "900")
}

/// Constant-time byte comparison (length is not secret).
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Origin auth decision: a missing secret or header always fails closed.
pub fn origin_auth_ok(expected: Option<&[u8]>, provided: Option<&[u8]>) -> bool {
    match (expected, provided) {
        (Some(e), Some(p)) if !e.is_empty() => constant_time_eq(e, p),
        _ => false,
    }
}

/// Requests that must pass the CSRF check: any non-GET/HEAD under `/admin`.
pub fn needs_csrf_check(method: &str, path: &str) -> bool {
    is_admin_path(path) && !matches!(method, "GET" | "HEAD")
}

/// `scheme://host[:port]` of an absolute URL, lowercased.
fn origin_of(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if scheme.is_empty() || authority.is_empty() {
        return None;
    }
    Some(format!("{scheme}://{authority}").to_ascii_lowercase())
}

/// Contract §3 decision: Sec-Fetch-Site wins when present; otherwise Origin
/// must match `site_url`; with neither, reject.
pub fn csrf_allowed(sec_fetch_site: Option<&str>, origin: Option<&str>, site_url: &str) -> bool {
    if let Some(site) = sec_fetch_site {
        return matches!(
            site.trim().to_ascii_lowercase().as_str(),
            "same-origin" | "none"
        );
    }
    match (origin, origin_of(site_url)) {
        (Some(o), Some(expected)) => origin_of(o.trim()).is_some_and(|got| got == expected),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SITE: &str = "https://blog.example.com";

    #[test]
    fn csrf_sec_fetch_site() {
        assert!(csrf_allowed(Some("same-origin"), None, SITE));
        assert!(csrf_allowed(Some("none"), None, SITE));
        assert!(!csrf_allowed(Some("same-site"), None, SITE));
        assert!(!csrf_allowed(Some("cross-site"), None, SITE));
        assert!(!csrf_allowed(Some("cross-site"), Some(SITE), SITE));
    }

    #[test]
    fn csrf_origin_fallback() {
        assert!(csrf_allowed(None, Some(SITE), SITE));
        assert!(csrf_allowed(None, Some("HTTPS://Blog.Example.com"), SITE));
        assert!(!csrf_allowed(None, Some("https://evil.com"), SITE));
        assert!(!csrf_allowed(None, Some("http://blog.example.com"), SITE));
        assert!(!csrf_allowed(
            None,
            Some("https://blog.example.com.evil.com"),
            SITE
        ));
        assert!(!csrf_allowed(
            None,
            Some("https://blog.example.com:8443"),
            SITE
        ));
        assert!(!csrf_allowed(None, Some("null"), SITE));
        assert!(csrf_allowed(
            None,
            Some("http://127.0.0.1:7676"),
            "http://127.0.0.1:7676"
        ));
    }

    #[test]
    fn csrf_rejects_without_headers() {
        assert!(!csrf_allowed(None, None, SITE));
    }

    #[test]
    fn csrf_scope() {
        assert!(needs_csrf_check("POST", "/admin/login"));
        assert!(needs_csrf_check("PUT", "/admin/sidebar"));
        assert!(needs_csrf_check("DELETE", "/admin/posts/x"));
        assert!(!needs_csrf_check("GET", "/admin"));
        assert!(!needs_csrf_check("HEAD", "/admin"));
        assert!(!needs_csrf_check("POST", "/administrator"));
        assert!(!needs_csrf_check("POST", "/feed.xml"));
    }

    #[test]
    fn origin_auth_decision() {
        assert!(origin_auth_ok(Some(b"secret"), Some(b"secret")));
        assert!(!origin_auth_ok(Some(b"secret"), Some(b"secreT")));
        assert!(!origin_auth_ok(Some(b"secret"), Some(b"secret2")));
        assert!(!origin_auth_ok(Some(b"secret"), None));
        assert!(!origin_auth_ok(None, Some(b"secret")));
        assert!(!origin_auth_ok(Some(b""), Some(b"")));
    }

    #[test]
    fn admin_path_detection() {
        assert!(is_admin_path("/admin"));
        assert!(is_admin_path("/admin/login"));
        assert!(!is_admin_path("/administrator"));
        assert!(!is_admin_path("/"));
    }
}
