package main

import (
	"encoding/json"
	"encoding/xml"
	"reflect"
	"strings"
	"testing"
)

func TestParsePage(t *testing.T) {
	tests := []struct {
		in     string
		want   int
		wantOK bool
	}{
		{"", 1, true},
		{"1", 1, true},
		{"7", 7, true},
		{"0", 0, false},
		{"-1", 0, false},
		{"abc", 0, false},
		{"1.5", 0, false},
	}
	for _, tt := range tests {
		got, ok := ParsePage(tt.in)
		if got != tt.want || ok != tt.wantOK {
			t.Errorf("ParsePage(%q) = (%d,%v)", tt.in, got, ok)
		}
	}
}

func TestPaginate(t *testing.T) {
	tests := []struct {
		name              string
		total, page, size int
		want              PageWindow
		ok                bool
	}{
		{"empty list page 1", 0, 1, 10, PageWindow{0, 0, 1, 1}, true},
		{"empty list page 2", 0, 2, 10, PageWindow{}, false},
		{"one page", 5, 1, 10, PageWindow{0, 5, 1, 1}, true},
		{"exact boundary", 10, 1, 10, PageWindow{0, 10, 1, 1}, true},
		{"boundary page 2 out of range", 10, 2, 10, PageWindow{}, false},
		{"second page partial", 11, 2, 10, PageWindow{10, 11, 2, 2}, true},
		{"middle page", 25, 2, 10, PageWindow{10, 20, 2, 3}, true},
		{"last page", 25, 3, 10, PageWindow{20, 25, 3, 3}, true},
		{"beyond last", 25, 4, 10, PageWindow{}, false},
		{"page zero", 25, 0, 10, PageWindow{}, false},
		{"bad size uses default", 25, 3, 0, PageWindow{20, 25, 3, 3}, true},
	}
	for _, tt := range tests {
		got, ok := Paginate(tt.total, tt.page, tt.size)
		if ok != tt.ok || got != tt.want {
			t.Errorf("%s: got (%+v,%v) want (%+v,%v)", tt.name, got, ok, tt.want, tt.ok)
		}
	}
}

func TestPaginationView(t *testing.T) {
	v := paginationView(PageWindow{Page: 1, TotalPages: 3}, "/")
	if v["prev_url"] != nil || v["next_url"] != "/?page=2" || v["page"] != 1 || v["total_pages"] != 3 {
		t.Errorf("page 1: %v", v)
	}
	v = paginationView(PageWindow{Page: 2, TotalPages: 3}, "/tag/go")
	if v["prev_url"] != "/tag/go?page=1" || v["next_url"] != "/tag/go?page=3" {
		t.Errorf("page 2: %v", v)
	}
	v = paginationView(PageWindow{Page: 3, TotalPages: 3}, "/")
	if v["next_url"] != nil || v["prev_url"] != "/?page=2" {
		t.Errorf("page 3: %v", v)
	}
}

func TestFormatRFC822(t *testing.T) {
	tests := []struct{ in, want string }{
		{"2026-05-20T14:30:00Z", "Wed, 20 May 2026 14:30:00 +0000"},
		{"2006-01-02T15:04:05Z", "Mon, 02 Jan 2006 15:04:05 +0000"},
		{"2026-05-20T10:30:00-04:00", "Wed, 20 May 2026 14:30:00 +0000"},
		{"", ""},
		{"2026-05-20", ""},
		{"garbage", ""},
	}
	for _, tt := range tests {
		if got := FormatRFC822(tt.in); got != tt.want {
			t.Errorf("FormatRFC822(%q) = %q want %q", tt.in, got, tt.want)
		}
	}
}

func TestSidebarView(t *testing.T) {
	icon := "github"
	bad := "javascript:alert(1)"
	view := sidebarView(SidebarConfig{Items: []SidebarItem{
		{Type: "category", Label: "Start", Slug: "start", Children: []string{"a", "b"}},
		{Type: "link", Label: "GH", URL: "https://github.com", Icon: &icon},
		{Type: "link", Label: "Evil", URL: bad},
		{Type: "category", Label: "Empty", Slug: "empty"},
	}})
	items := view["items"].([]map[string]interface{})
	if len(items) != 3 {
		t.Fatalf("unsafe link must be omitted, got %d items", len(items))
	}
	cat := items[0]
	if cat["children_csv"] != "a,b" || cat["is_category"] != true || cat["is_link"] != false || cat["slug"] != "start" {
		t.Errorf("category view: %v", cat)
	}
	if !reflect.DeepEqual(cat["children"], []string{"a", "b"}) {
		t.Errorf("children: %v", cat["children"])
	}
	link := items[1]
	if link["url"] != "https://github.com" || link["icon"] != "github" || link["is_link"] != true || link["is_category"] != false {
		t.Errorf("link view: %v", link)
	}
	if !reflect.DeepEqual(items[2]["children"], []string{}) || items[2]["children_csv"] != "" {
		t.Errorf("empty category: %v", items[2])
	}
}

func TestEditorPostShape(t *testing.T) {
	img := "/images/a/b.png"
	v := editorPost(Post{Slug: "s", Title: "T", Content: "c", Excerpt: "e", Status: StatusDraft, Tags: []string{"x", "y"}, FeaturedImage: &img})
	for _, k := range []string{"slug", "title", "content", "excerpt", "status", "tags_str", "featured_image"} {
		if _, ok := v[k]; !ok {
			t.Errorf("missing %s", k)
		}
	}
	if v["tags_str"] != "x, y" || v["featured_image"] != img || v["status"] != "draft" {
		t.Errorf("values: %v", v)
	}
	empty := editorPost(Post{})
	if empty["featured_image"] != "" || empty["tags_str"] != "" {
		t.Errorf("zero post: %v", empty)
	}
}

func TestLayoutVars(t *testing.T) {
	cfg := Config{SiteURL: "https://example.com"}
	v := layoutVars(cfg, "/post/a", "T", "D")
	want := map[string]interface{}{
		"site_url": "https://example.com", "page_title": "T", "meta_description": "D",
		"canonical_url": "https://example.com/post/a", "og_type": "website", "og_image": "",
		"noindex": false, "is_admin": false,
	}
	for k, w := range want {
		if v[k] != w {
			t.Errorf("%s = %v want %v", k, v[k], w)
		}
	}
	if v["asset_version"] == "" {
		t.Error("asset_version must be set")
	}
	for _, removed := range []string{"og_url", "og_title", "og_description", "pop_city", "pop_code"} {
		if _, ok := v[removed]; ok {
			t.Errorf("%s must not be set", removed)
		}
	}
	a := adminVars(cfg, "/admin", "Dashboard")
	if a["noindex"] != true || a["is_admin"] != true || a["meta_description"] == "" {
		t.Errorf("admin vars: %v", a)
	}
}

func TestBuildJSONLD(t *testing.T) {
	post := Post{Title: `A "quoted" </script> title`, Excerpt: "ex", CreatedAt: "2026-05-20T14:30:00Z", Author: "Admin"}
	out := buildJSONLD(Config{SiteURL: "https://e.com"}, post, "https://e.com/post/a", "https://e.com/images/a/b.png")
	if strings.Contains(out, "</") {
		t.Errorf("JSON-LD must not contain </: %s", out)
	}
	normalized := strings.ReplaceAll(out, `<\/`, `</`)
	var doc map[string]interface{}
	if err := json.Unmarshal([]byte(normalized), &doc); err != nil {
		t.Fatalf("invalid JSON: %v\n%s", err, out)
	}
	if doc["@type"] != "BlogPosting" || doc["headline"] != post.Title || doc["image"] != "https://e.com/images/a/b.png" {
		t.Errorf("doc: %v", doc)
	}
	if doc["datePublished"] != "2026-05-20T14:30:00Z" || doc["dateModified"] != "" {
		t.Errorf("dates: %v %v", doc["datePublished"], doc["dateModified"])
	}
	if doc["mainEntityOfPage"] != "https://e.com/post/a" || doc["publisher"].(map[string]interface{})["name"] != "edge/cms" {
		t.Errorf("doc: %v", doc)
	}
	noImg := buildJSONLD(Config{}, post, "https://e.com/post/a", "")
	if strings.Contains(noImg, `"image"`) {
		t.Error("image should be omitted when empty")
	}
}

func TestAbsoluteURLAndEncoding(t *testing.T) {
	tests := []struct{ in, want string }{
		{"/images/a/b.png", "https://e.com/images/a/b.png"},
		{"https://cdn.example/x.png", "https://cdn.example/x.png"},
		{"//cdn.example/x.png", "//cdn.example/x.png"},
		{"", ""},
	}
	for _, tt := range tests {
		if got := absoluteURL("https://e.com", tt.in); got != tt.want {
			t.Errorf("absoluteURL(%q) = %q", tt.in, got)
		}
	}
	if got := percentEncode("It's (a) ~test~ *!"); got != "It's%20(a)%20~test~%20*!" {
		t.Errorf("percentEncode unreserved = %q", got)
	}
	if got := percentEncode("Hello World & more/é"); got != "Hello%20World%20%26%20more%2F%C3%A9" {
		t.Errorf("percentEncode = %q", got)
	}
	if got := percentEncode("https://e.com/post/a"); got != "https%3A%2F%2Fe.com%2Fpost%2Fa" {
		t.Errorf("percentEncode url = %q", got)
	}
}

func TestRobotsTxt(t *testing.T) {
	want := "User-agent: *\nDisallow: /admin\nDisallow: /api/\nSitemap: https://e.com/sitemap.xml\n"
	if got := robotsTxt("https://e.com"); got != want {
		t.Errorf("got %q", got)
	}
}

func TestBuildFeed(t *testing.T) {
	cfg := Config{SiteURL: "https://e.com"}
	posts := []PostMeta{
		{Slug: "b", Title: "Tom & <Jerry>", Excerpt: `say "hi"`, CreatedAt: "2026-05-21T10:00:00Z", Status: StatusPublished},
		{Slug: "a", Title: "A", CreatedAt: "2026-05-20T14:30:00Z", Status: StatusPublished},
	}
	out := buildFeed(cfg, posts)
	var parsed struct {
		Channel struct {
			LastBuild string `xml:"lastBuildDate"`
			Items     []struct {
				Title   string `xml:"title"`
				Link    string `xml:"link"`
				PubDate string `xml:"pubDate"`
			} `xml:"item"`
		} `xml:"channel"`
	}
	if err := xml.Unmarshal([]byte(out), &parsed); err != nil {
		t.Fatalf("feed is not valid XML: %v\n%s", err, out)
	}
	if len(parsed.Channel.Items) != 2 || parsed.Channel.Items[0].Title != "Tom & <Jerry>" {
		t.Errorf("items: %+v", parsed.Channel.Items)
	}
	if parsed.Channel.Items[0].Link != "https://e.com/post/b" {
		t.Errorf("link: %q", parsed.Channel.Items[0].Link)
	}
	if parsed.Channel.Items[0].PubDate != "Thu, 21 May 2026 10:00:00 +0000" || parsed.Channel.LastBuild == "" {
		t.Errorf("dates: %+v", parsed.Channel)
	}
	if !strings.Contains(out, `<atom:link href="https://e.com/feed.xml" rel="self"`) {
		t.Errorf("missing atom:link self:\n%s", out)
	}
	many := make([]PostMeta, 25)
	for i := range many {
		many[i] = PostMeta{Slug: "p", Title: "t", CreatedAt: "2026-05-20T14:30:00Z"}
	}
	if n := strings.Count(buildFeed(cfg, many), "<item>"); n != 20 {
		t.Errorf("feed limit = %d", n)
	}
}

func TestBuildSitemap(t *testing.T) {
	cfg := Config{SiteURL: "https://e.com"}
	idx := PostIndex{Posts: []PostMeta{
		{Slug: "a", Status: StatusPublished, CreatedAt: "2026-05-20T14:30:00Z", UpdatedAt: "2026-05-22T00:00:00Z", Tags: []string{"go"}},
		{Slug: "b", Status: StatusPublished, CreatedAt: "2026-05-21T14:30:00Z"},
		{Slug: "draft", Status: StatusDraft, CreatedAt: "2026-05-21T14:30:00Z", Tags: []string{"secret"}},
	}}
	out := buildSitemap(cfg, idx)
	for _, want := range []string{
		"<loc>https://e.com/</loc>", "<loc>https://e.com/tag/go</loc>",
		"<loc>https://e.com/post/a</loc>", "<lastmod>2026-05-22T00:00:00Z</lastmod>",
		"<loc>https://e.com/post/b</loc>", "<lastmod>2026-05-21T14:30:00Z</lastmod>",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("sitemap missing %q:\n%s", want, out)
		}
	}
	for _, nw := range []string{"draft", "secret", "<loc>/"} {
		if strings.Contains(out, nw) {
			t.Errorf("sitemap must not contain %q", nw)
		}
	}
	if err := xml.Unmarshal([]byte(out), new(interface{})); err != nil {
		t.Errorf("invalid XML: %v", err)
	}
}

func TestBuildConfig(t *testing.T) {
	store := map[string]string{"site_url": "http://127.0.0.1:7676/", "page_ttl": "60", "asset_ttl": "x", "page_size": "0"}
	cfg := buildConfig(func(k string) (string, bool) { v, ok := store[k]; return v, ok }, "ignored")
	want := Config{SiteURL: "http://127.0.0.1:7676", PageTTL: 60, AssetTTL: defaultAssetTTL, PageSize: defaultPageSize}
	if cfg != want {
		t.Errorf("got %+v want %+v", cfg, want)
	}
	def := buildConfig(nil, "blog.example.com")
	want = Config{SiteURL: "https://blog.example.com", PageTTL: 86400, AssetTTL: 31536000, PageSize: 10}
	if def != want {
		t.Errorf("defaults: got %+v want %+v", def, want)
	}
}

func TestPurgeKeyHelpers(t *testing.T) {
	got := postPurgeKeys("a", []string{"x", "y"})
	want := []string{"post-index", "post-a", "sidebar", "tag-x", "tag-y"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("postPurgeKeys = %v", got)
	}
	d := dedupeKeys([]string{"a", "", "b", "a", "c", "b"})
	if !reflect.DeepEqual(d, []string{"a", "b", "c"}) {
		t.Errorf("dedupeKeys = %v", d)
	}
	if withPurgeFlag("/admin", true) != "/admin" || withPurgeFlag("/admin", false) != "/admin?purge=failed" ||
		withPurgeFlag("/admin?x=1", false) != "/admin?x=1&purge=failed" {
		t.Error("withPurgeFlag")
	}
	if surrogateControl(60) != "max-age=60, stale-while-revalidate=60, stale-if-error=86400" {
		t.Errorf("surrogateControl = %q", surrogateControl(60))
	}
}

func TestMarshalLog(t *testing.T) {
	line := marshalLog(logLine{TS: "t", Level: "info", Msg: "request", Method: "GET", Path: "/", Status: 200, DurationMS: 3, ClientIP: "1.2.3.0"})
	var m map[string]interface{}
	if err := json.Unmarshal(line, &m); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"ts", "level", "msg", "method", "path", "status", "duration_ms", "client_ip"} {
		if _, ok := m[k]; !ok {
			t.Errorf("missing %s", k)
		}
	}
}
