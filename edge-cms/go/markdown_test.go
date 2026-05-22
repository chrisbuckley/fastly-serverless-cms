package main

import (
	"strings"
	"testing"
)

func TestRendersHeading(t *testing.T) {
	html := RenderMarkdown("# Hello")
	if !strings.Contains(html, "<h1>Hello</h1>") {
		t.Errorf("expected <h1>Hello</h1>, got: %s", html)
	}
}

func TestRendersBoldAndItalic(t *testing.T) {
	html := RenderMarkdown("**bold** and *italic*")
	if !strings.Contains(html, "<strong>bold</strong>") {
		t.Errorf("expected <strong>bold</strong>, got: %s", html)
	}
	if !strings.Contains(html, "<em>italic</em>") {
		t.Errorf("expected <em>italic</em>, got: %s", html)
	}
}

func TestRendersCodeBlock(t *testing.T) {
	html := RenderMarkdown("```rust\nfn main() {}\n```")
	if !strings.Contains(html, "<code") {
		t.Errorf("expected <code, got: %s", html)
	}
	if !strings.Contains(html, "fn main() {}") {
		t.Errorf("expected fn main() {}, got: %s", html)
	}
}

func TestRendersList(t *testing.T) {
	html := RenderMarkdown("- one\n- two")
	if !strings.Contains(html, "<li>one</li>") {
		t.Errorf("expected <li>one</li>, got: %s", html)
	}
}

func TestRendersImage(t *testing.T) {
	html := RenderMarkdown("![Alt](/img.jpg)")
	if !strings.Contains(html, `src="/img.jpg"`) {
		t.Errorf("expected src=\"/img.jpg\", got: %s", html)
	}
	if !strings.Contains(html, `alt="Alt"`) {
		t.Errorf("expected alt=\"Alt\", got: %s", html)
	}
}

func TestEmptyInput(t *testing.T) {
	html := RenderMarkdown("")
	if strings.TrimSpace(html) != "" {
		t.Errorf("expected empty output, got: %s", html)
	}
}

func TestRewriteImagesWrapsImagesPath(t *testing.T) {
	input := `<p><img src="/images/post/photo.jpg" alt="A photo" /></p>`
	out := RewriteImages(input)

	if !strings.Contains(out, "<picture>") {
		t.Error("should contain picture element")
	}
	if !strings.Contains(out, `type="image/webp"`) {
		t.Error("should have webp source")
	}
	if !strings.Contains(out, "/images/post/photo.jpg?width=480&format=webp 480w") {
		t.Error("should have 480w srcset entry")
	}
	if !strings.Contains(out, "/images/post/photo.jpg?width=800&format=webp 800w") {
		t.Error("should have 800w srcset entry")
	}
	if !strings.Contains(out, "/images/post/photo.jpg?width=1280&format=webp 1280w") {
		t.Error("should have 1280w srcset entry")
	}
	if !strings.Contains(out, `src="/images/post/photo.jpg?width=680"`) {
		t.Error("fallback img should have width=680")
	}
	if !strings.Contains(out, `alt="A photo"`) {
		t.Error("alt text preserved")
	}
	if !strings.Contains(out, `loading="lazy"`) {
		t.Error("lazy loading set")
	}
	if strings.Contains(out, `<img src="/images/`) {
		t.Error("raw img tag removed")
	}
}

func TestRewriteImagesIgnoresNonImagesPath(t *testing.T) {
	input := `<img src="/static/logo.png" alt="Logo" />`
	out := RewriteImages(input)
	if out != input {
		t.Errorf("non-/images/ src must be left unchanged, got: %s", out)
	}
}

func TestRewriteImagesMultiple(t *testing.T) {
	input := `<img src="/images/a/one.jpg" alt="One" />` +
		`<img src="/images/b/two.jpg" alt="Two" />`
	out := RewriteImages(input)
	count := strings.Count(out, "<picture>")
	if count != 2 {
		t.Errorf("both images should be wrapped, got %d <picture> elements", count)
	}
	if !strings.Contains(out, `alt="One"`) {
		t.Error("expected alt=\"One\"")
	}
	if !strings.Contains(out, `alt="Two"`) {
		t.Error("expected alt=\"Two\"")
	}
}

func TestRewriteImagesPassthroughEmpty(t *testing.T) {
	out := RewriteImages("")
	if out != "" {
		t.Errorf("expected empty output, got: %s", out)
	}
}

func TestRewriteImagesMalformedNoClose(t *testing.T) {
	// img tag with no closing > — should not panic
	input := `<img src="/images/a.jpg" alt="X"`
	_ = RewriteImages(input)
	// if we got here, no panic
}
