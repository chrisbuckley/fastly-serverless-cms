use fastly::config_store::ConfigStore;
use fastly::secret_store::SecretStore;
use fastly::{Request, Response};

fn ttl_from_config(key: &str) -> u32 {
    ConfigStore::open("cache_config")
        .get(key)
        .and_then(|v| v.parse().ok())
        .unwrap_or(3600)
}

pub struct CacheHeaders {
    pub surrogate_keys: Vec<String>,
    pub ttl: u32,
}

impl CacheHeaders {
    pub fn page(keys: Vec<&str>) -> Self {
        Self {
            surrogate_keys: keys.into_iter().map(String::from).collect(),
            ttl: ttl_from_config("page_ttl"),
        }
    }

    pub fn asset(keys: Vec<&str>) -> Self {
        Self {
            surrogate_keys: keys.into_iter().map(String::from).collect(),
            ttl: ttl_from_config("asset_ttl"),
        }
    }

    pub fn image(keys: Vec<&str>) -> Self {
        Self {
            surrogate_keys: keys.into_iter().map(String::from).collect(),
            ttl: ttl_from_config("image_ttl"),
        }
    }

    pub fn apply(self, mut resp: Response) -> Response {
        resp.set_header("Surrogate-Control", format!("max-age={}", self.ttl));
        resp.set_header("Cache-Control", format!("max-age={}, public", self.ttl));
        if !self.surrogate_keys.is_empty() {
            resp.set_header("Surrogate-Key", self.surrogate_keys.join(" "));
        }
        resp
    }
}

pub fn no_cache(mut resp: Response) -> Response {
    resp.set_header("Cache-Control", "private, no-store");
    resp
}

/// Purge surrogate keys from the VCL CDN service via the Fastly Purge API.
///
/// Reads `fastly_api_token` and `purge_service_id` from the Secret Store.
/// `purge_service_id` must be the ID of the *VCL* CDN service — that's where
/// the cache lives. The Compute service itself is not the caching layer.
/// Fire-and-forget: logs on error but does not propagate to the caller.
pub fn purge_keys(keys: &[&str]) {
    if let Err(e) = purge_keys_inner(keys) {
        eprintln!("purge error: {e}");
    }
}

fn purge_keys_inner(keys: &[&str]) -> Result<(), fastly::Error> {
    let secrets = SecretStore::open("secrets")?;

    let api_token = secrets
        .try_get("fastly_api_token")?
        .ok_or_else(|| fastly::Error::msg("missing secret: fastly_api_token"))?;
    let api_token = String::from_utf8_lossy(&api_token.plaintext()).into_owned();

    let service_id = secrets
        .try_get("purge_service_id")?
        .ok_or_else(|| fastly::Error::msg("missing secret: purge_service_id"))?;
    let service_id = String::from_utf8_lossy(&service_id.plaintext()).into_owned();

    let url = format!("https://api.fastly.com/service/{service_id}/purge");

    Request::post(url)
        .with_header("Fastly-Key", api_token)
        .with_header("Surrogate-Key", keys.join(" "))
        .with_header("Fastly-Soft-Purge", "1")
        .send("fastly-api")?;

    Ok(())
}
