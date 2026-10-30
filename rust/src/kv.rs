//! KV Store `content` access (contract §8). Only `ItemNotFound` means absent;
//! every other KV error propagates so a failed read never feeds a write.

use std::time::Duration;

use fastly::kv_store::{InsertMode, KVStoreError};
use fastly::{Error, KVStore};
use serde::de::DeserializeOwned;

use crate::models::{PostIndex, SidebarConfig};

pub const INDEX_KEY: &str = "_index";
pub const SIDEBAR_KEY: &str = "_sidebar";
pub const RETENTION: Duration = Duration::from_secs(30 * 86_400);
const INDEX_WRITE_ATTEMPTS: usize = 5;

pub fn content() -> Result<KVStore, Error> {
    KVStore::open("content")?.ok_or_else(|| Error::msg("content store not found"))
}

pub fn post_key(slug: &str) -> String {
    format!("post:{slug}")
}

fn lookup_raw(store: &KVStore, key: &str) -> Result<Option<(Vec<u8>, u64)>, Error> {
    match store.lookup(key) {
        Ok(mut resp) => {
            let generation = resp.current_generation();
            Ok(Some((resp.take_body_bytes(), generation)))
        }
        Err(KVStoreError::ItemNotFound) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn exists(store: &KVStore, key: &str) -> Result<bool, Error> {
    Ok(lookup_raw(store, key)?.is_some())
}

pub fn get_json<T: DeserializeOwned>(store: &KVStore, key: &str) -> Result<Option<T>, Error> {
    lookup_raw(store, key)?
        .map(|(bytes, _)| serde_json::from_slice(&bytes).map_err(Error::from))
        .transpose()
}

pub fn read_index(store: &KVStore) -> Result<PostIndex, Error> {
    Ok(get_json(store, INDEX_KEY)?.unwrap_or_default())
}

pub fn read_sidebar(store: &KVStore) -> Result<SidebarConfig, Error> {
    Ok(get_json(store, SIDEBAR_KEY)?.unwrap_or_default())
}

/// Read-modify-write `_index` with optimistic concurrency.
///
/// The fastly 0.11 SDK supports generation-conditional inserts
/// (`if_generation_match`), so an existing index is written only if it is
/// unchanged since it was read, and a missing index is created with
/// `InsertMode::Add`. On a precondition failure the index is re-read and the
/// mutation re-applied, up to 5 attempts.
pub fn update_index(store: &KVStore, mutate: impl Fn(&mut PostIndex)) -> Result<(), Error> {
    for _ in 0..INDEX_WRITE_ATTEMPTS {
        let (mut index, generation) = match lookup_raw(store, INDEX_KEY)? {
            Some((bytes, generation)) => (
                serde_json::from_slice::<PostIndex>(&bytes)?,
                Some(generation),
            ),
            None => (PostIndex::default(), None),
        };
        mutate(&mut index);
        let builder = store.build_insert();
        let builder = match generation {
            Some(g) => builder.if_generation_match(g),
            None => builder.mode(InsertMode::Add),
        };
        match builder.execute(INDEX_KEY, serde_json::to_string(&index)?) {
            Ok(()) => return Ok(()),
            Err(KVStoreError::ItemPreconditionFailed) => continue,
            Err(e) => return Err(e.into()),
        }
    }
    Err(Error::msg("index update conflicted repeatedly"))
}

/// Overwrite `_index` wholesale (rebuild). Conditional like [`update_index`].
pub fn replace_index(store: &KVStore, index: &PostIndex) -> Result<(), Error> {
    update_index(store, |current| current.posts.clone_from(&index.posts))
}

pub fn insert_with_ttl(
    store: &KVStore,
    key: &str,
    value: String,
    ttl: Duration,
) -> Result<(), Error> {
    store
        .build_insert()
        .time_to_live(ttl)
        .execute(key, value)
        .map_err(Error::from)
}

/// Delete a key; an already-absent key is not an error.
pub fn delete(store: &KVStore, key: &str) -> Result<(), Error> {
    match store.delete(key) {
        Ok(()) | Err(KVStoreError::ItemNotFound) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

pub fn list_keys(store: &KVStore, prefix: &str) -> Result<Vec<String>, Error> {
    let mut keys = Vec::new();
    for page in store.build_list().prefix(prefix).iter() {
        keys.extend(page?.into_keys());
    }
    Ok(keys)
}
