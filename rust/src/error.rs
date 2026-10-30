use fastly::http::StatusCode;
use fastly::Response;
use serde_json::json;

use crate::cache;
use crate::config::Ctx;
use crate::kv;
use crate::templates::{self, PageMeta};

pub fn not_found(ctx: &Ctx, path: &str) -> Response {
    render_error(ctx, path, StatusCode::NOT_FOUND, "Page not found.")
}

pub fn internal_error(ctx: &Ctx, path: &str) -> Response {
    render_error(
        ctx,
        path,
        StatusCode::INTERNAL_SERVER_ERROR,
        "Something went wrong.",
    )
}

/// Error page (never cached; `security::finalize` also enforces this).
pub fn render_error(ctx: &Ctx, path: &str, status: StatusCode, message: &str) -> Response {
    let code = status.as_u16().to_string();
    let title = format!("{code} Error");
    let meta = PageMeta {
        noindex: true,
        ..PageMeta::public(&title, message, path)
    };
    // Best effort: an error page must render even when the KV read is what failed.
    let all_tags = kv::content()
        .and_then(|store| kv::read_index(&store))
        .map(|index| index.all_tags())
        .unwrap_or_default();
    let data = templates::with_layout(
        ctx,
        &meta,
        json!({
            "error_code": code,
            "error_message": message,
            "sidebar": { "items": [] },
            "all_tags": all_tags,
        }),
    );
    let resp = match templates::render_page("error", &data) {
        Ok(html) => Response::from_status(status)
            .with_header("Content-Type", "text/html; charset=utf-8")
            .with_body(html),
        Err(_) => Response::from_status(status)
            .with_header("Content-Type", "text/plain; charset=utf-8")
            .with_body(format!("{code} {message}\n")),
    };
    cache::no_cache(resp)
}

/// `{"error": "..."}` for API/JSON callers.
pub fn json_error(status: StatusCode, message: &str) -> Response {
    cache::no_cache(
        Response::from_status(status)
            .with_header("Content-Type", "application/json; charset=utf-8")
            .with_body(json!({ "error": message }).to_string()),
    )
}
