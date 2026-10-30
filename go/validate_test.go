package main

import (
	"net/http"
	"reflect"
	"strings"
	"testing"
)

func TestValidSlug(t *testing.T) {
	tests := []struct {
		in   string
		want bool
	}{
		{"hello-world", true},
		{"a", true},
		{"a1", true},
		{"0-9", true},
		{"", false},
		{"-a", false},
		{"a-", false},
		{"Hello", false},
		{"a_b", false},
		{"a b", false},
		{"../etc", false},
		{strings.Repeat("a", 100), true},
		{strings.Repeat("a", 101), false},
	}
	for _, tt := range tests {
		if got := ValidSlug(tt.in); got != tt.want {
			t.Errorf("ValidSlug(%q) = %v, want %v", tt.in, got, tt.want)
		}
	}
}

func TestValidateTitle(t *testing.T) {
	tests := []struct {
		name    string
		in      string
		want    string
		wantErr bool
	}{
		{"ok", "  Hello  ", "Hello", false},
		{"empty", "", "", true},
		{"whitespace", "   ", "", true},
		{"max", strings.Repeat("é", 200), strings.Repeat("é", 200), false},
		{"too long", strings.Repeat("a", 201), "", true},
	}
	for _, tt := range tests {
		got, err := ValidateTitle(tt.in)
		if (err != nil) != tt.wantErr || got != tt.want {
			t.Errorf("%s: got (%q, %v)", tt.name, got, err)
		}
		if err != nil && err.(*ValidationError).Status != http.StatusBadRequest {
			t.Errorf("%s: status %d", tt.name, err.(*ValidationError).Status)
		}
	}
}

func TestValidateExcerptAndContent(t *testing.T) {
	if err := ValidateExcerpt(strings.Repeat("a", 500)); err != nil {
		t.Errorf("500 chars should pass: %v", err)
	}
	if err := ValidateExcerpt(strings.Repeat("a", 501)); err == nil {
		t.Error("501 chars should fail")
	}
	if err := ValidateContent(strings.Repeat("a", 512<<10)); err != nil {
		t.Errorf("512KiB should pass: %v", err)
	}
	err := ValidateContent(strings.Repeat("a", 512<<10+1))
	ve, ok := err.(*ValidationError)
	if !ok || ve.Status != http.StatusRequestEntityTooLarge {
		t.Errorf("want 413, got %v", err)
	}
}

func TestParseTags(t *testing.T) {
	many := make([]string, 30)
	for i := range many {
		many[i] = "t" + string(rune('a'+i%26)) + string(rune('a'+i/26))
	}
	tests := []struct {
		name string
		in   string
		want []string
	}{
		{"empty", "", []string{}},
		{"simple", "a, b ,c", []string{"a", "b", "c"}},
		{"lowercase and spaces", "Edge Compute, FASTLY", []string{"edge-compute", "fastly"}},
		{"dedupe", "a,A,a", []string{"a"}},
		{"drop invalid", "ok,-bad,bad!,<x>,,fine", []string{"ok", "fine"}},
		{"too long dropped", strings.Repeat("a", 51) + ",b", []string{"b"}},
		{"max 50 chars kept", strings.Repeat("a", 50), []string{strings.Repeat("a", 50)}},
		{"max 20", strings.Join(many, ","), many[:20]},
	}
	for _, tt := range tests {
		if got := ParseTags(tt.in); !reflect.DeepEqual(got, tt.want) {
			t.Errorf("%s: got %v want %v", tt.name, got, tt.want)
		}
	}
}

func TestParseStatus(t *testing.T) {
	tests := []struct {
		in       string
		fallback PostStatus
		want     PostStatus
		wantErr  bool
	}{
		{"", StatusDraft, StatusDraft, false},
		{"", StatusPublished, StatusPublished, false},
		{"published", StatusDraft, StatusPublished, false},
		{"draft", StatusPublished, StatusDraft, false},
		{"archived", StatusDraft, "", true},
		{"Published", StatusDraft, "", true},
	}
	for _, tt := range tests {
		got, err := ParseStatus(tt.in, tt.fallback)
		if got != tt.want || (err != nil) != tt.wantErr {
			t.Errorf("ParseStatus(%q) = (%q, %v)", tt.in, got, err)
		}
	}
}

func TestValidFilename(t *testing.T) {
	tests := []struct {
		in   string
		want bool
	}{
		{"photo.jpg", true},
		{"a.jpeg", true},
		{"my_image-2.png", true},
		{"x.webp", true},
		{"x.gif", true},
		{"x.svg", false},
		{"X.jpg", false},
		{".jpg", false},
		{"_a.jpg", false},
		{"a/b.jpg", false},
		{"a.jpg.exe", false},
		{"a.JPG", false},
		{strings.Repeat("a", 64) + ".png", true},
		{strings.Repeat("a", 65) + ".png", false},
		{"", false},
	}
	for _, tt := range tests {
		if got := ValidFilename(tt.in); got != tt.want {
			t.Errorf("ValidFilename(%q) = %v, want %v", tt.in, got, tt.want)
		}
	}
}

func TestDetectImageType(t *testing.T) {
	webp := append([]byte("RIFF\x00\x00\x00\x00WEBP"), 'V', 'P', '8', ' ')
	tests := []struct {
		name string
		in   []byte
		want string
	}{
		{"jpeg", []byte{0xFF, 0xD8, 0xFF, 0xE0, 0, 0}, "image/jpeg"},
		{"png", []byte{0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A, 0}, "image/png"},
		{"gif87", []byte("GIF87a...."), "image/gif"},
		{"gif89", []byte("GIF89a...."), "image/gif"},
		{"webp", webp, "image/webp"},
		{"riff not webp", []byte("RIFF\x00\x00\x00\x00WAVEfmt "), ""},
		{"svg", []byte("<svg xmlns='http://www.w3.org/2000/svg'/>"), ""},
		{"html", []byte("<html>"), ""},
		{"short png", []byte{0x89, 'P', 'N', 'G'}, ""},
		{"empty", nil, ""},
		{"short riff", []byte("RIFF"), ""},
	}
	for _, tt := range tests {
		if got := DetectImageType(tt.in); got != tt.want {
			t.Errorf("%s: got %q want %q", tt.name, got, tt.want)
		}
	}
}

func TestImageTypeMatchesFilename(t *testing.T) {
	tests := []struct {
		ct, name string
		want     bool
	}{
		{"image/jpeg", "a.jpg", true},
		{"image/jpeg", "a.jpeg", true},
		{"image/png", "a.png", true},
		{"image/webp", "a.webp", true},
		{"image/gif", "a.gif", true},
		{"image/png", "a.jpg", false},
		{"image/gif", "a.png", false},
		{"", "a.png", false},
		{"image/png", "noext", false},
	}
	for _, tt := range tests {
		if got := ImageTypeMatchesFilename(tt.ct, tt.name); got != tt.want {
			t.Errorf("(%q,%q) = %v want %v", tt.ct, tt.name, got, tt.want)
		}
	}
}

func TestSafeLinkURL(t *testing.T) {
	tests := []struct {
		in   string
		want bool
	}{
		{"https://example.com", true},
		{"http://example.com/a?b=c", true},
		{"/about", true},
		{"/", true},
		{"//evil.com", false},
		{`/\evil.com`, false},
		{`https://a.com/x\y`, false},
		{"/a b", false},
		{"https://a.com/x\ty", false},
		{"javascript:alert(1)", false},
		{"JavaScript:alert(1)", false},
		{"data:text/html,x", false},
		{"mailto:a@b.c", false},
		{"ftp://x", false},
		{"relative/path", false},
		{"", false},
	}
	for _, tt := range tests {
		if got := SafeLinkURL(tt.in); got != tt.want {
			t.Errorf("SafeLinkURL(%q) = %v, want %v", tt.in, got, tt.want)
		}
	}
}

func TestValidateSidebar(t *testing.T) {
	manyItems := `{"items":[` + strings.Repeat(`{"type":"link","label":"a","url":"/x"},`, 50) + `{"type":"link","label":"a","url":"/x"}]}`
	fiftyItems := `{"items":[` + strings.Repeat(`{"type":"link","label":"a","url":"/x"},`, 49) + `{"type":"link","label":"a","url":"/x"}]}`
	tests := []struct {
		name    string
		in      string
		wantErr bool
	}{
		{"valid mix", `{"items":[{"type":"category","label":"Start","slug":"start","children":["a","b"]},{"type":"link","label":"GH","url":"https://github.com","icon":"github"}]}`, false},
		{"empty items", `{"items":[]}`, false},
		{"missing items", `{}`, true},
		{"not json", `nope`, true},
		{"javascript url", `{"items":[{"type":"link","label":"x","url":"javascript:alert(1)"}]}`, true},
		{"protocol relative", `{"items":[{"type":"link","label":"x","url":"//evil.com"}]}`, true},
		{"relative url ok", `{"items":[{"type":"link","label":"x","url":"/about"}]}`, false},
		{"bad icon", `{"items":[{"type":"link","label":"x","url":"/a","icon":"Bad Icon"}]}`, true},
		{"icon too long", `{"items":[{"type":"link","label":"x","url":"/a","icon":"` + strings.Repeat("a", 33) + `"}]}`, true},
		{"empty label", `{"items":[{"type":"link","label":"","url":"/a"}]}`, true},
		{"label too long", `{"items":[{"type":"link","label":"` + strings.Repeat("a", 101) + `","url":"/a"}]}`, true},
		{"bad type", `{"items":[{"type":"widget","label":"x"}]}`, true},
		{"bad category slug", `{"items":[{"type":"category","label":"x","slug":"Bad","children":[]}]}`, true},
		{"bad child slug", `{"items":[{"type":"category","label":"x","slug":"ok","children":["Bad!"]}]}`, true},
		{"51 items", manyItems, true},
		{"50 items", fiftyItems, false},
		{"too big", `{"items":[{"type":"link","label":"x","url":"/` + strings.Repeat("a", 65<<10) + `"}]}`, true},
	}
	for _, tt := range tests {
		_, err := ValidateSidebar([]byte(tt.in))
		if (err != nil) != tt.wantErr {
			t.Errorf("%s: err = %v, wantErr %v", tt.name, err, tt.wantErr)
		}
		if err != nil {
			if ve, ok := err.(*ValidationError); !ok || ve.Status != http.StatusBadRequest {
				t.Errorf("%s: want 400 ValidationError, got %v", tt.name, err)
			}
		}
	}
}

func TestValidateSidebarDropsUnknownFields(t *testing.T) {
	cfg, err := ValidateSidebar([]byte(`{"items":[{"type":"link","label":"x","url":"/a","onclick":"x","slug":"junk"}],"extra":1}`))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Items[0].Slug != "" {
		t.Errorf("link slug should be dropped, got %q", cfg.Items[0].Slug)
	}
}
