package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"strings"

	"github.com/fastly/compute-sdk-go/fsthttp"
	"github.com/fastly/compute-sdk-go/geo"
	"github.com/fastly/compute-sdk-go/kvstore"
)

func readIndex() (PostIndex, error) {
	store, err := kvstore.Open("content")
	if err != nil {
		return PostIndex{}, fmt.Errorf("open content store: %w", err)
	}
	entry, err := store.Lookup("_index")
	if err != nil {
		return PostIndex{Posts: []PostMeta{}}, nil
	}
	var index PostIndex
	if err := json.Unmarshal([]byte(entry.String()), &index); err != nil {
		return PostIndex{}, fmt.Errorf("parse index: %w", err)
	}
	return index, nil
}

func readSidebar() (SidebarConfig, error) {
	store, err := kvstore.Open("content")
	if err != nil {
		return SidebarConfig{}, fmt.Errorf("open content store: %w", err)
	}
	entry, err := store.Lookup("_sidebar")
	if err != nil {
		return SidebarConfig{Items: []SidebarItem{}}, nil
	}
	var sidebar SidebarConfig
	if err := json.Unmarshal([]byte(entry.String()), &sidebar); err != nil {
		return SidebarConfig{}, fmt.Errorf("parse sidebar: %w", err)
	}
	return sidebar, nil
}

func geoContext(r *fsthttp.Request) (city, popCode string) {
	city, popCode = "Edge", "CDN"
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return
	}
	g, err := geo.Lookup(ip)
	if err != nil {
		return
	}
	if g.City != "" && g.City != "?" {
		city = g.City
	}
	if g.AsName != "" && g.AsName != "?" {
		popCode = g.AsName
	}
	return
}

func xmlEscape(s string) string {
	s = strings.ReplaceAll(s, "&", "&amp;")
	s = strings.ReplaceAll(s, "<", "&lt;")
	s = strings.ReplaceAll(s, ">", "&gt;")
	s = strings.ReplaceAll(s, `"`, "&quot;")
	s = strings.ReplaceAll(s, "'", "&apos;")
	return s
}

func handleEdgeInfo(ctx context.Context, w fsthttp.ResponseWriter, r *fsthttp.Request) {
	pop := os.Getenv("FASTLY_POP")
	if pop == "" {
		pop = "local"
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Surrogate-Control", "no-store")
	w.WriteHeader(fsthttp.StatusOK)
	fmt.Fprintf(w, `{"pop":"%s"}`, pop)
}

func handleHome(ctx context.Context, w fsthttp.ResponseWriter, r *fsthttp.Request) {
	index, err := readIndex()
	if err != nil {
		handleInternalError(w)
		return
	}
	sidebar, err := readSidebar()
	if err != nil {
		handleInternalError(w)
		return
	}
	popCity, popCode := geoContext(r)

	data := map[string]interface{}{
		"posts":    index.Published(),
		"sidebar":  sidebar,
		"pop_city": popCity,
		"pop_code": popCode,
	}
	html, err := renderPage("home", data)
	if err != nil {
		handleInternalError(w)
		return
	}

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	applyCacheHeaders(w, 3600, 60, "post-index", "sidebar")
	w.WriteHeader(fsthttp.StatusOK)
	w.Write([]byte(html))
}

func handlePost(ctx context.Context, w fsthttp.ResponseWriter, r *fsthttp.Request, slug string) {
	store, err := kvstore.Open("content")
	if err != nil {
		handleInternalError(w)
		return
	}
	entry, err := store.Lookup("post:" + slug)
	if err != nil {
		handleNotFound(w)
		return
	}
	var post Post
	if err := json.Unmarshal([]byte(entry.String()), &post); err != nil {
		handleInternalError(w)
		return
	}
	if post.Status == StatusDraft {
		handleNotFound(w)
		return
	}

	sidebar, err := readSidebar()
	if err != nil {
		handleInternalError(w)
		return
	}
	popCity, popCode := geoContext(r)
	renderedContent := RewriteImages(RenderMarkdown(post.Content))
	canonicalURL := "/post/" + slug

	data := map[string]interface{}{
		"slug":             post.Slug,
		"title":            post.Title,
		"content":          post.Content,
		"excerpt":          post.Excerpt,
		"created_at":       post.CreatedAt,
		"updated_at":       post.UpdatedAt,
		"tags":             post.Tags,
		"featured_image":   post.FeaturedImage,
		"author":           post.Author,
		"rendered_content": renderedContent,
		"canonical_url":    canonicalURL,
		"page_title":       post.Title,
		"og_title":         post.Title,
		"og_description":   post.Excerpt,
		"og_type":          "article",
		"og_image":         post.FeaturedImage,
		"og_url":           canonicalURL,
		"sidebar":          sidebar,
		"pop_city":         popCity,
		"pop_code":         popCode,
	}
	html, err := renderPage("post", data)
	if err != nil {
		handleInternalError(w)
		return
	}

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	applyCacheHeaders(w, 3600, 60, "post-"+slug, "sidebar")
	w.WriteHeader(fsthttp.StatusOK)
	w.Write([]byte(html))
}

func handleTag(ctx context.Context, w fsthttp.ResponseWriter, r *fsthttp.Request, tagName string) {
	index, err := readIndex()
	if err != nil {
		handleInternalError(w)
		return
	}
	sidebar, err := readSidebar()
	if err != nil {
		handleInternalError(w)
		return
	}
	popCity, popCode := geoContext(r)

	data := map[string]interface{}{
		"tag":        tagName,
		"posts":      index.ByTag(tagName),
		"sidebar":    sidebar,
		"pop_city":   popCity,
		"pop_code":   popCode,
		"page_title": fmt.Sprintf("Posts tagged \"%s\"", tagName),
	}
	html, err := renderPage("tag", data)
	if err != nil {
		handleInternalError(w)
		return
	}

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	applyCacheHeaders(w, 3600, 60, "post-index", "sidebar")
	w.WriteHeader(fsthttp.StatusOK)
	w.Write([]byte(html))
}

func handleFeed(ctx context.Context, w fsthttp.ResponseWriter, r *fsthttp.Request) {
	index, err := readIndex()
	if err != nil {
		handleInternalError(w)
		return
	}
	published := index.Published()
	limit := 20
	if len(published) < limit {
		limit = len(published)
	}

	var xml strings.Builder
	xml.WriteString("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<rss version=\"2.0\">\n<channel>\n  <title>edge/cms</title>\n  <description>A CMS running entirely on Fastly Compute</description>\n  <link>/</link>\n")
	for _, post := range published[:limit] {
		xml.WriteString("  <item>\n")
		fmt.Fprintf(&xml, "    <title>%s</title>\n", xmlEscape(post.Title))
		fmt.Fprintf(&xml, "    <link>/post/%s</link>\n", post.Slug)
		fmt.Fprintf(&xml, "    <guid isPermaLink=\"true\">/post/%s</guid>\n", post.Slug)
		fmt.Fprintf(&xml, "    <description>%s</description>\n", xmlEscape(post.Excerpt))
		fmt.Fprintf(&xml, "    <pubDate>%s</pubDate>\n", post.CreatedAt)
		xml.WriteString("  </item>\n")
	}
	xml.WriteString("</channel>\n</rss>\n")

	w.Header().Set("Content-Type", "application/rss+xml; charset=utf-8")
	applyCacheHeaders(w, 3600, 60, "post-index")
	w.WriteHeader(fsthttp.StatusOK)
	w.Write([]byte(xml.String()))
}

func handleSitemap(ctx context.Context, w fsthttp.ResponseWriter, r *fsthttp.Request) {
	index, err := readIndex()
	if err != nil {
		handleInternalError(w)
		return
	}

	var xml strings.Builder
	xml.WriteString("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n  <url>\n    <loc>/</loc>\n  </url>\n")
	for _, post := range index.Published() {
		xml.WriteString("  <url>\n")
		fmt.Fprintf(&xml, "    <loc>/post/%s</loc>\n", post.Slug)
		if len(post.CreatedAt) >= 10 {
			fmt.Fprintf(&xml, "    <lastmod>%s</lastmod>\n", post.CreatedAt[:10])
		}
		xml.WriteString("  </url>\n")
	}
	xml.WriteString("</urlset>\n")

	w.Header().Set("Content-Type", "application/xml; charset=utf-8")
	applyCacheHeaders(w, 3600, 60, "post-index")
	w.WriteHeader(fsthttp.StatusOK)
	w.Write([]byte(xml.String()))
}

func handleRobots(ctx context.Context, w fsthttp.ResponseWriter, r *fsthttp.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(fsthttp.StatusOK)
	w.Write([]byte("User-agent: *\nAllow: /\nSitemap: /sitemap.xml\n"))
}
