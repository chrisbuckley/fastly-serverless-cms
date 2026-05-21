use fastly::http::StatusCode;
use fastly::kv_store::KVStoreError;
use fastly::{Error, KVStore, Request, Response};

use crate::models::{PostIndex, SidebarConfig};

pub(crate) fn read_index() -> Result<PostIndex, Error> {
    let store = KVStore::open("content")?.ok_or_else(|| Error::msg("content store not found"))?;
    match store.lookup("_index") {
        Ok(mut resp) => {
            let json = resp.take_body().into_string();
            Ok(serde_json::from_str(&json)?)
        }
        Err(KVStoreError::ItemNotFound) => Ok(PostIndex { posts: vec![] }),
        Err(e) => Err(e.into()),
    }
}

pub(crate) fn read_sidebar() -> Result<SidebarConfig, Error> {
    let store = KVStore::open("content")?.ok_or_else(|| Error::msg("content store not found"))?;
    match store.lookup("_sidebar") {
        Ok(mut resp) => {
            let json = resp.take_body().into_string();
            Ok(serde_json::from_str(&json)?)
        }
        Err(KVStoreError::ItemNotFound) => Ok(SidebarConfig { items: vec![] }),
        Err(e) => Err(e.into()),
    }
}

pub fn home(_req: &Request) -> Result<Response, Error> {
    Ok(Response::from_status(StatusCode::NOT_IMPLEMENTED).with_body_text_plain("TODO\n"))
}

pub fn post(_req: &Request, _slug: &str) -> Result<Response, Error> {
    Ok(Response::from_status(StatusCode::NOT_IMPLEMENTED).with_body_text_plain("TODO\n"))
}

pub fn tag(_req: &Request, _tag: &str) -> Result<Response, Error> {
    Ok(Response::from_status(StatusCode::NOT_IMPLEMENTED).with_body_text_plain("TODO\n"))
}

pub fn feed(_req: &Request) -> Result<Response, Error> {
    Ok(Response::from_status(StatusCode::NOT_IMPLEMENTED).with_body_text_plain("TODO\n"))
}

pub fn sitemap(_req: &Request) -> Result<Response, Error> {
    Ok(Response::from_status(StatusCode::NOT_IMPLEMENTED).with_body_text_plain("TODO\n"))
}

pub fn robots() -> Result<Response, Error> {
    Ok(Response::from_status(StatusCode::NOT_IMPLEMENTED).with_body_text_plain("TODO\n"))
}
