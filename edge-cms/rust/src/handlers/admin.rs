use fastly::http::StatusCode;
use fastly::{Error, Request, Response};

pub fn login_page(_req: &Request) -> Result<Response, Error> {
    Ok(Response::from_status(StatusCode::NOT_IMPLEMENTED).with_body_text_plain("TODO\n"))
}

pub fn login_submit(_req: Request) -> Result<Response, Error> {
    Ok(Response::from_status(StatusCode::NOT_IMPLEMENTED).with_body_text_plain("TODO\n"))
}

pub fn logout() -> Result<Response, Error> {
    Ok(Response::from_status(StatusCode::NOT_IMPLEMENTED).with_body_text_plain("TODO\n"))
}

pub fn dashboard(_req: &Request) -> Result<Response, Error> {
    Ok(Response::from_status(StatusCode::NOT_IMPLEMENTED).with_body_text_plain("TODO\n"))
}

pub fn new_post(_req: &Request) -> Result<Response, Error> {
    Ok(Response::from_status(StatusCode::NOT_IMPLEMENTED).with_body_text_plain("TODO\n"))
}

pub fn create_post(_req: Request) -> Result<Response, Error> {
    Ok(Response::from_status(StatusCode::NOT_IMPLEMENTED).with_body_text_plain("TODO\n"))
}

pub fn edit_post(_req: &Request, _slug: &str) -> Result<Response, Error> {
    Ok(Response::from_status(StatusCode::NOT_IMPLEMENTED).with_body_text_plain("TODO\n"))
}

pub fn update_post(_req: Request, _slug: &str) -> Result<Response, Error> {
    Ok(Response::from_status(StatusCode::NOT_IMPLEMENTED).with_body_text_plain("TODO\n"))
}

pub fn delete_post(_req: &Request, _slug: &str) -> Result<Response, Error> {
    Ok(Response::from_status(StatusCode::NOT_IMPLEMENTED).with_body_text_plain("TODO\n"))
}

pub fn upload_image(_req: Request) -> Result<Response, Error> {
    Ok(Response::from_status(StatusCode::NOT_IMPLEMENTED).with_body_text_plain("TODO\n"))
}

pub fn sidebar_page(_req: &Request) -> Result<Response, Error> {
    Ok(Response::from_status(StatusCode::NOT_IMPLEMENTED).with_body_text_plain("TODO\n"))
}

pub fn update_sidebar(_req: Request) -> Result<Response, Error> {
    Ok(Response::from_status(StatusCode::NOT_IMPLEMENTED).with_body_text_plain("TODO\n"))
}
