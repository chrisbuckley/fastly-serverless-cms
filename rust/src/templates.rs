use handlebars::{Context, Handlebars, Helper, HelperResult, Output, RenderContext, RenderError};
use serde::Serialize;
use std::sync::OnceLock;

static REGISTRY: OnceLock<Handlebars<'static>> = OnceLock::new();

macro_rules! template {
    ($name:expr) => {
        include_str!(concat!(env!("OUT_DIR"), "/templates/", $name))
    };
}

pub static CSS: &str = include_str!(concat!(env!("OUT_DIR"), "/css/style.css"));
pub static ADMIN_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/js/admin.js"));

// Use handlebars_helper! macro so `eq` returns a boolean value usable in
// {{#if (eq field "value")}} subexpressions. The macro-generated helper
// returns a serde_json::Value which handlebars-rs evaluates for truthiness.
handlebars::handlebars_helper!(eq_helper: |a: str, b: str| a == b);

fn init_registry() -> Handlebars<'static> {
    let mut hbs = Handlebars::new();
    hbs.set_strict_mode(false); // allow missing fields to render as empty

    // Register templates
    hbs.register_template_string("layout", template!("layout.hbs"))
        .expect("layout");
    hbs.register_template_string("home", template!("home.hbs"))
        .expect("home");
    hbs.register_template_string("post", template!("post.hbs"))
        .expect("post");
    hbs.register_template_string("tag", template!("tag.hbs"))
        .expect("tag");
    hbs.register_template_string("error", template!("error.hbs"))
        .expect("error");
    hbs.register_template_string("login", template!("login.hbs"))
        .expect("login");
    hbs.register_template_string("admin-dashboard", template!("admin-dashboard.hbs"))
        .expect("admin-dashboard");
    hbs.register_template_string("admin-editor", template!("admin-editor.hbs"))
        .expect("admin-editor");
    hbs.register_template_string("admin-sidebar", template!("admin-sidebar.hbs"))
        .expect("admin-sidebar");

    // Register partials
    hbs.register_partial("_sidebar", template!("_sidebar.hbs"))
        .expect("sidebar partial");

    // Register helpers
    hbs.register_helper("format_date", Box::new(format_date_helper));
    hbs.register_helper("reading_time", Box::new(reading_time_helper));
    hbs.register_helper("eq", Box::new(eq_helper));

    hbs
}

pub fn registry() -> &'static Handlebars<'static> {
    REGISTRY.get_or_init(init_registry)
}

pub fn render<T: Serialize>(template: &str, data: &T) -> Result<String, RenderError> {
    registry().render(template, data)
}

pub fn render_page(template: &str, data: &serde_json::Value) -> Result<String, RenderError> {
    let body = registry().render(template, data)?;
    let mut layout_data = data.clone();
    layout_data
        .as_object_mut()
        .unwrap()
        .insert("body".into(), serde_json::Value::String(body));
    registry().render("layout", &layout_data)
}

// format_date: convert "2026-05-20T14:30:00Z" -> "May 20, 2026"
fn format_date_helper(
    h: &Helper,
    _: &Handlebars,
    _: &Context,
    _: &mut RenderContext,
    out: &mut dyn Output,
) -> HelperResult {
    let date_str = h.param(0).and_then(|v| v.value().as_str()).unwrap_or("");
    if date_str.len() >= 10 {
        let parts: Vec<&str> = date_str[..10].split('-').collect();
        if parts.len() == 3 {
            let month = match parts[1] {
                "01" => "Jan",
                "02" => "Feb",
                "03" => "Mar",
                "04" => "Apr",
                "05" => "May",
                "06" => "Jun",
                "07" => "Jul",
                "08" => "Aug",
                "09" => "Sep",
                "10" => "Oct",
                "11" => "Nov",
                "12" => "Dec",
                _ => "???",
            };
            let day: u32 = parts[2].parse().unwrap_or(0);
            out.write(&format!("{} {}, {}", month, day, parts[0]))?;
            return Ok(());
        }
    }
    out.write(date_str)?;
    Ok(())
}

// reading_time: estimate minutes from word count (200 wpm, min 1)
fn reading_time_helper(
    h: &Helper,
    _: &Handlebars,
    _: &Context,
    _: &mut RenderContext,
    out: &mut dyn Output,
) -> HelperResult {
    let content = h.param(0).and_then(|v| v.value().as_str()).unwrap_or("");
    let minutes = (content.split_whitespace().count() / 200).max(1);
    out.write(&minutes.to_string())?;
    Ok(())
}
