//! Config Store `cache_config` access and per-request context (contract §6).

use std::net::IpAddr;

use fastly::config_store::ConfigStore;
use fastly::Request;

const DEFAULT_PAGE_TTL: u32 = 86_400;
const DEFAULT_ASSET_TTL: u32 = 31_536_000;
const DEFAULT_PAGE_SIZE: usize = 10;

fn config_value(key: &str) -> Option<String> {
    ConfigStore::try_open("cache_config")
        .ok()
        .and_then(|store| store.try_get(key).ok().flatten())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn parsed_or<T: std::str::FromStr>(key: &str, default: T) -> T {
    config_value(key)
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

pub fn page_ttl() -> u32 {
    parsed_or("page_ttl", DEFAULT_PAGE_TTL)
}

pub fn asset_ttl() -> u32 {
    parsed_or("asset_ttl", DEFAULT_ASSET_TTL)
}

pub fn page_size() -> usize {
    parsed_or("page_size", DEFAULT_PAGE_SIZE).max(1)
}

/// `FASTLY_SERVICE_VERSION`, or `dev` locally. Used for `?v=` asset busting
/// and the `X-Edge-CMS-Compute-Version` header.
pub fn asset_version() -> String {
    std::env::var("FASTLY_SERVICE_VERSION")
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "dev".to_string())
}

fn is_valid_host(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 253
        && host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b':' | b'[' | b']'))
}

/// Configured `site_url` (trailing slash removed), else `https://` + Host.
/// An unusable Host header falls back to `https://localhost` rather than
/// reflecting arbitrary input into absolute URLs.
pub fn derive_site_url(configured: Option<&str>, host: Option<&str>) -> String {
    if let Some(url) = configured.map(|u| u.trim().trim_end_matches('/')) {
        if !url.is_empty() {
            return url.to_string();
        }
    }
    let host = host
        .map(str::trim)
        .filter(|h| is_valid_host(h))
        .unwrap_or("localhost");
    format!("https://{}", host.to_ascii_lowercase())
}

/// Request-scoped values every handler needs.
pub struct Ctx {
    pub site_url: String,
    pub client_ip: Option<IpAddr>,
    pub asset_version: String,
}

impl Ctx {
    /// Call only after origin auth: from then on `Fastly-Client-IP` (set by
    /// the VCL service) is trusted as the real client address.
    pub fn from_request(req: &Request) -> Self {
        let client_ip = req
            .get_header_str("Fastly-Client-IP")
            .and_then(|v| v.trim().parse().ok())
            .or_else(|| req.get_client_ip_addr());
        Self {
            site_url: derive_site_url(
                config_value("site_url").as_deref(),
                req.get_header_str("Host"),
            ),
            client_ip,
            asset_version: asset_version(),
        }
    }

    pub fn absolute(&self, path: &str) -> String {
        format!("{}{}", self.site_url, path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn site_url_from_config() {
        assert_eq!(
            derive_site_url(Some("https://blog.example.com/"), Some("other")),
            "https://blog.example.com"
        );
        assert_eq!(
            derive_site_url(Some("http://127.0.0.1:7676"), None),
            "http://127.0.0.1:7676"
        );
    }

    #[test]
    fn site_url_from_host() {
        assert_eq!(
            derive_site_url(None, Some("Blog.Example.com")),
            "https://blog.example.com"
        );
        assert_eq!(
            derive_site_url(Some("  "), Some("a.com:8443")),
            "https://a.com:8443"
        );
    }

    #[test]
    fn site_url_rejects_hostile_host() {
        assert_eq!(
            derive_site_url(None, Some("evil.com/\"><script>")),
            "https://localhost"
        );
        assert_eq!(derive_site_url(None, None), "https://localhost");
    }
}
