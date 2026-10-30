//! Static assets embedded at build time (contract §10). `/images/*` is served
//! by VCL from Object Storage, never by Compute.

use fastly::http::StatusCode;
use fastly::Response;

use crate::cache;

macro_rules! shared {
    ($path:expr) => {
        include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../shared/", $path))
    };
}

const CSS: &str = "text/css; charset=utf-8";
const JS: &str = "application/javascript; charset=utf-8";
const WOFF2: &str = "font/woff2";

/// Body and Content-Type for a path under `/assets/` (query string already stripped).
pub fn lookup(path: &str) -> Option<(&'static [u8], &'static str)> {
    let asset: (&'static [u8], &'static str) = match path {
        "style.css" => (shared!("css/style.css"), CSS),
        "admin.css" => (shared!("css/admin.css"), CSS),
        "site.js" => (shared!("js/site.js"), JS),
        "admin.js" => (shared!("js/admin.js"), JS),
        "fonts/fraunces.woff2" => (shared!("fonts/fraunces.woff2"), WOFF2),
        "fonts/dm-sans.woff2" => (shared!("fonts/dm-sans.woff2"), WOFF2),
        "fonts/jetbrains-mono.woff2" => (shared!("fonts/jetbrains-mono.woff2"), WOFF2),
        _ => return None,
    };
    Some(asset)
}

pub fn static_file(path: &str) -> Response {
    match lookup(path) {
        Some((body, content_type)) => cache::asset(
            Response::from_status(StatusCode::OK)
                .with_body(body)
                .with_header("Content-Type", content_type),
        ),
        None => cache::no_cache(
            Response::from_status(StatusCode::NOT_FOUND)
                .with_header("Content-Type", "text/plain; charset=utf-8")
                .with_body("Asset not found\n"),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_assets() {
        for (path, ct) in [
            ("style.css", CSS),
            ("admin.css", CSS),
            ("site.js", JS),
            ("admin.js", JS),
            ("fonts/fraunces.woff2", WOFF2),
            ("fonts/dm-sans.woff2", WOFF2),
            ("fonts/jetbrains-mono.woff2", WOFF2),
        ] {
            assert_eq!(lookup(path).map(|(_, c)| c), Some(ct), "{path}");
        }
    }

    #[test]
    fn unknown_assets() {
        for path in ["", "x.css", "../Cargo.toml", "fonts/", "style.css/"] {
            assert!(lookup(path).is_none(), "{path}");
        }
    }
}
