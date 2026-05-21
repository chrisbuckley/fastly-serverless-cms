use fastly::{Error, Request, Response};

mod auth;
mod cache;
mod error;
mod handlers;
mod markdown;
mod models;
mod router;
mod templates;

#[fastly::main]
fn main(req: Request) -> Result<Response, Error> {
    let method = req.get_method_str().to_string();
    let path = req.get_path().to_string();

    let result = match router::match_route(&method, &path) {
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

    match result {
        Ok(resp) => Ok(resp),
        Err(e) => {
            eprintln!("error: {}", e);
            error::internal_error()
        }
    }
}
