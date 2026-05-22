use std::time::{SystemTime, UNIX_EPOCH};

use fastly::{Error, Request, Response};

mod auth;
mod cache;
mod error;
mod handlers;
mod markdown;
mod models;
mod router;
mod sigv4;
mod templates;

#[fastly::main]
fn main(req: Request) -> Result<Response, Error> {
    let method = req.get_method_str().to_string();
    let path = req.get_path().to_string();

    let result = match router::match_route(&method, &path) {
        router::Route::EdgeInfo => handlers::public::edge_info(&req),
        router::Route::Home => handlers::public::home(&req),
        router::Route::Post { slug } => handlers::public::post(&req, &slug),
        router::Route::Tag { tag } => handlers::public::tag(&req, &tag),
        router::Route::Image { path } => handlers::assets::image(&req, &path),
        router::Route::Asset { path } => handlers::assets::static_file(&path),
        router::Route::Feed => handlers::public::feed(&req),
        router::Route::Sitemap => handlers::public::sitemap(&req),
        router::Route::Robots => handlers::public::robots(),
        router::Route::AdminLogin => handlers::admin::login_page(&req),
        router::Route::AdminLoginPost => handlers::admin::login_submit(req),
        router::Route::AdminLogout => handlers::admin::logout(),
        router::Route::AdminDashboard => handlers::admin::dashboard(&req),
        router::Route::AdminNewPost => handlers::admin::new_post(&req),
        router::Route::AdminCreatePost => handlers::admin::create_post(req),
        router::Route::AdminEditPost { slug } => handlers::admin::edit_post(&req, &slug),
        router::Route::AdminUpdatePost { slug } => handlers::admin::update_post(req, &slug),
        router::Route::AdminDeletePost { slug } => handlers::admin::delete_post(&req, &slug),
        router::Route::AdminUploadImage => handlers::admin::upload_image(req),
        router::Route::AdminSidebar => handlers::admin::sidebar_page(&req),
        router::Route::AdminUpdateSidebar => handlers::admin::update_sidebar(req),
        router::Route::NotFound => error::not_found(),
    };

    // All eprintln! output is streamed via `fastly log-tail --service-id <compute-sid>`.
    let resp_result = match result {
        Ok(resp) => {
            let timestamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_secs();
            eprintln!(
                "[{}] {} {} {}",
                timestamp,
                method,
                path,
                resp.get_status().as_u16()
            );
            Ok(resp)
        }
        Err(e) => {
            eprintln!("[error] {} {} — {:#}", method, path, e);
            error::internal_error()
        }
    };

    let mut resp = resp_result?;
    if let Ok(v) = std::env::var("FASTLY_SERVICE_VERSION") {
        resp.set_header("X-Edge-CMS-Compute-Version", v);
    }
    Ok(resp)
}
