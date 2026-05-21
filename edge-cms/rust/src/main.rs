use fastly::http::StatusCode;
use fastly::{Error, Request, Response};

#[fastly::main]
fn main(_req: Request) -> Result<Response, Error> {
    Ok(Response::from_status(StatusCode::OK)
        .with_body_text_plain("edge/cms is running\n"))
}
