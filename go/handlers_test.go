package main

import (
	"net/http"
	"reflect"
	"strings"
	"testing"

	"github.com/fastly/compute-sdk-go/fsthttp"
)

func TestCleanFeaturedImage(t *testing.T) {
	tests := []struct {
		in   string
		want bool
	}{
		{"/images/a/b.png", true},
		{"https://cdn.example/x.png", true},
		{"", false},
		{"javascript:alert(1)", false},
		{"//evil.com/x.png", false},
		{"/" + strings.Repeat("a", 500), false},
		{"/" + strings.Repeat("a", 499), true},
	}
	for _, tt := range tests {
		if got := CleanFeaturedImage(tt.in) != nil; got != tt.want {
			t.Errorf("CleanFeaturedImage(%.20q) kept=%v want %v", tt.in, got, tt.want)
		}
	}
}

func TestWantsJSON(t *testing.T) {
	tests := []struct {
		name, contentType, accept string
		want                      bool
	}{
		{"json body", "application/json", "", true},
		{"json body charset", "Application/JSON; charset=utf-8", "", true},
		{"accept json", "", "application/json", true},
		{"accept json and html", "", "text/html,application/json", false},
		{"browser form", "application/x-www-form-urlencoded", "text/html,*/*", false},
		{"nothing", "", "", false},
	}
	for _, tt := range tests {
		r := &fsthttp.Request{Header: fsthttp.NewHeader()}
		r.Header.Set("Content-Type", tt.contentType)
		r.Header.Set("Accept", tt.accept)
		if got := wantsJSON(r); got != tt.want {
			t.Errorf("%s: got %v want %v", tt.name, got, tt.want)
		}
	}
}

func TestParseFormBodyNeverFails(t *testing.T) {
	got := parseFormBody("title=Hello+World&bad=%zz&tags=a%2Cb&flag&%41=x")
	want := map[string]string{"title": "Hello World", "bad": "%zz", "tags": "a,b", "flag": "", "A": "x"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %v want %v", got, want)
	}
}

func TestParseFieldsJSON(t *testing.T) {
	got, err := parseFields("application/json", []byte(`{"title":"T","tags":["a","b"],"excerpt":null,"n":5}`))
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{"title": "T", "tags": "a,b", "excerpt": ""}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %v want %v", got, want)
	}
	if _, err := parseFields("application/json", []byte(`nope`)); err == nil {
		t.Error("invalid JSON must fail")
	}
}

func TestBuildNewPost(t *testing.T) {
	good := map[string]string{"slug": "a-b", "title": " T ", "content": "c", "tags": "X, y", "status": "published", "featured_image": "javascript:x"}
	p, err := buildNewPost(good)
	if err != nil {
		t.Fatal(err)
	}
	if p.Title != "T" || p.Status != StatusPublished || !reflect.DeepEqual(p.Tags, []string{"x", "y"}) || p.FeaturedImage != nil || p.Author != "Admin" {
		t.Errorf("post: %+v", p)
	}
	tests := []struct {
		name   string
		mutate func(map[string]string)
		status int
	}{
		{"empty slug", func(m map[string]string) { m["slug"] = "" }, http.StatusBadRequest},
		{"bad slug", func(m map[string]string) { m["slug"] = "Bad" }, http.StatusBadRequest},
		{"empty title", func(m map[string]string) { m["title"] = "  " }, http.StatusBadRequest},
		{"long excerpt", func(m map[string]string) { m["excerpt"] = strings.Repeat("a", 501) }, http.StatusBadRequest},
		{"huge content", func(m map[string]string) { m["content"] = strings.Repeat("a", 512<<10+1) }, http.StatusRequestEntityTooLarge},
		{"bad status", func(m map[string]string) { m["status"] = "x" }, http.StatusBadRequest},
	}
	for _, tt := range tests {
		m := map[string]string{}
		for k, v := range good {
			m[k] = v
		}
		tt.mutate(m)
		_, err := buildNewPost(m)
		if err == nil {
			t.Errorf("%s: expected error", tt.name)
			continue
		}
		if status, _ := failureStatus(err); status != tt.status {
			t.Errorf("%s: status %d want %d", tt.name, status, tt.status)
		}
	}
	draft, err := buildNewPost(map[string]string{"slug": "a", "title": "t"})
	if err != nil || draft.Status != StatusDraft {
		t.Errorf("missing status should default to draft: %+v %v", draft, err)
	}
}

func TestMergePostUpdate(t *testing.T) {
	img := "/images/a/b.png"
	old := Post{Slug: "old", Title: "Old", Content: "body", Excerpt: "ex", Status: StatusPublished,
		CreatedAt: "c", UpdatedAt: "u", Tags: []string{"t"}, FeaturedImage: &img, Author: "Admin"}

	kept, err := mergePostUpdate(old, map[string]string{}, "now")
	if err != nil {
		t.Fatal(err)
	}
	want := old
	want.UpdatedAt = "now"
	if !reflect.DeepEqual(kept, want) {
		t.Errorf("omitted fields must keep values: %+v", kept)
	}

	kept, err = mergePostUpdate(old, map[string]string{"slug": "", "title": "", "content": "", "tags": "a,B"}, "now")
	if err != nil || kept.Slug != "old" || kept.Title != "Old" || kept.Content != "body" || !reflect.DeepEqual(kept.Tags, []string{"a", "b"}) {
		t.Errorf("empty slug/title/content keep existing: %+v %v", kept, err)
	}

	cleared, err := mergePostUpdate(old, map[string]string{"excerpt": "", "featured_image": ""}, "now")
	if err != nil || cleared.Excerpt != "" || cleared.FeaturedImage != nil {
		t.Errorf("present-but-empty excerpt/image clears: %+v %v", cleared, err)
	}

	renamed, err := mergePostUpdate(old, map[string]string{"slug": "new", "status": "draft", "title": "New"}, "now")
	if err != nil || renamed.Slug != "new" || renamed.Status != StatusDraft || renamed.Title != "New" || renamed.CreatedAt != "c" {
		t.Errorf("rename: %+v %v", renamed, err)
	}

	for name, fields := range map[string]map[string]string{
		"empty status": {"status": ""},
		"bad status":   {"status": "nope"},
		"bad slug":     {"slug": "Bad Slug"},
		"long title":   {"title": strings.Repeat("a", 201)},
		"long excerpt": {"excerpt": strings.Repeat("a", 501)},
		"huge content": {"content": strings.Repeat("a", 512<<10+1)},
	} {
		if _, err := mergePostUpdate(old, fields, "now"); err == nil {
			t.Errorf("%s: expected error", name)
		}
	}
}

func TestSignedUploadHeaders(t *testing.T) {
	creds := fosCredentials{accessKeyID: "AKID", secretKey: "secret", region: "us-east", bucket: "bkt"}
	body := []byte("data")
	auth, hash := signedUploadHeaders(creds, "us-east.object.fastlystorage.app", "/bkt/slug/a.png", "image/png", body, "20260521T134000Z", "20260521")
	if hash != sha256Hex(body) {
		t.Errorf("payload hash = %s", hash)
	}
	for _, want := range []string{
		"AWS4-HMAC-SHA256 Credential=AKID/20260521/us-east/s3/aws4_request",
		"SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date",
		"Signature=",
	} {
		if !strings.Contains(auth, want) {
			t.Errorf("authorization missing %q: %s", want, auth)
		}
	}
	other, _ := signedUploadHeaders(creds, "us-east.object.fastlystorage.app", "/bkt/slug/a.png", "image/jpeg", body, "20260521T134000Z", "20260521")
	if other == auth {
		t.Error("content type must be part of the signature")
	}
}

func TestLoginOverLimit(t *testing.T) {
	for count, want := range map[uint32]bool{0: false, 1: false, 5: false, 6: true, 100: true} {
		if loginOverLimit(count) != want {
			t.Errorf("loginOverLimit(%d) != %v", count, want)
		}
	}
}

func TestLoginErrorMessage(t *testing.T) {
	if loginErrorMessage("") != nil || loginErrorMessage("bogus") != nil {
		t.Error("unknown codes must yield nil")
	}
	for _, code := range []string{"invalid", "expired", "error"} {
		if s, ok := loginErrorMessage(code).(string); !ok || s == "" {
			t.Errorf("code %s: no message", code)
		}
	}
}
