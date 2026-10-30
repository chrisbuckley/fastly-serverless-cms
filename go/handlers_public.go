package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"

	"github.com/fastly/compute-sdk-go/fsthttp"
)

// loadPublicContext reads the index and sidebar shared by every public page.
func loadPublicContext() (PostIndex, SidebarConfig, error) {
	index, err := readIndex()
	if err != nil {
		return PostIndex{}, SidebarConfig{}, err
	}
	sidebar, err := readSidebar()
	if err != nil {
		return PostIndex{}, SidebarConfig{}, err
	}
	return index, sidebar, nil
}

func handleEdgeInfo(ctx context.Context, w fsthttp.ResponseWriter, r *fsthttp.Request) {
	pop := os.Getenv("FASTLY_POP")
	if pop == "" {
		pop = "local"
	}
	body, err := json.Marshal(map[string]string{"pop": pop})
	if err != nil {
		handleInternalError(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Surrogate-Control", "no-store")
	w.WriteHeader(fsthttp.StatusOK)
	w.Write(body)
}

// pagePath is the canonical path for a list page.
func pagePath(base string, page int) string {
	if page <= 1 {
		return base
	}
	return fmt.Sprintf("%s?page=%d", base, page)
}

func handleHome(ctx context.Context, w fsthttp.ResponseWriter, r *fsthttp.Request) {
	cfg := loadConfig(r.Host)
	page, ok := ParsePage(r.URL.Query().Get("page"))
	if !ok {
		handleNotFound(w, r)
		return
	}
	index, sidebar, err := loadPublicContext()
	if err != nil {
		logErrorf("home: %v", err)
		handleInternalError(w, r)
		return
	}
	published := index.Published()
	win, ok := Paginate(len(published), page, cfg.PageSize)
	if !ok {
		handleNotFound(w, r)
		return
	}

	data := layoutVars(cfg, pagePath("/", page), "Home", siteDescription)
	data["posts"] = postMetaView(published[win.Start:win.End])
	data["sidebar"] = sidebarView(sidebar)
	data["all_tags"] = index.AllTags()
	data["pagination"] = paginationView(win, "/")
	writeHTMLPage(w, r, cfg, "home", data, "post-index", "sidebar")
}

func handlePost(ctx context.Context, w fsthttp.ResponseWriter, r *fsthttp.Request, slug string) {
	if !ValidSlug(slug) {
		handleNotFound(w, r)
		return
	}
	cfg := loadConfig(r.Host)
	store, err := openContent()
	if err != nil {
		logErrorf("post: %v", err)
		handleInternalError(w, r)
		return
	}
	post, found, err := readPost(store, slug)
	if err != nil {
		logErrorf("post %s: %v", slug, err)
		handleInternalError(w, r)
		return
	}
	if !found || post.Status == StatusDraft {
		handleNotFound(w, r)
		return
	}
	index, sidebar, err := loadPublicContext()
	if err != nil {
		logErrorf("post %s: %v", slug, err)
		handleInternalError(w, r)
		return
	}

	path := "/post/" + slug
	canonical := cfg.SiteURL + path
	image := absoluteURL(cfg.SiteURL, firstNonEmpty(derefString(post.FeaturedImage), firstContentImage(post.Content)))
	description := firstNonEmpty(post.Excerpt, siteDescription)

	data := layoutVars(cfg, path, post.Title, description)
	data["og_type"] = "article"
	data["og_image"] = image
	data["slug"] = post.Slug
	data["title"] = post.Title
	data["content"] = post.Content
	data["excerpt"] = post.Excerpt
	data["created_at"] = post.CreatedAt
	data["updated_at"] = post.UpdatedAt
	data["tags"] = append([]string{}, post.Tags...)
	data["featured_image"] = derefString(post.FeaturedImage)
	data["author"] = post.Author
	data["rendered_content"] = RewriteImages(RenderMarkdown(post.Content))
	data["json_ld"] = buildJSONLD(cfg, post, canonical, image)
	data["share_url_encoded"] = percentEncode(canonical)
	data["share_title_encoded"] = percentEncode(post.Title)
	data["sidebar"] = sidebarView(sidebar)
	data["all_tags"] = index.AllTags()
	writeHTMLPage(w, r, cfg, "post", data, "post-"+slug, "sidebar")
}

func handleTag(ctx context.Context, w fsthttp.ResponseWriter, r *fsthttp.Request, tagName string) {
	if !tagRe.MatchString(tagName) {
		handleNotFound(w, r)
		return
	}
	cfg := loadConfig(r.Host)
	page, ok := ParsePage(r.URL.Query().Get("page"))
	if !ok {
		handleNotFound(w, r)
		return
	}
	index, sidebar, err := loadPublicContext()
	if err != nil {
		logErrorf("tag %s: %v", tagName, err)
		handleInternalError(w, r)
		return
	}
	tagged := index.ByTag(tagName)
	win, ok := Paginate(len(tagged), page, cfg.PageSize)
	if !ok {
		handleNotFound(w, r)
		return
	}

	base := "/tag/" + tagName
	description := fmt.Sprintf("Posts tagged \"%s\"", tagName)
	data := layoutVars(cfg, pagePath(base, page), description, description)
	data["tag"] = tagName
	data["posts"] = postMetaView(tagged[win.Start:win.End])
	data["sidebar"] = sidebarView(sidebar)
	data["all_tags"] = index.AllTags()
	data["pagination"] = paginationView(win, base)
	writeHTMLPage(w, r, cfg, "tag", data, "post-index", "sidebar", "tag-"+tagName)
}

// writeHTMLPage renders a cacheable public page.
func writeHTMLPage(w fsthttp.ResponseWriter, r *fsthttp.Request, cfg Config, name string, data map[string]interface{}, keys ...string) {
	html, err := renderPage(name, data)
	if err != nil {
		logErrorf("render %s: %v", name, err)
		handleInternalError(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	applyPageCache(w, cfg, keys...)
	w.WriteHeader(fsthttp.StatusOK)
	w.Write([]byte(html))
}

func handleFeed(ctx context.Context, w fsthttp.ResponseWriter, r *fsthttp.Request) {
	cfg := loadConfig(r.Host)
	index, err := readIndex()
	if err != nil {
		logErrorf("feed: %v", err)
		handleInternalError(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/rss+xml; charset=utf-8")
	applyFeedCache(w, cfg)
	w.WriteHeader(fsthttp.StatusOK)
	w.Write([]byte(buildFeed(cfg, index.Published())))
}

func handleSitemap(ctx context.Context, w fsthttp.ResponseWriter, r *fsthttp.Request) {
	cfg := loadConfig(r.Host)
	index, err := readIndex()
	if err != nil {
		logErrorf("sitemap: %v", err)
		handleInternalError(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/xml; charset=utf-8")
	applyFeedCache(w, cfg)
	w.WriteHeader(fsthttp.StatusOK)
	w.Write([]byte(buildSitemap(cfg, index)))
}

func handleRobots(ctx context.Context, w fsthttp.ResponseWriter, r *fsthttp.Request) {
	cfg := loadConfig(r.Host)
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	applyFeedCache(w, cfg)
	w.WriteHeader(fsthttp.StatusOK)
	w.Write([]byte(robotsTxt(cfg.SiteURL)))
}
