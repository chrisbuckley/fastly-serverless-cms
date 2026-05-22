use fastly::http::StatusCode;
use fastly::kv_store::KVStoreError;
use fastly::{Error, KVStore, Request, Response};

use crate::cache::CacheHeaders;
use crate::templates;

pub fn static_file(path: &str) -> Result<Response, Error> {
    let (body, content_type) = match path {
        "style.css" => (templates::CSS, "text/css; charset=utf-8"),
        "admin.js" => (templates::ADMIN_JS, "application/javascript; charset=utf-8"),
        _ => return Ok(Response::from_status(StatusCode::NOT_FOUND).with_body("Asset not found\n")),
    };
    let resp = Response::from_status(StatusCode::OK)
        .with_header("Content-Type", content_type)
        .with_body(body.to_string());
    Ok(CacheHeaders::asset(vec!["assets"]).apply(resp))
}

pub fn image(_req: &Request, path: &str) -> Result<Response, Error> {
    let store = KVStore::open("images")?.ok_or_else(|| Error::msg("images store not found"))?;
    let key = format!("images/{}", path);
    match store.lookup(&key) {
        Ok(mut resp) => {
            let bytes = resp.take_body_bytes();
            let ct = if path.ends_with(".jpg") || path.ends_with(".jpeg") {
                "image/jpeg"
            } else if path.ends_with(".png") {
                "image/png"
            } else if path.ends_with(".webp") {
                "image/webp"
            } else if path.ends_with(".gif") {
                "image/gif"
            } else if path.ends_with(".svg") {
                "image/svg+xml"
            } else {
                "application/octet-stream"
            };
            let slug = path.split('/').next().unwrap_or("unknown");
            let resp = Response::from_status(StatusCode::OK)
                .with_header("Content-Type", ct)
                .with_body_octet_stream(&bytes);
            Ok(CacheHeaders::image(vec![&format!("image-{}", slug)]).apply(resp))
        }
        Err(KVStoreError::ItemNotFound) => {
            Ok(Response::from_status(StatusCode::NOT_FOUND).with_body("Image not found\n"))
        }
        Err(e) => Err(e.into()),
    }
}
