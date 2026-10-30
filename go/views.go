package main

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"
)

const (
	siteDescription = "A CMS running entirely on Fastly's edge platform"
	rfc822Layout    = "Mon, 02 Jan 2006 15:04:05 +0000"
)

// layoutVars returns the variables every layout render needs (contract 10).
func layoutVars(cfg Config, path, title, description string) map[string]interface{} {
	return map[string]interface{}{
		"site_url":         cfg.SiteURL,
		"page_title":       title,
		"meta_description": description,
		"canonical_url":    cfg.SiteURL + path,
		"og_type":          "website",
		"og_image":         "",
		"noindex":          false,
		"asset_version":    assetVersion(),
		"is_admin":         false,
	}
}

// adminVars is layoutVars for noindex admin pages.
func adminVars(cfg Config, path, title string) map[string]interface{} {
	data := layoutVars(cfg, path, title, "edge/cms administration")
	data["noindex"] = true
	data["is_admin"] = true
	return data
}

func derefString(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// absoluteURL resolves a root-relative path against siteURL; absolute URLs and
// empty values pass through unchanged.
func absoluteURL(siteURL, ref string) string {
	if strings.HasPrefix(ref, "/") && !strings.HasPrefix(ref, "//") {
		return siteURL + ref
	}
	return ref
}

// percentEncode encodes s for use as a single URL query value.
// It follows encodeURIComponent: everything except A-Za-z0-9 and -_.!~*'()
// is percent-encoded.
func percentEncode(s string) string {
	const hexDigits = "0123456789ABCDEF"
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.IndexByte("-_.!~*'()", c) >= 0 {
			b.WriteByte(c)
			continue
		}
		b.WriteByte('%')
		b.WriteByte(hexDigits[c>>4])
		b.WriteByte(hexDigits[c&15])
	}
	return b.String()
}

// postMetaView converts index entries to template maps.
func postMetaView(posts []PostMeta) []map[string]interface{} {
	out := make([]map[string]interface{}, 0, len(posts))
	for _, p := range posts {
		tags := p.Tags
		if tags == nil {
			tags = []string{}
		}
		out = append(out, map[string]interface{}{
			"slug":           p.Slug,
			"title":          p.Title,
			"excerpt":        p.Excerpt,
			"status":         string(p.Status),
			"created_at":     p.CreatedAt,
			"updated_at":     p.UpdatedAt,
			"tags":           tags,
			"featured_image": derefString(p.FeaturedImage),
		})
	}
	return out
}

// sidebarView converts a sidebar config to template maps. Links whose URL
// fails the safe-URL rule are omitted (render-time defence).
func sidebarView(cfg SidebarConfig) map[string]interface{} {
	items := make([]map[string]interface{}, 0, len(cfg.Items))
	for _, it := range cfg.Items {
		switch it.Type {
		case "category":
			children := it.Children
			if children == nil {
				children = []string{}
			}
			items = append(items, map[string]interface{}{
				"type":         "category",
				"label":        it.Label,
				"slug":         it.Slug,
				"children":     children,
				"children_csv": strings.Join(children, ","),
				"is_category":  true,
				"is_link":      false,
			})
		case "link":
			if !SafeLinkURL(it.URL) {
				continue
			}
			items = append(items, map[string]interface{}{
				"type":        "link",
				"label":       it.Label,
				"url":         it.URL,
				"icon":        derefString(it.Icon),
				"is_category": false,
				"is_link":     true,
			})
		}
	}
	return map[string]interface{}{"items": items}
}

// editorPost builds the `post` object for the admin editor template.
func editorPost(p Post) map[string]interface{} {
	return map[string]interface{}{
		"slug":           p.Slug,
		"title":          p.Title,
		"content":        p.Content,
		"excerpt":        p.Excerpt,
		"status":         string(p.Status),
		"tags":           append([]string{}, p.Tags...),
		"tags_str":       strings.Join(p.Tags, ", "),
		"featured_image": derefString(p.FeaturedImage),
	}
}

// ParsePage parses the ?page= query value. Empty means page 1; anything that
// is not a positive integer is rejected.
func ParsePage(raw string) (int, bool) {
	if raw == "" {
		return 1, true
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 1 {
		return 0, false
	}
	return n, true
}

// PageWindow describes one page of a paginated list.
type PageWindow struct {
	Start, End int
	Page       int
	TotalPages int
}

// Paginate computes the slice bounds for page (1-based) of total items. It
// returns false when page is beyond the last page. An empty list still has
// one (empty) page.
func Paginate(total, page, size int) (PageWindow, bool) {
	if size < 1 {
		size = defaultPageSize
	}
	totalPages := (total + size - 1) / size
	if totalPages < 1 {
		totalPages = 1
	}
	if page < 1 || page > totalPages {
		return PageWindow{}, false
	}
	start := (page - 1) * size
	end := start + size
	if end > total {
		end = total
	}
	return PageWindow{Start: start, End: end, Page: page, TotalPages: totalPages}, true
}

// paginationView builds the template `pagination` object; every link carries
// an explicit ?page=N.
func paginationView(w PageWindow, base string) map[string]interface{} {
	pageURL := func(n int) interface{} {
		return fmt.Sprintf("%s?page=%d", base, n)
	}
	var prev, next interface{}
	if w.Page > 1 {
		prev = pageURL(w.Page - 1)
	}
	if w.Page < w.TotalPages {
		next = pageURL(w.Page + 1)
	}
	return map[string]interface{}{
		"page":        w.Page,
		"total_pages": w.TotalPages,
		"prev_url":    prev,
		"next_url":    next,
	}
}

// FormatRFC822 converts an RFC 3339 timestamp to the RSS pubDate format. It
// returns "" when the input cannot be parsed.
func FormatRFC822(iso string) string {
	t, err := time.Parse(time.RFC3339, iso)
	if err != nil {
		return ""
	}
	return t.UTC().Format(rfc822Layout)
}

// buildJSONLD returns the BlogPosting JSON-LD document for a post. The result
// is safe to embed in a <script type="application/ld+json"> element.
func buildJSONLD(cfg Config, post Post, canonical, image string) string {
	doc := map[string]interface{}{
		"@context":         "https://schema.org",
		"@type":            "BlogPosting",
		"headline":         post.Title,
		"description":      post.Excerpt,
		"datePublished":    post.CreatedAt,
		"dateModified":     post.UpdatedAt,
		"author":           map[string]string{"@type": "Person", "name": post.Author},
		"mainEntityOfPage": canonical,
		"publisher":        map[string]string{"@type": "Organization", "name": "edge/cms"},
	}
	if image != "" {
		doc["image"] = image
	}
	b, err := json.Marshal(doc)
	if err != nil {
		return "{}"
	}
	return strings.ReplaceAll(string(b), "</", `<\/`)
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

// xmlEscape escapes text for inclusion in XML character data or attributes.
func xmlEscape(s string) string {
	s = strings.ReplaceAll(s, "&", "&amp;")
	s = strings.ReplaceAll(s, "<", "&lt;")
	s = strings.ReplaceAll(s, ">", "&gt;")
	s = strings.ReplaceAll(s, `"`, "&quot;")
	s = strings.ReplaceAll(s, "'", "&apos;")
	return s
}

// robotsTxt renders robots.txt (contract 13).
func robotsTxt(siteURL string) string {
	return "User-agent: *\nDisallow: /admin\nDisallow: /api/\nSitemap: " + siteURL + "/sitemap.xml\n"
}

// buildFeed renders the RSS 2.0 document for up to 20 published posts.
func buildFeed(cfg Config, posts []PostMeta) string {
	if len(posts) > 20 {
		posts = posts[:20]
	}
	var b strings.Builder
	b.WriteString("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n")
	b.WriteString("<rss version=\"2.0\" xmlns:atom=\"http://www.w3.org/2005/Atom\">\n<channel>\n")
	b.WriteString("  <title>edge/cms</title>\n")
	fmt.Fprintf(&b, "  <description>%s</description>\n", xmlEscape(siteDescription))
	fmt.Fprintf(&b, "  <link>%s/</link>\n", xmlEscape(cfg.SiteURL))
	fmt.Fprintf(&b, "  <atom:link href=\"%s/feed.xml\" rel=\"self\" type=\"application/rss+xml\"/>\n", xmlEscape(cfg.SiteURL))
	if len(posts) > 0 {
		if built := FormatRFC822(firstNonEmpty(posts[0].UpdatedAt, posts[0].CreatedAt)); built != "" {
			fmt.Fprintf(&b, "  <lastBuildDate>%s</lastBuildDate>\n", built)
		}
	}
	for _, p := range posts {
		link := xmlEscape(cfg.SiteURL + "/post/" + p.Slug)
		b.WriteString("  <item>\n")
		fmt.Fprintf(&b, "    <title>%s</title>\n", xmlEscape(p.Title))
		fmt.Fprintf(&b, "    <link>%s</link>\n", link)
		fmt.Fprintf(&b, "    <guid isPermaLink=\"true\">%s</guid>\n", link)
		fmt.Fprintf(&b, "    <description>%s</description>\n", xmlEscape(p.Excerpt))
		if pub := FormatRFC822(p.CreatedAt); pub != "" {
			fmt.Fprintf(&b, "    <pubDate>%s</pubDate>\n", pub)
		}
		b.WriteString("  </item>\n")
	}
	b.WriteString("</channel>\n</rss>\n")
	return b.String()
}

// buildSitemap renders sitemap.xml with the home page, tag pages and posts.
func buildSitemap(cfg Config, idx PostIndex) string {
	published := idx.Published()
	var b strings.Builder
	b.WriteString("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n")
	fmt.Fprintf(&b, "  <url>\n    <loc>%s/</loc>\n  </url>\n", xmlEscape(cfg.SiteURL))
	for _, tag := range idx.AllTags() {
		fmt.Fprintf(&b, "  <url>\n    <loc>%s</loc>\n  </url>\n", xmlEscape(cfg.SiteURL+"/tag/"+tag))
	}
	for _, p := range published {
		fmt.Fprintf(&b, "  <url>\n    <loc>%s</loc>\n", xmlEscape(cfg.SiteURL+"/post/"+p.Slug))
		if last := firstNonEmpty(p.UpdatedAt, p.CreatedAt); last != "" {
			fmt.Fprintf(&b, "    <lastmod>%s</lastmod>\n", xmlEscape(last))
		}
		b.WriteString("  </url>\n")
	}
	b.WriteString("</urlset>\n")
	return b.String()
}
