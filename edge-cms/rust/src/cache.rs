use fastly::Response;

pub struct CacheHeaders {
    pub surrogate_keys: Vec<String>,
    pub edge_ttl: u32,
    pub browser_ttl: u32,
}

impl CacheHeaders {
    pub fn reader(keys: Vec<&str>) -> Self {
        Self {
            surrogate_keys: keys.into_iter().map(String::from).collect(),
            edge_ttl: 3600,
            browser_ttl: 60,
        }
    }

    pub fn apply(self, mut resp: Response) -> Response {
        resp.set_header(
            "Surrogate-Control",
            format!("max-age={}", self.edge_ttl),
        );
        resp.set_header(
            "Cache-Control",
            format!("max-age={}, public", self.browser_ttl),
        );
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

/// Stub for surrogate key purging. In production, this would call the
/// Fastly purge API via an HTTP backend. For now, it logs the keys.
pub fn purge_keys(keys: &[&str]) {
    for key in keys {
        eprintln!("purge: {}", key);
    }
}
