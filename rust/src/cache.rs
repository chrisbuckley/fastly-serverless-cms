//! Cache headers and surrogate-key purging (contract §7).

use fastly::secret_store::SecretStore;
use fastly::{Request, Response};

use crate::config;
use crate::logging;
use crate::security::NO_STORE;

const FEED_BROWSER_TTL: u32 = 300;
const ASSET_BROWSER_CACHE: &str = "public, max-age=31536000, immutable";

fn page_surrogate_control(ttl: u32) -> String {
    format!("max-age={ttl}, stale-while-revalidate=60, stale-if-error=86400")
}

fn with_keys(mut resp: Response, keys: &[&str]) -> Response {
    if !keys.is_empty() {
        resp.set_header("Surrogate-Key", keys.join(" "));
    }
    resp
}

/// HTML pages (home, post, tag). VCL rewrites the browser TTL for HTML.
pub fn page(resp: Response, keys: &[&str]) -> Response {
    let ttl = config::page_ttl();
    with_keys(
        resp.with_header("Surrogate-Control", page_surrogate_control(ttl))
            .with_header("Cache-Control", format!("max-age={ttl}, public")),
        keys,
    )
}

/// feed.xml, sitemap.xml, robots.txt: edge TTL as pages, short browser TTL.
pub fn feed(resp: Response) -> Response {
    with_keys(
        resp.with_header(
            "Surrogate-Control",
            page_surrogate_control(config::page_ttl()),
        )
        .with_header(
            "Cache-Control",
            format!("public, max-age={FEED_BROWSER_TTL}"),
        ),
        &["post-index"],
    )
}

/// Versioned static assets.
pub fn asset(resp: Response) -> Response {
    with_keys(
        resp.with_header(
            "Surrogate-Control",
            format!("max-age={}", config::asset_ttl()),
        )
        .with_header("Cache-Control", ASSET_BROWSER_CACHE),
        &["assets"],
    )
}

pub fn no_cache(resp: Response) -> Response {
    resp.with_header("Cache-Control", NO_STORE)
}

/// Soft-purge surrogate keys on the VCL CDN service via the Fastly API.
///
/// Reads `fastly_api_token` and `purge_service_id` (the *VCL* service, where
/// the cache lives) from the Secret Store. Returns `false` on any failure,
/// including a non-2xx API status, so admin handlers can surface it.
pub fn purge_keys(keys: &[String]) -> bool {
    match purge_keys_inner(keys) {
        Ok(()) => true,
        Err(e) => {
            logging::event("error", &format!("purge failed: {e}"));
            false
        }
    }
}

fn read_secret(secrets: &SecretStore, name: &str) -> Result<String, fastly::Error> {
    let secret = secrets
        .try_get(name)?
        .ok_or_else(|| fastly::Error::msg(format!("missing secret: {name}")))?;
    Ok(String::from_utf8_lossy(&secret.plaintext()).into_owned())
}

fn purge_keys_inner(keys: &[String]) -> Result<(), fastly::Error> {
    let secrets = SecretStore::open("secrets")?;
    let api_token = read_secret(&secrets, "fastly_api_token")?;
    let service_id = read_secret(&secrets, "purge_service_id")?;

    let mut resp = Request::post(format!("https://api.fastly.com/service/{service_id}/purge"))
        .with_header("Fastly-Key", api_token)
        .with_header("Surrogate-Key", keys.join(" "))
        .with_header("Fastly-Soft-Purge", "1")
        .send("fastly-api")?;

    let status = resp.get_status();
    if status.is_success() {
        return Ok(());
    }
    let body = resp.take_body_str();
    Err(fastly::Error::msg(format!(
        "status {} body {}",
        status.as_u16(),
        logging::truncate_bytes(&body, 200)
    )))
}

/// Append `?purge=failed` to an admin redirect target when a purge failed.
pub fn redirect_target(base: &str, purged: bool) -> String {
    if purged {
        base.to_string()
    } else if base.contains('?') {
        format!("{base}&purge=failed")
    } else {
        format!("{base}?purge=failed")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redirect_target_appends_flag_on_failure() {
        assert_eq!(redirect_target("/admin", true), "/admin");
        assert_eq!(redirect_target("/admin", false), "/admin?purge=failed");
        assert_eq!(
            redirect_target("/admin?x=1", false),
            "/admin?x=1&purge=failed"
        );
    }

    #[test]
    fn page_surrogate_control_format() {
        assert_eq!(
            page_surrogate_control(86400),
            "max-age=86400, stale-while-revalidate=60, stale-if-error=86400"
        );
    }
}
