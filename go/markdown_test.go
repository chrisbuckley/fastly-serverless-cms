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

func TestSanitizeBalancesUnclosedIframe(t *testing.T) {
	tests := []struct {
		name    string
		in      string
		want    string
		notWant string
	}{
		{"unclosed allowed iframe closed", `<iframe src="https://www.youtube.com/embed/x">`, `src="https://www.youtube.com/embed/x"`, ""},
		{"unclosed iframe with trailing content", "<iframe src=\"https://www.youtube.com/embed/x\">\n\nafter **bold**", `src="https://www.youtube.com/embed/x"`, ""},
		{"closed then unclosed", "<iframe src=\"https://www.youtube.com/embed/x\"></iframe>\n\n<iframe src=\"https://player.vimeo.com/video/1\">", "player.vimeo.com", ""},
		{"unclosed iframe without src dropped", `<iframe width="560">`, "", "<iframe"},
	}
	for _, tt := range tests {
		got := RenderMarkdown(tt.in)
		opens := strings.Count(got, "<iframe")
		closes := strings.Count(got, "</iframe>")
		if opens != closes {
			t.Errorf("%s: unbalanced iframe tags (%d open, %d close):\n%s", tt.name, opens, closes, got)
		}
		if tt.want != "" && !strings.Contains(got, tt.want) {
			t.Errorf("%s: output missing %q:\n%s", tt.name, tt.want, got)
		}
		if tt.notWant != "" && strings.Contains(got, tt.notWant) {
			t.Errorf("%s: output unexpectedly contains %q:\n%s", tt.name, tt.notWant, got)
		}
	}
}

func TestSanitizePolicy(t *testing.T) {
	tests := []struct {
		name    string
		in      string
		want    []string
		notWant []string
	}{
		{"script removed", "hi <script>alert(1)</script> there", []string{"hi", "there"}, []string{"<script", "alert(1)"}},
		{"onerror removed", `<img src="/images/a/b.png" onerror="alert(1)" alt="x">`, []string{"<img"}, []string{"onerror"}},
		{"javascript href removed", "[x](javascript:alert(1))", []string{"x"}, []string{"javascript:", "<a"}},
		{"javascript href raw html", `<a href="JaVaScRiPt:alert(1)">x</a>`, []string{"x"}, []string{"alert(1)"}},
		{"data href removed", `<a href="data:text/html;base64,AAAA">x</a>`, []string{"x"}, []string{"data:"}},
		{"youtube iframe kept", `<iframe src="https://www.youtube-nocookie.com/embed/abc" width="560" height="315" allowfullscreen></iframe>`, []string{"<iframe", `src="https://www.youtube-nocookie.com/embed/abc"`, `width="560"`}, nil},
		{"vimeo iframe kept", `<iframe src="https://player.vimeo.com/video/1"></iframe>`, []string{"player.vimeo.com"}, nil},
		{"other iframe removed", `<iframe src="https://evil.example/x"></iframe>`, nil, []string{"<iframe", "evil.example"}},
		{"http iframe removed", `<iframe src="http://www.youtube.com/embed/a"></iframe>`, nil, []string{"<iframe"}},
		{"userinfo iframe removed", `<iframe src="https://www.youtube.com@evil.example/x"></iframe>`, nil, []string{"<iframe", "evil.example"}},
		{"iframe without src removed", `<iframe srcdoc="<script>1</script>"></iframe>`, nil, []string{"<iframe", "srcdoc"}},
		{"table kept", "| a | b |\n|---|---|\n| 1 | 2 |", []string{"<table>", "<th>", "<td>"}, nil},
		{"language class kept", "```rust\nfn main() {}\n```", []string{`class="language-rust"`}, nil},
		{"bad class dropped", `<div class="evil language-x">t</div>`, []string{"t"}, []string{"evil"}},
		{"style attr dropped", `<p style="position:fixed">t</p>`, []string{"<p>t</p>"}, []string{"style"}},
		{"external link rel", `[x](https://example.com)`, []string{`rel="noopener noreferrer"`}, nil},
		{"relative link no rel", `[x](/post/a)`, []string{`href="/post/a"`}, []string{"rel="}},
		{"mailto kept", `[x](mailto:a@b.co)`, []string{"mailto:a@b.co"}, nil},
		{"task list disabled", "- [x] done\n- [ ] todo", []string{`type="checkbox"`, "disabled"}, nil},
		{"enabled checkbox forced disabled", `<input type="checkbox">`, []string{`disabled=""`}, nil},
		{"text input removed", `<input type="text" name="x">`, nil, []string{"<input"}},
		{"form removed", `<form action="/x"><button>go</button></form>`, nil, []string{"<form", "<button"}},
		{"style tag removed", `<style>body{display:none}</style>`, nil, []string{"<style"}},
		{"strikethrough kept", "~~gone~~", []string{"<del>gone</del>"}, nil},
		{"details kept", "<details><summary>s</summary>b</details>", []string{"<details>", "<summary>"}, nil},
		{"th align kept", `<table><tr><th align="center">a</th></tr></table>`, []string{`align="center"`}, nil},
	}
	for _, tt := range tests {
		got := RenderMarkdown(tt.in)
		for _, w := range tt.want {
			if !strings.Contains(got, w) {
				t.Errorf("%s: output missing %q:\n%s", tt.name, w, got)
			}
		}
		for _, nw := range tt.notWant {
			if strings.Contains(got, nw) {
				t.Errorf("%s: output unexpectedly contains %q:\n%s", tt.name, nw, got)
			}
		}
	}
}
