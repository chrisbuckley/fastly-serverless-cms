use fastly::http::StatusCode;
use fastly::{Error, Response};
use serde_json::json;

use crate::templates;

pub fn not_found() -> Result<Response, Error> {
    render_error(StatusCode::NOT_FOUND, "404", "Page not found.")
}

pub fn internal_error() -> Result<Response, Error> {
    render_error(
        StatusCode::INTERNAL_SERVER_ERROR,
        "500",
        "Something went wrong.",
    )
}

fn render_error(status: StatusCode, code: &str, message: &str) -> Result<Response, Error> {
    let data = json!({
        "error_code": code,
        "error_message": message,
        "page_title": format!("{} Error", code),
        "sidebar": { "items": [] },
        "pop_city": "Edge",
        "pop_code": "CDN",
    });
    match templates::render_page("error", &data) {
        Ok(html) => Ok(Response::from_status(status)
            .with_header("Content-Type", "text/html; charset=utf-8")
            .with_body(html)),
        Err(_) => Ok(Response::from_status(status).with_body(format!("{} {}\n", code, message))),
    }
}
