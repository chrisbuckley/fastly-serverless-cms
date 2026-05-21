use pulldown_cmark::{html, Options, Parser};

pub fn render_markdown(input: &str) -> String {
    let mut options = Options::empty();
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_TABLES);
    let parser = Parser::new_ext(input, options);
    let mut output = String::new();
    html::push_html(&mut output, parser);
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_heading() {
        assert!(render_markdown("# Hello").contains("<h1>Hello</h1>"));
    }

    #[test]
    fn renders_bold_and_italic() {
        let html = render_markdown("**bold** and *italic*");
        assert!(html.contains("<strong>bold</strong>"));
        assert!(html.contains("<em>italic</em>"));
    }

    #[test]
    fn renders_code_block() {
        let html = render_markdown("```rust\nfn main() {}\n```");
        assert!(html.contains("<code"));
        assert!(html.contains("fn main() {}"));
    }

    #[test]
    fn renders_list() {
        let html = render_markdown("- one\n- two");
        assert!(html.contains("<li>one</li>"));
    }

    #[test]
    fn renders_image() {
        let html = render_markdown("![Alt](/img.jpg)");
        assert!(html.contains("src=\"/img.jpg\""));
        assert!(html.contains("alt=\"Alt\""));
    }

    #[test]
    fn empty_input() {
        assert_eq!(render_markdown("").trim(), "");
    }
}
