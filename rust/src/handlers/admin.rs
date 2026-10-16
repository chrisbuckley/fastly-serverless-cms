use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use fastly::http::StatusCode;
use fastly::kv_store::KVStoreError;
use fastly::secret_store::SecretStore;
use fastly::{Error, KVStore, Request, Response};
use serde_json::json;

use crate::cache;
use crate::handlers::public::{read_index, read_sidebar};
use crate::models::{Post, PostStatus, SidebarConfig};
use crate::templates;

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

#[allow(clippy::result_large_err)] // fastly::Response is intentionally large in Compute
fn require_auth(req: &Request) -> Result<(), Response> {
    let cookie_header = req.get_header_str("Cookie").unwrap_or("");
    let token = crate::auth::extract_cookie(cookie_header, "session")
        .ok_or_else(|| redirect_to_login("expired"))?;

    let secrets = SecretStore::open("secrets").map_err(|_| redirect_to_login("error"))?;

    let hmac_secret = secrets
        .try_get("hmac_key")
        .map_err(|_| redirect_to_login("error"))?
        .ok_or_else(|| redirect_to_login("error"))?;

    crate::auth::verify_session_token(&hmac_secret.plaintext(), &token)
        .map_err(|_| redirect_to_login("expired"))
}

fn redirect_to_login(reason: &str) -> Response {
    Response::from_status(StatusCode::FOUND)
        .with_header("Location", format!("/admin/login?error={}", reason))
}

// ---------------------------------------------------------------------------
// Form body parsing
// ---------------------------------------------------------------------------

fn parse_form_body(body: &str) -> HashMap<String, String> {
    body.split('&')
        .filter(|pair| !pair.is_empty())
        .filter_map(|pair| {
            let mut parts = pair.splitn(2, '=');
            let key = parts.next()?;
            let value = parts.next().unwrap_or("");
            Some((key.to_string(), url_decode(value)))
        })
        .collect()
}

/// Form value, or `default()` when the key is absent OR empty (TS: `form[key] || old`).
fn non_empty_or(
    form: &HashMap<String, String>,
    key: &str,
    default: impl FnOnce() -> String,
) -> String {
    form.get(key)
        .filter(|v| !v.is_empty())
        .cloned()
        .unwrap_or_else(default)
}

fn url_decode(s: &str) -> String {
    let s = s.replace('+', " ");
    let mut bytes: Vec<u8> = Vec::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '%' {
            let hex: String = chars.by_ref().take(2).collect();
            if let Ok(byte) = u8::from_str_radix(&hex, 16) {
                bytes.push(byte);
            }
        } else {
            bytes.extend_from_slice(c.to_string().as_bytes());
        }
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

/// Generate a simple ISO 8601 timestamp from the current system time.
fn now_iso8601() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    // Manual formatting: days since epoch -> Y-M-D, remaining -> H:M:S
    let days = secs / 86400;
    let time_of_day = secs % 86400;
    let hours = time_of_day / 3600;
    let minutes = (time_of_day % 3600) / 60;
    let seconds = time_of_day % 60;

    // Calculate year/month/day from days since 1970-01-01
    let (year, month, day) = days_to_ymd(days);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, month, day, hours, minutes, seconds
    )
}

/// Convert days since Unix epoch to (year, month, day).
fn days_to_ymd(days: u64) -> (u64, u64, u64) {
    // Algorithm from http://howardhinnant.github.io/date_algorithms.html
    let z = days + 719468;
    let era = z / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

// ---------------------------------------------------------------------------
// Login handlers
// ---------------------------------------------------------------------------

pub fn login_page(req: &Request) -> Result<Response, Error> {
    let error_msg = req.get_query_parameter("error").map(|reason| match reason {
        "invalid" => "Invalid password. Please try again.",
        "expired" => "Session expired. Please log in again.",
        "error" => "An error occurred. Please try again.",
        _ => "Please log in.",
    });

    let data = json!({
        "error": error_msg,
    });

    let html = templates::render("login", &data)?;
    let resp = Response::from_status(StatusCode::OK)
        .with_header("Content-Type", "text/html; charset=utf-8")
        .with_body(html);

    Ok(cache::no_cache(resp))
}

pub fn login_submit(req: Request) -> Result<Response, Error> {
    // Rate limiting: In production, configure via Fastly's edge rate limiting
    // product to enforce 5 attempts/min per client IP on POST /admin/login.
    // See DESIGN.md for details. When rate limiting triggers, the platform
    // returns a 429 before the request reaches Compute — no app code needed.
    // For observability, log each login attempt:
    let client_ip = req
        .get_client_ip_addr()
        .map(|ip| ip.to_string())
        .unwrap_or_else(|| "unknown".into());
    eprintln!("[login_attempt] ip={}", client_ip);

    let body = req.into_body_str();
    let form = parse_form_body(&body);

    let password = match form.get("password") {
        Some(p) => p.clone(),
        None => {
            return Ok(Response::from_status(StatusCode::FOUND)
                .with_header("Location", "/admin/login?error=invalid"));
        }
    };

    // Read the stored password hash from the Secret Store
    let secrets = match SecretStore::open("secrets") {
        Ok(s) => s,
        Err(_) => {
            return Ok(Response::from_status(StatusCode::FOUND)
                .with_header("Location", "/admin/login?error=error"));
        }
    };

    let hash_secret = match secrets.try_get("admin_password") {
        Ok(Some(s)) => s,
        _ => {
            return Ok(Response::from_status(StatusCode::FOUND)
                .with_header("Location", "/admin/login?error=error"));
        }
    };

    let hash = String::from_utf8_lossy(&hash_secret.plaintext()).to_string();

    // Verify the password
    if crate::auth::verify_password(&password, &hash).is_err() {
        return Ok(Response::from_status(StatusCode::FOUND)
            .with_header("Location", "/admin/login?error=invalid"));
    }

    // Create a session token
    let hmac_secret = match secrets.try_get("hmac_key") {
        Ok(Some(s)) => s,
        _ => {
            return Ok(Response::from_status(StatusCode::FOUND)
                .with_header("Location", "/admin/login?error=error"));
        }
    };

    let token = crate::auth::create_session_token(&hmac_secret.plaintext(), 3600);
    let cookie = crate::auth::session_cookie(&token);

    Ok(Response::from_status(StatusCode::FOUND)
        .with_header("Location", "/admin")
        .with_header("Set-Cookie", cookie))
}

pub fn logout() -> Result<Response, Error> {
    let cookie = crate::auth::clear_session_cookie();
    Ok(Response::from_status(StatusCode::FOUND)
        .with_header("Location", "/")
        .with_header("Set-Cookie", cookie))
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

pub fn dashboard(req: &Request) -> Result<Response, Error> {
    if let Err(resp) = require_auth(req) {
        return Ok(resp);
    }

    let index = read_index()?;

    let total_posts = index.posts.len();
    let published_count = index
        .posts
        .iter()
        .filter(|p| p.status == PostStatus::Published)
        .count();
    let draft_count = total_posts - published_count;

    let data = json!({
        "is_admin": true,
        "posts": index.posts,
        "total_posts": total_posts,
        "published_count": published_count,
        "draft_count": draft_count,
    });

    let html = templates::render_page("admin-dashboard", &data)?;
    let resp = Response::from_status(StatusCode::OK)
        .with_header("Content-Type", "text/html; charset=utf-8")
        .with_body(html);

    Ok(cache::no_cache(resp))
}

// ---------------------------------------------------------------------------
// Post CRUD
// ---------------------------------------------------------------------------

pub fn new_post(req: &Request) -> Result<Response, Error> {
    if let Err(resp) = require_auth(req) {
        return Ok(resp);
    }

    let data = json!({
        "is_admin": true,
        "editing": false,
    });

    let html = templates::render_page("admin-editor", &data)?;
    let resp = Response::from_status(StatusCode::OK)
        .with_header("Content-Type", "text/html; charset=utf-8")
        .with_body(html);

    Ok(cache::no_cache(resp))
}

pub fn create_post(req: Request) -> Result<Response, Error> {
    // Auth check: we need to check auth before consuming the request body,
    // but require_auth takes &Request. We check auth first, then consume body.
    if let Err(resp) = require_auth(&req) {
        return Ok(resp);
    }

    let body = req.into_body_str();
    let form = parse_form_body(&body);

    let slug = form.get("slug").cloned().unwrap_or_default();
    let title = form.get("title").cloned().unwrap_or_default();
    let content = form.get("content").cloned().unwrap_or_default();
    let excerpt = form.get("excerpt").cloned().unwrap_or_default();
    let status_str = form
        .get("status")
        .cloned()
        .unwrap_or_else(|| "draft".into());
    let tags_str = form.get("tags").cloned().unwrap_or_default();
    let featured_image = form
        .get("featured_image")
        .cloned()
        .filter(|s| !s.is_empty());

    let status = if status_str == "published" {
        PostStatus::Published
    } else {
        PostStatus::Draft
    };

    let tags: Vec<String> = tags_str
        .split(',')
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .collect();

    let now = now_iso8601();

    let post = Post {
        slug: slug.clone(),
        title,
        content,
        excerpt,
        status,
        created_at: now.clone(),
        updated_at: now,
        tags,
        featured_image,
        author: "Admin".to_string(),
    };

    // Write post to KV Store
    let store = KVStore::open("content")?.ok_or_else(|| Error::msg("content store not found"))?;
    let post_json = serde_json::to_string(&post)?;
    let key = format!("post:{}", slug);
    store.insert(&key, post_json)?;

    // Update index
    let mut index = read_index()?;
    index.add(&post);
    let index_json = serde_json::to_string(&index)?;
    store.insert("_index", index_json)?;

    // Purge cache
    cache::purge_keys(&["post-index"]);

    Ok(Response::from_status(StatusCode::FOUND).with_header("Location", "/admin"))
}

pub fn edit_post(req: &Request, slug: &str) -> Result<Response, Error> {
    if let Err(resp) = require_auth(req) {
        return Ok(resp);
    }

    let store = KVStore::open("content")?.ok_or_else(|| Error::msg("content store not found"))?;
    let key = format!("post:{}", slug);

    let post: Post = match store.lookup(&key) {
        Ok(mut resp) => {
            let json = resp.take_body().into_string();
            serde_json::from_str(&json)?
        }
        Err(KVStoreError::ItemNotFound) => {
            return crate::error::not_found();
        }
        Err(e) => return Err(e.into()),
    };

    let tags_str = post.tags.join(", ");

    let data = json!({
        "is_admin": true,
        "editing": true,
        "post": {
            "slug": post.slug,
            "title": post.title,
            "content": post.content,
            "excerpt": post.excerpt,
            "status": post.status,
            "tags": post.tags,
            "tags_str": tags_str,
            "featured_image": post.featured_image,
            "author": post.author,
            "created_at": post.created_at,
            "updated_at": post.updated_at,
        },
    });

    let html = templates::render_page("admin-editor", &data)?;
    let resp = Response::from_status(StatusCode::OK)
        .with_header("Content-Type", "text/html; charset=utf-8")
        .with_body(html);

    Ok(cache::no_cache(resp))
}

pub fn update_post(req: Request, slug: &str) -> Result<Response, Error> {
    if let Err(resp) = require_auth(&req) {
        return Ok(resp);
    }

    let store = KVStore::open("content")?.ok_or_else(|| Error::msg("content store not found"))?;
    let old_key = format!("post:{}", slug);

    // Read existing post
    let old_post: Post = match store.lookup(&old_key) {
        Ok(mut resp) => {
            let json = resp.take_body().into_string();
            serde_json::from_str(&json)?
        }
        Err(KVStoreError::ItemNotFound) => {
            return crate::error::not_found();
        }
        Err(e) => return Err(e.into()),
    };

    let body = req.into_body_str();
    let form = parse_form_body(&body);

    let new_slug = non_empty_or(&form, "slug", || slug.to_string());
    let title = non_empty_or(&form, "title", || old_post.title.clone());
    let content = non_empty_or(&form, "content", || old_post.content.clone());
    let excerpt = non_empty_or(&form, "excerpt", || old_post.excerpt.clone());
    let status_str = form
        .get("status")
        .cloned()
        .unwrap_or_else(|| "draft".into());
    let tags_str = form.get("tags").cloned().unwrap_or_default();
    let featured_image = form
        .get("featured_image")
        .cloned()
        .filter(|s| !s.is_empty());

    let status = if status_str == "published" {
        PostStatus::Published
    } else {
        PostStatus::Draft
    };

    let tags: Vec<String> = tags_str
        .split(',')
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .collect();

    let now = now_iso8601();

    let updated_post = Post {
        slug: new_slug.clone(),
        title,
        content,
        excerpt,
        status,
        created_at: old_post.created_at,
        updated_at: now,
        tags,
        featured_image,
        author: old_post.author,
    };

    // Write updated post
    let new_key = format!("post:{}", new_slug);
    let post_json = serde_json::to_string(&updated_post)?;
    store.insert(&new_key, post_json)?;

    // If slug changed, delete the old key
    if new_slug != slug {
        let _ = store.delete(&old_key);
    }

    // Update index
    let mut index = read_index()?;
    if new_slug != slug {
        index.remove(slug);
    }
    index.add(&updated_post);
    let index_json = serde_json::to_string(&index)?;
    store.insert("_index", index_json)?;

    // Purge cache
    let post_key = format!("post-{}", slug);
    let mut purge = vec![post_key.as_str(), "post-index"];
    let new_post_key;
    if new_slug != slug {
        new_post_key = format!("post-{}", new_slug);
        purge.push(&new_post_key);
    }
    cache::purge_keys(&purge);

    Ok(Response::from_status(StatusCode::FOUND).with_header("Location", "/admin"))
}

pub fn delete_post(req: &Request, slug: &str) -> Result<Response, Error> {
    if let Err(resp) = require_auth(req) {
        return Ok(resp);
    }

    let store = KVStore::open("content")?.ok_or_else(|| Error::msg("content store not found"))?;
    let key = format!("post:{}", slug);

    // Delete the post (ignore if not found)
    let _ = store.delete(&key);

    // Remove from index
    let mut index = read_index()?;
    index.remove(slug);
    let index_json = serde_json::to_string(&index)?;
    store.insert("_index", index_json)?;

    // Purge cache
    let post_key = format!("post-{}", slug);
    cache::purge_keys(&[&post_key, "post-index"]);

    Ok(cache::no_cache(
        Response::from_status(StatusCode::FOUND).with_header("Location", "/admin"),
    ))
}

// ---------------------------------------------------------------------------
// Image upload
// ---------------------------------------------------------------------------

fn read_secret(secrets: &SecretStore, name: &str) -> Result<String, Error> {
    let s = secrets
        .try_get(name)?
        .ok_or_else(|| Error::msg(format!("missing secret: {}", name)))?;
    Ok(String::from_utf8_lossy(&s.plaintext()).into_owned())
}

/// PUT image bytes to Fastly Object Storage using SigV4 signing.
/// POST /admin/images?slug=my-post&filename=hero.jpg
/// Body: raw image bytes. Content-Type header must match the file type.
pub fn upload_image(req: Request) -> Result<Response, Error> {
    if let Err(resp) = require_auth(&req) {
        return Ok(resp);
    }

    // get_query_parameter returns the raw value; decode like TS searchParams.
    let slug = url_decode(req.get_query_parameter("slug").unwrap_or("unnamed"));
    let filename = url_decode(req.get_query_parameter("filename").unwrap_or("upload.bin"));
    let content_type = req
        .get_header_str("Content-Type")
        .unwrap_or("application/octet-stream")
        .to_string();

    let body_bytes = req.into_body_bytes();

    eprintln!(
        "[upload_image] slug={} filename={} content_type={} body_bytes={}",
        slug,
        filename,
        content_type,
        body_bytes.len()
    );

    let secrets = SecretStore::open("secrets")?;
    let access_key_id = match read_secret(&secrets, "fos_access_key_id") {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[upload_image] missing secret fos_access_key_id: {}", e);
            return Err(e);
        }
    };
    let secret_key = match read_secret(&secrets, "fos_secret_key") {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[upload_image] missing secret fos_secret_key: {}", e);
            return Err(e);
        }
    };
    let region = match read_secret(&secrets, "fos_region") {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[upload_image] missing secret fos_region: {}", e);
            return Err(e);
        }
    };
    let bucket = match read_secret(&secrets, "fos_bucket") {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[upload_image] missing secret fos_bucket: {}", e);
            return Err(e);
        }
    };

    let host = format!("{}.object.fastlystorage.app", region);
    let path = format!("/{}/{}/{}", bucket, slug, filename);

    eprintln!("[upload_image] PUT https://{}{}", host, path);

    let (datetime, date) = crate::sigv4::utc_datetime();
    let body_hash = crate::sigv4::sha256_hex(&body_bytes);

    // Canonical headers must be sorted alphabetically by header name.
    let canonical_headers = format!(
        "content-type:{}\nhost:{}\nx-amz-content-sha256:{}\nx-amz-date:{}\n",
        content_type, host, body_hash, datetime
    );
    let signed_headers = "content-type;host;x-amz-content-sha256;x-amz-date";

    let canonical_request = format!(
        "PUT\n{}\n\n{}\n{}\n{}",
        path, canonical_headers, signed_headers, body_hash
    );

    let credential_scope = format!("{}/{}/s3/aws4_request", date, region);
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{}\n{}\n{}",
        datetime,
        credential_scope,
        crate::sigv4::sha256_hex(canonical_request.as_bytes())
    );

    let signing_key = crate::sigv4::derive_signing_key(&secret_key, &date, &region, "s3");
    let signature = crate::sigv4::sign(&signing_key, &string_to_sign);

    let auth = format!(
        "AWS4-HMAC-SHA256 Credential={}/{}, SignedHeaders={}, Signature={}",
        access_key_id, credential_scope, signed_headers, signature
    );

    eprintln!(
        "[upload_image] signing datetime={} scope={} body_hash={}",
        datetime, credential_scope, body_hash
    );

    let mut fos_resp = match Request::put(format!("https://{}{}", host, path))
        .with_header("Host", &host)
        .with_header("Content-Type", &content_type)
        .with_header("Content-Length", body_bytes.len().to_string())
        .with_header("x-amz-date", &datetime)
        .with_header("x-amz-content-sha256", &body_hash)
        .with_header("Authorization", auth)
        .with_body(&body_bytes[..])
        .send("fastly-object-storage")
    {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[upload_image] send error: {:#}", e);
            return Err(e.into());
        }
    };

    let status = fos_resp.get_status();
    eprintln!("[upload_image] FOS response status={}", status);

    if !status.is_success() {
        let err_body = fos_resp.take_body_str();
        eprintln!("[upload_image] FOS error body: {}", err_body);
        return Err(Error::msg(format!(
            "FOS PUT failed: {} — {}",
            status, err_body
        )));
    }

    let url = format!("/images/{}/{}", slug, filename);
    eprintln!("[upload_image] success url={}", url);

    let resp = Response::from_status(StatusCode::OK)
        .with_header("Content-Type", "application/json; charset=utf-8")
        .with_body(serde_json::to_string(&json!({ "url": url }))?);

    Ok(cache::no_cache(resp))
}

// ---------------------------------------------------------------------------
// Sidebar editor
// ---------------------------------------------------------------------------

pub fn sidebar_page(req: &Request) -> Result<Response, Error> {
    if let Err(resp) = require_auth(req) {
        return Ok(resp);
    }

    let sidebar = read_sidebar()?;

    let data = json!({
        "is_admin": true,
        "sidebar": sidebar,
    });

    let html = templates::render_page("admin-sidebar", &data)?;
    let resp = Response::from_status(StatusCode::OK)
        .with_header("Content-Type", "text/html; charset=utf-8")
        .with_body(html);

    Ok(cache::no_cache(resp))
}

pub fn update_sidebar(req: Request) -> Result<Response, Error> {
    if let Err(resp) = require_auth(&req) {
        return Ok(resp);
    }

    let body = req.into_body_str();
    let sidebar: SidebarConfig = serde_json::from_str(&body)?;

    let store = KVStore::open("content")?.ok_or_else(|| Error::msg("content store not found"))?;
    let sidebar_json = serde_json::to_string(&sidebar)?;
    store.insert("_sidebar", sidebar_json)?;

    // Purge cache
    cache::purge_keys(&["sidebar"]);

    let resp = Response::from_status(StatusCode::OK)
        .with_header("Content-Type", "application/json; charset=utf-8")
        .with_body(serde_json::to_string(&json!({ "ok": true }))?);

    Ok(cache::no_cache(resp))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_empty_or_uses_value() {
        let mut f = HashMap::new();
        f.insert("slug".to_string(), "new".to_string());
        assert_eq!(non_empty_or(&f, "slug", || "old".into()), "new");
    }

    #[test]
    fn non_empty_or_falls_back_when_absent() {
        let f = HashMap::new();
        assert_eq!(non_empty_or(&f, "slug", || "old".into()), "old");
    }

    #[test]
    fn non_empty_or_falls_back_when_empty() {
        // Matches the TypeScript `form[key] || old` behaviour: an empty slug
        // must never overwrite (and thereby delete) the existing post.
        let mut f = HashMap::new();
        f.insert("slug".to_string(), String::new());
        assert_eq!(non_empty_or(&f, "slug", || "old".into()), "old");
    }

    #[test]
    fn url_decode_percent_and_plus() {
        assert_eq!(url_decode("my%20file+name.jpg"), "my file name.jpg");
    }
}
