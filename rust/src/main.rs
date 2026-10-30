use std::time::Instant;

use fastly::secret_store::SecretStore;
use fastly::{Error, Request, Response};

mod auth;
mod cache;
mod config;
mod dates;
mod error;
mod handlers;
mod kv;
mod logging;
mod markdown;
mod models;
mod pagination;
mod router;
mod security;
mod sigv4;
mod templates;
mod validation;

use config::Ctx;
use router::Route;

/// Origin auth (contract §1): the VCL service injects the shared secret; any
/// request without it — or with the secret missing from the store — is 403.
fn origin_authenticated(req: &Request) -> bool {
    let expected = SecretStore::open("secrets")
        .ok()
        .and_then(|s| s.try_get("origin_auth_token").ok().flatten())
        .map(|s| s.plaintext());
    security::origin_auth_ok(
        expected.as_deref(),
        req.get_header(security::ORIGIN_AUTH_HEADER)
            .map(|v| v.as_bytes()),
    )
}

fn csrf_ok(req: &Request, ctx: &Ctx) -> bool {
    security::csrf_allowed(
        req.get_header_str("Sec-Fetch-Site"),
        req.get_header_str("Origin"),
        &ctx.site_url,
    )
}

fn dispatch(req: Request, ctx: &Ctx, method: &str, path: &str) -> Result<Response, Error> {
    use handlers::{admin, assets, public};
    match router::match_route(method, path) {
        Route::EdgeInfo => public::edge_info(),
        Route::Home => public::home(&req, ctx),
        Route::Post { slug } => public::post(ctx, &slug),
        Route::Tag { tag } => public::tag(&req, ctx, &tag),
        Route::Asset { path } => Ok(assets::static_file(&path)),
        Route::Feed => public::feed(ctx),
        Route::Sitemap => public::sitemap(ctx),
        Route::Robots => public::robots(ctx),
        Route::AdminLogin => admin::login_page(&req, ctx),
        Route::AdminLoginPost => admin::login_submit(req, ctx),
        Route::AdminLogout => admin::logout(&req),
        Route::AdminDashboard => admin::dashboard(&req, ctx),
        Route::AdminNewPost => admin::new_post(&req, ctx),
        Route::AdminCreatePost => admin::create_post(req, ctx),
        Route::AdminEditPost { slug } => admin::edit_post(&req, ctx, &slug),
        Route::AdminUpdatePost { slug } => admin::update_post(req, ctx, &slug),
        Route::AdminDeletePost { slug } => admin::delete_post(&req, ctx, &slug),
        Route::AdminUploadImage => admin::upload_image(req),
        Route::AdminSidebar => admin::sidebar_page(&req, ctx),
        Route::AdminUpdateSidebar => admin::update_sidebar(req),
        Route::AdminRebuildIndex => admin::rebuild_index(&req),
        Route::NotFound => Ok(error::not_found(ctx, path)),
    }
}

/// Returns the response and the (truncatable) client IP for logging.
fn handle(req: Request, method: &str, path: &str) -> (Response, Option<std::net::IpAddr>) {
    if !origin_authenticated(&req) {
        return (security::forbidden(), req.get_client_ip_addr());
    }
    let ctx = Ctx::from_request(&req);
    if security::needs_csrf_check(method, path) && !csrf_ok(&req, &ctx) {
        return (security::forbidden(), ctx.client_ip);
    }
    let resp = match dispatch(req, &ctx, method, path) {
        Ok(resp) => resp,
        Err(e) => {
            logging::event(
                "error",
                &format!(
                    "{method} {path}: {}",
                    logging::truncate_bytes(&format!("{e:#}"), 200)
                ),
            );
            error::internal_error(&ctx, path)
        }
    };
    (resp, ctx.client_ip)
}

#[fastly::main]
fn main(req: Request) -> Result<Response, Error> {
    let started = Instant::now();
    let method = req.get_method_str().to_string();
    let path = req.get_path().to_string();

    let (resp, client_ip) = handle(req, &method, &path);
    let resp = security::finalize(resp, &path, &config::asset_version());

    let status = resp.get_status().as_u16();
    logging::request(&logging::RequestLog {
        level: if status >= 500 { "error" } else { "info" },
        msg: "request",
        method: &method,
        path: &path,
        status,
        duration_ms: started.elapsed().as_millis(),
        client_ip,
    });
    Ok(resp)
}
