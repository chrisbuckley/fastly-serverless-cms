use std::collections::HashMap;
use std::io::Read;
use std::time::Duration;

use fastly::erl::{CounterDuration, Penaltybox, RateCounter};
use fastly::http::StatusCode;
use fastly::secret_store::SecretStore;
use fastly::{Error, KVStore, Request, Response};
use serde::Serialize;
use serde_json::{json, Value};

use crate::auth::{self, Session};
use crate::cache;
use crate::config::Ctx;
use crate::dates;
use crate::error::{self, json_error};
use crate::kv;
use crate::logging;
use crate::models::{Post, PostIndex, PostStatus};
use crate::security;
use crate::templates::{self, PageMeta};
use crate::validation::{self, ImageType};

const LOGIN_LIMIT_PER_MINUTE: u32 = 5;
const LOGIN_PENALTY: Duration = Duration::from_secs(15 * 60);
const MAX_FEATURED_IMAGE_CHARS: usize = 500;

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

fn read_secret(secrets: &SecretStore, name: &str) -> Result<Vec<u8>, Error> {
    secrets
        .try_get(name)?
        .map(|s| s.plaintext().to_vec())
        .ok_or_else(|| Error::msg(format!("missing secret: {name}")))
}

fn redirect(location: &str) -> Response {
    cache::no_cache(Response::from_status(StatusCode::FOUND).with_header("Location", location))
}

fn redirect_to_login(reason: &str) -> Response {
    redirect(&format!("/admin/login?error={reason}"))
}

#[allow(clippy::result_large_err)] // fastly::Response is intentionally large in Compute
fn session_from_request(req: &Request) -> Result<Session, Response> {
    let token = req
        .get_header_str("Cookie")
        .and_then(|h| auth::extract_cookie(h, "session"))
        .ok_or_else(|| redirect_to_login("expired"))?;
    let key = SecretStore::open("secrets")
        .map_err(Error::from)
        .and_then(|s| read_secret(&s, "hmac_key"))
        .map_err(|_| redirect_to_login("error"))?;
    auth::verify_session_token(&key, &token, dates::unix_now())
        .map_err(|_| redirect_to_login("expired"))
}

/// Valid signature, not expired, and not revoked by logout.
#[allow(clippy::result_large_err)] // fastly::Response is intentionally large in Compute
fn require_auth(req: &Request) -> Result<Session, Response> {
    let session = session_from_request(req)?;
    let store = kv::content().map_err(|_| redirect_to_login("error"))?;
    match kv::exists(&store, &auth::revocation_key(&session.nonce)) {
        Ok(false) => Ok(session),
        Ok(true) => Err(redirect_to_login("expired")),
        Err(_) => Err(redirect_to_login("error")),
    }
}

macro_rules! authed {
    ($req:expr) => {
        if let Err(resp) = require_auth($req) {
            return Ok(resp);
        }
    };
}

/// Pure login-limit decision: more than 5 attempts in the 60 s window.
pub fn over_login_limit(count_last_minute: u32) -> bool {
    count_last_minute > LOGIN_LIMIT_PER_MINUTE
}

/// ERL check for `POST /admin/login`. ERL hostcall failures fail open (and
/// are logged) because the VCL rate limiter still fronts this route.
fn login_rate_limited(client: &str) -> bool {
    let penalty = Penaltybox::open("login_penalty");
    let counter = RateCounter::open("login_attempts");
    if penalty.has(client).unwrap_or(false) {
        return true;
    }
    if let Err(e) = counter.increment(client, 1) {
        logging::event("warn", &format!("erl increment failed: {e:?}"));
        return false;
    }
    let count = counter
        .lookup_count(client, CounterDuration::SixtySecs)
        .unwrap_or(0);
    if over_login_limit(count) {
        if let Err(e) = penalty.add(client, LOGIN_PENALTY) {
            logging::event("warn", &format!("erl penalty add failed: {e:?}"));
        }
        return true;
    }
    false
}

// ---------------------------------------------------------------------------
// Request body parsing
// ---------------------------------------------------------------------------

#[derive(Debug, PartialEq, Eq)]
pub struct BodyTooLarge;

/// Read at most `max` bytes: reject on `Content-Length` first, then on the
/// actual stream length (chunked bodies have no Content-Length).
fn read_body(req: &mut Request, max: usize) -> Result<Vec<u8>, BodyTooLarge> {
    if req.get_content_length().is_some_and(|len| len > max) {
        return Err(BodyTooLarge);
    }
    let mut buf = Vec::new();
    req.take_body()
        .take(max as u64 + 1)
        .read_to_end(&mut buf)
        .map_err(|_| BodyTooLarge)?;
    if buf.len() > max {
        Err(BodyTooLarge)
    } else {
        Ok(buf)
    }
}

/// Percent-decode; malformed escapes are kept verbatim rather than dropped.
pub fn url_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < bytes.len() => {
                match std::str::from_utf8(&bytes[i + 1..i + 3])
                    .ok()
                    .and_then(|h| u8::from_str_radix(h, 16).ok())
                {
                    Some(b) => {
                        out.push(b);
                        i += 3;
                        continue;
                    }
                    None => out.push(b'%'),
                }
            }
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub fn parse_form_body(body: &str) -> HashMap<String, String> {
    body.split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| {
            let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
            (url_decode(k), url_decode(v))
        })
        .collect()
}

/// Flatten a JSON object body into string fields; `tags` may be an array.
fn parse_json_fields(body: &[u8]) -> Option<HashMap<String, String>> {
    let Value::Object(map) = serde_json::from_slice(body).ok()? else {
        return None;
    };
    Some(
        map.into_iter()
            .map(|(k, v)| {
                let s = match v {
                    Value::String(s) => s,
                    Value::Array(items) => items
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(","),
                    Value::Null => String::new(),
                    other => other.to_string(),
                };
                (k, s)
            })
            .collect(),
    )
}

fn is_json_content_type(req: &Request) -> bool {
    req.get_header_str("Content-Type").is_some_and(|ct| {
        ct.trim_start()
            .to_ascii_lowercase()
            .starts_with("application/json")
    })
}

/// JSON callers get `{"error"}`; HTML form posts get the editor re-rendered.
pub fn wants_json(content_type: Option<&str>, accept: Option<&str>) -> bool {
    let ct_json = content_type.is_some_and(|ct| {
        ct.trim_start()
            .to_ascii_lowercase()
            .starts_with("application/json")
    });
    let accept = accept.unwrap_or("").to_ascii_lowercase();
    ct_json || (accept.contains("application/json") && !accept.contains("text/html"))
}

// ---------------------------------------------------------------------------
// Post input validation
// ---------------------------------------------------------------------------

#[derive(Debug, PartialEq, Eq)]
pub struct InputError {
    pub status: StatusCode,
    pub message: &'static str,
}

fn bad_request(message: &'static str) -> InputError {
    InputError {
        status: StatusCode::BAD_REQUEST,
        message,
    }
}

fn parse_status(raw: &str) -> Result<PostStatus, InputError> {
    match raw {
        "published" => Ok(PostStatus::Published),
        "draft" => Ok(PostStatus::Draft),
        _ => Err(bad_request("Status must be published or draft")),
    }
}

fn checked_content(raw: String) -> Result<String, InputError> {
    if validation::content_too_large(&raw) {
        Err(InputError {
            status: StatusCode::PAYLOAD_TOO_LARGE,
            message: "Content exceeds 512 KiB",
        })
    } else {
        Ok(raw)
    }
}

/// Featured image must be an http(s) URL or site-relative path; anything
/// else (or anything over 500 chars) is dropped (same policy as sidebar links).
fn featured_image(raw: &str) -> Option<String> {
    let v = raw.trim();
    (v.chars().count() <= MAX_FEATURED_IMAGE_CHARS && validation::is_safe_link_url(v))
        .then(|| v.to_string())
}

fn present<'a>(form: &'a HashMap<String, String>, key: &str) -> Option<&'a str> {
    form.get(key).map(String::as_str)
}

fn non_empty<'a>(form: &'a HashMap<String, String>, key: &str) -> Option<&'a str> {
    present(form, key).filter(|v| !v.is_empty())
}

/// Build a new post from create input (contract §5).
pub fn post_from_create(form: &HashMap<String, String>, now: &str) -> Result<Post, InputError> {
    let slug = present(form, "slug").unwrap_or("").trim().to_string();
    if !validation::is_valid_slug(&slug) {
        return Err(bad_request("Invalid slug"));
    }
    let title =
        validation::validate_title(present(form, "title").unwrap_or("")).map_err(bad_request)?;
    let excerpt = present(form, "excerpt").unwrap_or("").to_string();
    validation::validate_excerpt(&excerpt).map_err(bad_request)?;
    let content = checked_content(present(form, "content").unwrap_or("").to_string())?;
    let status = non_empty(form, "status").map_or(Ok(PostStatus::Draft), parse_status)?;
    Ok(Post {
        slug,
        title,
        content,
        excerpt,
        status,
        created_at: now.to_string(),
        updated_at: now.to_string(),
        tags: validation::normalize_tags(present(form, "tags").unwrap_or("")),
        featured_image: present(form, "featured_image").and_then(featured_image),
        author: "Admin".to_string(),
    })
}

/// Apply update input to an existing post: omitted fields (or empty
/// title/content/slug) keep their existing value.
pub fn post_from_update(
    old: &Post,
    form: &HashMap<String, String>,
    now: &str,
) -> Result<Post, InputError> {
    let slug = non_empty(form, "slug").map_or(old.slug.clone(), |s| s.trim().to_string());
    if !validation::is_valid_slug(&slug) {
        return Err(bad_request("Invalid slug"));
    }
    let title = match non_empty(form, "title") {
        Some(t) => validation::validate_title(t).map_err(bad_request)?,
        None => old.title.clone(),
    };
    let excerpt = present(form, "excerpt").map_or(old.excerpt.clone(), str::to_string);
    validation::validate_excerpt(&excerpt).map_err(bad_request)?;
    let content = match non_empty(form, "content") {
        Some(c) => checked_content(c.to_string())?,
        None => old.content.clone(),
    };
    let status = present(form, "status").map_or(Ok(old.status.clone()), parse_status)?;
    Ok(Post {
        slug,
        title,
        content,
        excerpt,
        status,
        created_at: old.created_at.clone(),
        updated_at: now.to_string(),
        tags: present(form, "tags").map_or(old.tags.clone(), validation::normalize_tags),
        featured_image: present(form, "featured_image")
            .map_or(old.featured_image.clone(), featured_image),
        author: old.author.clone(),
    })
}

/// Surrogate keys to purge after a post write or delete.
pub fn post_purge_keys(posts: &[&Post]) -> Vec<String> {
    let mut keys = vec!["post-index".to_string(), "sidebar".to_string()];
    for post in posts {
        keys.push(format!("post-{}", post.slug));
        keys.extend(post.tags.iter().map(|t| format!("tag-{t}")));
    }
    let mut seen = std::collections::HashSet::new();
    keys.retain(|k| seen.insert(k.clone()));
    keys
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

fn html_page(
    ctx: &Ctx,
    status: StatusCode,
    template: &str,
    meta: &PageMeta,
    data: Value,
) -> Result<Response, Error> {
    let body = templates::render_page(template, &templates::with_layout(ctx, meta, data))?;
    Ok(cache::no_cache(
        Response::from_status(status)
            .with_header("Content-Type", "text/html; charset=utf-8")
            .with_body(body),
    ))
}

#[derive(Serialize)]
struct EditorPost<'a> {
    slug: &'a str,
    title: &'a str,
    content: &'a str,
    excerpt: &'a str,
    status: &'a str,
    tags: Vec<String>,
    tags_str: String,
    featured_image: &'a str,
}

impl<'a> EditorPost<'a> {
    fn from_post(post: &'a Post) -> Self {
        Self {
            slug: &post.slug,
            title: &post.title,
            content: &post.content,
            excerpt: &post.excerpt,
            status: match post.status {
                PostStatus::Published => "published",
                PostStatus::Draft => "draft",
            },
            tags: post.tags.clone(),
            tags_str: post.tags.join(", "),
            featured_image: post.featured_image.as_deref().unwrap_or(""),
        }
    }

    /// Echo submitted values back into the form after a validation error.
    fn from_form(form: &'a HashMap<String, String>, fallback_slug: &'a str) -> Self {
        let field = |k: &str| form.get(k).map(String::as_str).unwrap_or("");
        let tags = validation::normalize_tags(field("tags"));
        Self {
            slug: form.get("slug").map_or(fallback_slug, String::as_str),
            title: field("title"),
            content: field("content"),
            excerpt: field("excerpt"),
            status: if field("status") == "published" {
                "published"
            } else {
                "draft"
            },
            tags_str: tags.join(", "),
            tags,
            featured_image: field("featured_image"),
        }
    }
}

fn render_editor(
    ctx: &Ctx,
    status: StatusCode,
    post: &EditorPost,
    is_new: bool,
    error: Option<&str>,
) -> Result<Response, Error> {
    let (title, path) = if is_new {
        ("New Post", "/admin/posts/new".to_string())
    } else {
        ("Edit Post", format!("/admin/posts/{}/edit", post.slug))
    };
    html_page(
        ctx,
        status,
        "admin-editor",
        &PageMeta::admin(title, &path),
        json!({
            "post": post,
            "is_new": is_new,
            "editing": !is_new,
            "error": error,
        }),
    )
}

/// Validation failure response in the caller's format.
fn input_error(
    ctx: &Ctx,
    json_caller: bool,
    err: InputError,
    form: &HashMap<String, String>,
    slug: &str,
    is_new: bool,
) -> Result<Response, Error> {
    if json_caller {
        Ok(json_error(err.status, err.message))
    } else {
        render_editor(
            ctx,
            err.status,
            &EditorPost::from_form(form, slug),
            is_new,
            Some(err.message),
        )
    }
}

/// Read a create/update body (form or JSON) within the 1 MiB limit.
fn read_post_fields(req: &mut Request) -> Result<HashMap<String, String>, InputError> {
    let body = read_body(req, validation::MAX_BODY_BYTES).map_err(|_| InputError {
        status: StatusCode::PAYLOAD_TOO_LARGE,
        message: "Request body exceeds 1 MiB",
    })?;
    if is_json_content_type(req) {
        parse_json_fields(&body).ok_or(bad_request("Invalid JSON body"))
    } else {
        Ok(parse_form_body(&String::from_utf8_lossy(&body)))
    }
}

// ---------------------------------------------------------------------------
// Login handlers
// ---------------------------------------------------------------------------

pub fn login_page(req: &Request, ctx: &Ctx) -> Result<Response, Error> {
    let error_msg = req.get_query_parameter("error").map(|reason| match reason {
        "invalid" => "Invalid password. Please try again.",
        "expired" => "Session expired. Please log in again.",
        "error" => "An error occurred. Please try again.",
        _ => "Please log in.",
    });
    let meta = PageMeta {
        is_admin: false,
        ..PageMeta::admin("Login", "/admin/login")
    };
    let data = templates::with_layout(ctx, &meta, json!({ "error": error_msg }));
    let html = templates::render("login", &data)?;
    Ok(cache::no_cache(
        Response::from_status(StatusCode::OK)
            .with_header("Content-Type", "text/html; charset=utf-8")
            .with_body(html),
    ))
}

pub fn login_submit(mut req: Request, ctx: &Ctx) -> Result<Response, Error> {
    let client = ctx
        .client_ip
        .map(|ip| ip.to_string())
        .unwrap_or_else(|| "unknown".to_string());
    if login_rate_limited(&client) {
        return Ok(security::too_many_login_attempts());
    }

    let Ok(body) = read_body(&mut req, validation::MAX_BODY_BYTES) else {
        return Ok(json_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "Request body exceeds 1 MiB",
        ));
    };
    let form = parse_form_body(&String::from_utf8_lossy(&body));
    let Some(password) = form.get("password") else {
        return Ok(redirect_to_login("invalid"));
    };

    let Ok(secrets) = SecretStore::open("secrets") else {
        return Ok(redirect_to_login("error"));
    };
    let Ok(hash) = read_secret(&secrets, "admin_password") else {
        return Ok(redirect_to_login("error"));
    };
    if auth::verify_password(password, &String::from_utf8_lossy(&hash)).is_err() {
        return Ok(redirect_to_login("invalid"));
    }

    let (Ok(key), Ok(nonce)) = (read_secret(&secrets, "hmac_key"), auth::new_nonce()) else {
        return Ok(redirect_to_login("error"));
    };
    let token =
        auth::create_session_token(&key, dates::unix_now() + auth::SESSION_TTL_SECS, &nonce);
    Ok(redirect("/admin").with_header("Set-Cookie", auth::session_cookie(&token)))
}

/// Revoke the current session's nonce (if the cookie is valid) and clear it.
pub fn logout(req: &Request) -> Result<Response, Error> {
    if let Ok(session) = session_from_request(req) {
        let ttl = session.expires.saturating_sub(dates::unix_now()).max(60);
        kv::insert_with_ttl(
            &kv::content()?,
            &auth::revocation_key(&session.nonce),
            session.expires.to_string(),
            Duration::from_secs(ttl),
        )?;
    }
    Ok(redirect("/").with_header("Set-Cookie", auth::clear_session_cookie()))
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

pub fn dashboard(req: &Request, ctx: &Ctx) -> Result<Response, Error> {
    authed!(req);
    let index = kv::read_index(&kv::content()?)?;

    let total_posts = index.posts.len();
    let published_count = index.published().len();
    html_page(
        ctx,
        StatusCode::OK,
        "admin-dashboard",
        &PageMeta::admin("Dashboard", "/admin"),
        json!({
            "posts": index.posts,
            "total_posts": total_posts,
            "published_count": published_count,
            "draft_count": total_posts - published_count,
            "purge_failed": req.get_query_parameter("purge") == Some("failed"),
        }),
    )
}

// ---------------------------------------------------------------------------
// Post CRUD
// ---------------------------------------------------------------------------

pub fn new_post(req: &Request, ctx: &Ctx) -> Result<Response, Error> {
    authed!(req);
    let empty = HashMap::new();
    render_editor(
        ctx,
        StatusCode::OK,
        &EditorPost::from_form(&empty, ""),
        true,
        None,
    )
}

pub fn create_post(mut req: Request, ctx: &Ctx) -> Result<Response, Error> {
    authed!(&req);
    let json_caller = wants_json(
        req.get_header_str("Content-Type"),
        req.get_header_str("Accept"),
    );
    let empty = HashMap::new();
    let form = match read_post_fields(&mut req) {
        Ok(f) => f,
        Err(e) => return input_error(ctx, json_caller, e, &empty, "", true),
    };
    let post = match post_from_create(&form, &dates::now_iso8601()) {
        Ok(p) => p,
        Err(e) => return input_error(ctx, json_caller, e, &form, "", true),
    };

    let store = kv::content()?;
    let key = kv::post_key(&post.slug);
    if kv::exists(&store, &key)? {
        let err = InputError {
            status: StatusCode::CONFLICT,
            message: "A post with this slug already exists",
        };
        return input_error(ctx, json_caller, err, &form, "", true);
    }
    store.insert(&key, serde_json::to_string(&post)?)?;
    kv::update_index(&store, |index| index.add(&post))?;

    let purged = cache::purge_keys(&post_purge_keys(&[&post]));
    Ok(redirect(&cache::redirect_target("/admin", purged)))
}

fn load_post(store: &KVStore, slug: &str) -> Result<Option<Post>, Error> {
    if !validation::is_valid_slug(slug) {
        return Ok(None);
    }
    kv::get_json(store, &kv::post_key(slug))
}

pub fn edit_post(req: &Request, ctx: &Ctx, slug: &str) -> Result<Response, Error> {
    authed!(req);
    let Some(post) = load_post(&kv::content()?, slug)? else {
        return Ok(error::not_found(ctx, req.get_path()));
    };
    render_editor(
        ctx,
        StatusCode::OK,
        &EditorPost::from_post(&post),
        false,
        None,
    )
}

/// Write order (contract §8): revision → new post → `_index` → old key
/// (rename only) → purge.
pub fn update_post(mut req: Request, ctx: &Ctx, slug: &str) -> Result<Response, Error> {
    authed!(&req);
    let json_caller = wants_json(
        req.get_header_str("Content-Type"),
        req.get_header_str("Accept"),
    );
    let store = kv::content()?;
    let Some(old) = load_post(&store, slug)? else {
        return Ok(error::not_found(ctx, req.get_path()));
    };
    let empty = HashMap::new();
    let form = match read_post_fields(&mut req) {
        Ok(f) => f,
        Err(e) => return input_error(ctx, json_caller, e, &empty, slug, false),
    };
    let updated = match post_from_update(&old, &form, &dates::now_iso8601()) {
        Ok(p) => p,
        Err(e) => return input_error(ctx, json_caller, e, &form, slug, false),
    };
    let renamed = updated.slug != old.slug;
    if renamed && kv::exists(&store, &kv::post_key(&updated.slug))? {
        let err = InputError {
            status: StatusCode::CONFLICT,
            message: "A post with this slug already exists",
        };
        return input_error(ctx, json_caller, err, &form, slug, false);
    }

    kv::insert_with_ttl(
        &store,
        &format!("rev:{}:{}", old.slug, dates::unix_now()),
        serde_json::to_string(&old)?,
        kv::RETENTION,
    )?;
    store.insert(
        &kv::post_key(&updated.slug),
        serde_json::to_string(&updated)?,
    )?;
    kv::update_index(&store, |index| {
        index.remove(&old.slug);
        index.add(&updated);
    })?;
    if renamed {
        kv::delete(&store, &kv::post_key(&old.slug))?;
    }

    let purged = cache::purge_keys(&post_purge_keys(&[&updated, &old]));
    Ok(redirect(&cache::redirect_target("/admin", purged)))
}

/// Soft delete: copy to `trash:<slug>` (30-day TTL) before removing. A
/// missing post only has its stale index entry (if any) removed.
pub fn delete_post(req: &Request, ctx: &Ctx, slug: &str) -> Result<Response, Error> {
    authed!(req);
    if !validation::is_valid_slug(slug) {
        return Ok(error::not_found(ctx, req.get_path()));
    }
    let store = kv::content()?;
    let Some(post) = load_post(&store, slug)? else {
        kv::update_index(&store, |index| index.remove(slug))?;
        let keys = vec![
            "post-index".to_string(),
            "sidebar".to_string(),
            format!("post-{slug}"),
        ];
        let purged = cache::purge_keys(&keys);
        return Ok(redirect(&cache::redirect_target("/admin", purged)));
    };
    kv::insert_with_ttl(
        &store,
        &format!("trash:{slug}"),
        serde_json::to_string(&post)?,
        kv::RETENTION,
    )?;
    kv::update_index(&store, |index| index.remove(slug))?;
    kv::delete(&store, &kv::post_key(slug))?;

    let purged = cache::purge_keys(&post_purge_keys(&[&post]));
    Ok(redirect(&cache::redirect_target("/admin", purged)))
}

/// Rebuild `_index` from every `post:` key.
pub fn rebuild_index(req: &Request) -> Result<Response, Error> {
    authed!(req);
    let store = kv::content()?;
    let mut posts = Vec::new();
    for key in kv::list_keys(&store, "post:")? {
        if let Some(post) = kv::get_json::<Post>(&store, &key)? {
            posts.push(post);
        }
    }
    kv::replace_index(&store, &PostIndex::from_posts(&posts))?;
    let purged = cache::purge_keys(&["post-index".to_string()]);
    Ok(redirect(&cache::redirect_target("/admin", purged)))
}

// ---------------------------------------------------------------------------
// Image upload
// ---------------------------------------------------------------------------

/// Validated upload target: `(slug, filename, detected type)`.
pub fn validate_upload(slug: &str, filename: &str, body: &[u8]) -> Result<ImageType, InputError> {
    if !validation::is_valid_slug(slug) {
        return Err(bad_request("Invalid slug"));
    }
    let Some(expected) = validation::upload_filename_type(filename) else {
        return Err(bad_request("Invalid filename"));
    };
    match validation::detect_image_type(body) {
        Some(detected) if detected == expected => Ok(detected),
        _ => Err(InputError {
            status: StatusCode::UNSUPPORTED_MEDIA_TYPE,
            message: "Unsupported or mismatched image type",
        }),
    }
}

/// PUT image bytes to Fastly Object Storage using SigV4 signing.
/// POST /admin/images?slug=my-post&filename=hero.jpg, body = raw image bytes.
/// The stored Content-Type is the type detected from magic bytes.
pub fn upload_image(mut req: Request) -> Result<Response, Error> {
    authed!(&req);
    let slug = url_decode(req.get_query_parameter("slug").unwrap_or(""));
    let filename = url_decode(req.get_query_parameter("filename").unwrap_or(""));
    if !validation::is_valid_slug(&slug) || validation::upload_filename_type(&filename).is_none() {
        return Ok(json_error(
            StatusCode::BAD_REQUEST,
            "Invalid slug or filename",
        ));
    }
    let Ok(body) = read_body(&mut req, validation::MAX_UPLOAD_BYTES) else {
        return Ok(json_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "Upload exceeds 10 MiB",
        ));
    };
    let image_type = match validate_upload(&slug, &filename, &body) {
        Ok(t) => t,
        Err(e) => return Ok(json_error(e.status, e.message)),
    };

    put_object(
        &format!("{slug}/{filename}"),
        image_type.content_type(),
        &body,
    )?;

    let purged = cache::purge_keys(&[format!("image-{slug}")]);
    Ok(json_ok(
        json!({ "url": format!("/images/{slug}/{filename}") }),
        purged,
    ))
}

/// 200 JSON body; `"purge_failed": true` is added only when a purge failed.
fn json_ok(mut body: Value, purged: bool) -> Response {
    if !purged {
        body["purge_failed"] = Value::Bool(true);
    }
    cache::no_cache(
        Response::from_status(StatusCode::OK)
            .with_header("Content-Type", "application/json; charset=utf-8")
            .with_body(body.to_string()),
    )
}

fn put_object(object_key: &str, content_type: &str, body: &[u8]) -> Result<(), Error> {
    let secrets = SecretStore::open("secrets")?;
    let secret =
        |name| read_secret(&secrets, name).map(|v| String::from_utf8_lossy(&v).into_owned());
    let access_key_id = secret("fos_access_key_id")?;
    let secret_key = secret("fos_secret_key")?;
    let region = secret("fos_region")?;
    let bucket = secret("fos_bucket")?;

    let host = format!("{region}.object.fastlystorage.app");
    let path = format!("/{bucket}/{object_key}");
    let (datetime, date) = crate::sigv4::utc_datetime();
    let body_hash = crate::sigv4::sha256_hex(body);

    // Canonical headers must be sorted alphabetically by header name.
    let canonical_headers = format!(
        "content-type:{content_type}\nhost:{host}\nx-amz-content-sha256:{body_hash}\nx-amz-date:{datetime}\n"
    );
    let signed_headers = "content-type;host;x-amz-content-sha256;x-amz-date";
    let canonical_request =
        format!("PUT\n{path}\n\n{canonical_headers}\n{signed_headers}\n{body_hash}");
    let credential_scope = format!("{date}/{region}/s3/aws4_request");
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{datetime}\n{credential_scope}\n{}",
        crate::sigv4::sha256_hex(canonical_request.as_bytes())
    );
    let signing_key = crate::sigv4::derive_signing_key(&secret_key, &date, &region, "s3");
    let signature = crate::sigv4::sign(&signing_key, &string_to_sign);
    let authorization = format!(
        "AWS4-HMAC-SHA256 Credential={access_key_id}/{credential_scope}, SignedHeaders={signed_headers}, Signature={signature}"
    );

    let mut resp = Request::put(format!("https://{host}{path}"))
        .with_header("Host", &host)
        .with_header("Content-Type", content_type)
        .with_header("Content-Length", body.len().to_string())
        .with_header("x-amz-date", &datetime)
        .with_header("x-amz-content-sha256", &body_hash)
        .with_header("Authorization", authorization)
        .with_body(body)
        .send("fastly-object-storage")?;

    let status = resp.get_status();
    if status.is_success() {
        return Ok(());
    }
    let err_body = resp.take_body_str();
    logging::event(
        "error",
        &format!(
            "object storage PUT failed: status {} body {}",
            status.as_u16(),
            logging::truncate_bytes(&err_body, 200)
        ),
    );
    Err(Error::msg(format!(
        "object storage PUT failed: {}",
        status.as_u16()
    )))
}

// ---------------------------------------------------------------------------
// Sidebar editor
// ---------------------------------------------------------------------------

pub fn sidebar_page(req: &Request, ctx: &Ctx) -> Result<Response, Error> {
    authed!(req);
    let sidebar = kv::read_sidebar(&kv::content()?)?;
    html_page(
        ctx,
        StatusCode::OK,
        "admin-sidebar",
        &PageMeta::admin("Sidebar", "/admin/sidebar"),
        json!({ "sidebar": templates::sidebar_view(&sidebar) }),
    )
}

pub fn update_sidebar(mut req: Request) -> Result<Response, Error> {
    authed!(&req);
    let Ok(body) = read_body(&mut req, validation::MAX_BODY_BYTES) else {
        return Ok(json_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "Request body exceeds 1 MiB",
        ));
    };
    let sidebar = match validation::parse_sidebar(&body) {
        Ok(s) => s,
        Err(message) => return Ok(json_error(StatusCode::BAD_REQUEST, message)),
    };
    kv::content()?.insert(kv::SIDEBAR_KEY, serde_json::to_string(&sidebar)?)?;

    let purged = cache::purge_keys(&["sidebar".to_string(), "post-index".to_string()]);
    Ok(json_ok(json!({ "ok": true }), purged))
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: &str = "2026-06-01T00:00:00Z";

    fn form(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn existing() -> Post {
        Post {
            slug: "old".into(),
            title: "Old".into(),
            content: "body".into(),
            excerpt: "exc".into(),
            status: PostStatus::Published,
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
            tags: vec!["a".into()],
            featured_image: Some("/images/old/x.jpg".into()),
            author: "Admin".into(),
        }
    }

    #[test]
    fn url_decode_percent_and_plus() {
        assert_eq!(url_decode("my%20file+name.jpg"), "my file name.jpg");
        assert_eq!(url_decode("%C3%A9"), "é");
    }

    #[test]
    fn url_decode_malformed_kept_raw() {
        assert_eq!(url_decode("100%"), "100%");
        assert_eq!(url_decode("%zz"), "%zz");
        assert_eq!(url_decode("a%2"), "a%2");
    }

    #[test]
    fn form_parsing_decodes_keys_and_values() {
        let f = parse_form_body("ti%74le=a+b&empty=&flag");
        assert_eq!(f["title"], "a b");
        assert_eq!(f["empty"], "");
        assert_eq!(f["flag"], "");
    }

    #[test]
    fn json_fields_accept_tag_arrays() {
        let f = parse_json_fields(br#"{"title":"T","tags":["a","b"],"n":null}"#).unwrap();
        assert_eq!(f["title"], "T");
        assert_eq!(f["tags"], "a,b");
        assert_eq!(f["n"], "");
        assert!(parse_json_fields(b"[1]").is_none());
        assert!(parse_json_fields(b"nope").is_none());
    }

    #[test]
    fn json_vs_html_decision() {
        assert!(wants_json(Some("application/json"), None));
        assert!(wants_json(None, Some("application/json")));
        assert!(!wants_json(
            Some("application/x-www-form-urlencoded"),
            Some("text/html,application/xhtml+xml,application/json;q=0.9")
        ));
        assert!(!wants_json(None, None));
    }

    #[test]
    fn create_valid() {
        let p = post_from_create(
            &form(&[
                ("slug", "my-post"),
                ("title", "  T  "),
                ("content", "c"),
                ("tags", "Rust, Edge Compute"),
                ("status", "published"),
                ("featured_image", "/images/my-post/a.jpg"),
            ]),
            NOW,
        )
        .unwrap();
        assert_eq!(p.slug, "my-post");
        assert_eq!(p.title, "T");
        assert_eq!(p.status, PostStatus::Published);
        assert_eq!(p.tags, vec!["rust", "edge-compute"]);
        assert_eq!(p.featured_image.as_deref(), Some("/images/my-post/a.jpg"));
        assert_eq!(p.created_at, NOW);
    }

    #[test]
    fn create_defaults_to_draft() {
        let p = post_from_create(&form(&[("slug", "a"), ("title", "T")]), NOW).unwrap();
        assert_eq!(p.status, PostStatus::Draft);
    }

    #[test]
    fn create_rejections() {
        let cases: [(&[(&str, &str)], u16); 6] = [
            (&[("slug", "Bad Slug"), ("title", "T")], 400),
            (&[("title", "T")], 400),
            (&[("slug", "a"), ("title", "  ")], 400),
            (&[("slug", "a"), ("title", "T"), ("status", "live")], 400),
            (
                &[("slug", "a"), ("title", "T"), ("excerpt", &"x".repeat(501))],
                400,
            ),
            (
                &[
                    ("slug", "a"),
                    ("title", "T"),
                    ("content", &"x".repeat(512 * 1024 + 1)),
                ],
                413,
            ),
        ];
        for (pairs, status) in cases {
            let err = post_from_create(&form(pairs), NOW).unwrap_err();
            assert_eq!(err.status.as_u16(), status, "{pairs:?}");
        }
    }

    #[test]
    fn create_drops_unsafe_featured_image() {
        let p = post_from_create(
            &form(&[
                ("slug", "a"),
                ("title", "T"),
                ("featured_image", "javascript:alert(1)"),
            ]),
            NOW,
        )
        .unwrap();
        assert_eq!(p.featured_image, None);
        let long = format!("/images/{}", "a".repeat(500));
        let p = post_from_create(
            &form(&[("slug", "a"), ("title", "T"), ("featured_image", &long)]),
            NOW,
        )
        .unwrap();
        assert_eq!(p.featured_image, None);
    }

    #[test]
    fn update_keeps_omitted_fields() {
        let p = post_from_update(&existing(), &form(&[]), NOW).unwrap();
        assert_eq!(p.slug, "old");
        assert_eq!(p.title, "Old");
        assert_eq!(p.content, "body");
        assert_eq!(p.excerpt, "exc");
        assert_eq!(p.status, PostStatus::Published);
        assert_eq!(p.tags, vec!["a"]);
        assert_eq!(p.featured_image.as_deref(), Some("/images/old/x.jpg"));
        assert_eq!(p.created_at, "2026-01-01T00:00:00Z");
        assert_eq!(p.updated_at, NOW);
    }

    #[test]
    fn update_empty_title_content_slug_keep_existing() {
        let p = post_from_update(
            &existing(),
            &form(&[("slug", ""), ("title", ""), ("content", "")]),
            NOW,
        )
        .unwrap();
        assert_eq!(p.slug, "old");
        assert_eq!(p.title, "Old");
        assert_eq!(p.content, "body");
    }

    #[test]
    fn update_applies_provided_fields() {
        let p = post_from_update(
            &existing(),
            &form(&[
                ("slug", "new"),
                ("excerpt", ""),
                ("status", "draft"),
                ("tags", ""),
                ("featured_image", ""),
            ]),
            NOW,
        )
        .unwrap();
        assert_eq!(p.slug, "new");
        assert_eq!(p.excerpt, "");
        assert_eq!(p.status, PostStatus::Draft);
        assert!(p.tags.is_empty());
        assert_eq!(p.featured_image, None);
    }

    #[test]
    fn update_rejects_bad_values() {
        assert_eq!(
            post_from_update(&existing(), &form(&[("status", "x")]), NOW)
                .unwrap_err()
                .status,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            post_from_update(&existing(), &form(&[("slug", "../x")]), NOW)
                .unwrap_err()
                .status,
            StatusCode::BAD_REQUEST
        );
    }

    #[test]
    fn purge_keys_cover_old_and_new() {
        let old = existing();
        let mut new = existing();
        new.slug = "new".into();
        new.tags = vec!["a".into(), "b".into()];
        assert_eq!(
            post_purge_keys(&[&new, &old]),
            vec![
                "post-index",
                "sidebar",
                "post-new",
                "tag-a",
                "tag-b",
                "post-old"
            ]
        );
    }

    #[test]
    fn upload_validation() {
        let png = b"\x89PNG\r\n\x1a\n0000";
        assert_eq!(validate_upload("post", "a.png", png), Ok(ImageType::Png));
        assert_eq!(
            validate_upload("post", "a.jpg", png).unwrap_err().status,
            StatusCode::UNSUPPORTED_MEDIA_TYPE
        );
        assert_eq!(
            validate_upload("post", "a.png", b"<svg>")
                .unwrap_err()
                .status,
            StatusCode::UNSUPPORTED_MEDIA_TYPE
        );
        assert_eq!(
            validate_upload("post", "a.svg", png).unwrap_err().status,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            validate_upload("../x", "a.png", png).unwrap_err().status,
            StatusCode::BAD_REQUEST
        );
    }

    #[test]
    fn login_limit_threshold() {
        assert!(!over_login_limit(5));
        assert!(over_login_limit(6));
    }
}
