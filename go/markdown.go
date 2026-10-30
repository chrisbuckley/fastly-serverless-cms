package main

import (
	"bytes"
	"fmt"
	"regexp"
	"strings"

	"github.com/microcosm-cc/bluemonday"
	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/renderer/html"
)

var md = goldmark.New(
	goldmark.WithExtensions(extension.GFM),
	goldmark.WithRendererOptions(html.WithUnsafe()),
)

var (
	codeClassRe  = regexp.MustCompile(`^language-[a-z0-9+-]+$`)
	alignRe      = regexp.MustCompile(`^(left|right|center)$`)
	dimensionRe  = regexp.MustCompile(`^[0-9]+(px|%)?$`)
	checkboxRe   = regexp.MustCompile(`^checkbox$`)
	embedSrcRe   = regexp.MustCompile(`^https://(www\.youtube-nocookie\.com|www\.youtube\.com|player\.vimeo\.com)/[^\s"'<>]*$`)
	iframeTagRe  = regexp.MustCompile(`(?is)<iframe\b[^>]*>.*?</iframe>`)
	inputTagRe   = regexp.MustCompile(`(?i)<input\b[^>]*>`)
	externalLink = regexp.MustCompile(`(?i)<a\b([^>]*\shref="https?://[^>]*)>`)
	sanitizer    = newSanitizer()
)

// newSanitizer builds the allowlist policy from the security contract
// (section 11). Constraints bluemonday cannot express directly (dropping
// iframes without a valid src, forcing disabled checkboxes, rel on external
// links) are applied by postSanitize.
func newSanitizer() *bluemonday.Policy {
	p := bluemonday.NewPolicy()
	p.AllowElements("p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li",
		"blockquote", "em", "strong", "del", "s", "table", "thead", "tbody", "tr",
		"hr", "br", "sup", "sub", "details", "summary", "figure", "figcaption",
		"pre", "code", "span", "div", "a", "img", "th", "td", "input", "iframe")
	p.AllowAttrs("href", "title").OnElements("a")
	p.AllowAttrs("src", "alt", "title").OnElements("img")
	p.AllowAttrs("width", "height").Matching(dimensionRe).OnElements("img", "iframe")
	p.AllowAttrs("class").Matching(codeClassRe).OnElements("code", "pre", "span", "div")
	p.AllowAttrs("align").Matching(alignRe).OnElements("th", "td")
	p.AllowAttrs("type").Matching(checkboxRe).OnElements("input")
	p.AllowAttrs("disabled", "checked").OnElements("input")
	p.AllowAttrs("src").Matching(embedSrcRe).OnElements("iframe")
	p.AllowAttrs("title", "allow").OnElements("iframe")
	p.AllowAttrs("allowfullscreen").OnElements("iframe")
	p.AllowURLSchemes("http", "https", "mailto")
	p.AllowRelativeURLs(true)
	return p
}

// SanitizeHTML applies the contract allowlist to untrusted HTML.
func SanitizeHTML(unsafe string) string {
	return postSanitize(sanitizer.Sanitize(unsafe))
}

func postSanitize(h string) string {
	h = iframeTagRe.ReplaceAllStringFunc(h, func(tag string) string {
		if strings.Contains(tag, ` src="`) {
			return tag
		}
		return ""
	})
	h = inputTagRe.ReplaceAllStringFunc(h, func(tag string) string {
		if !strings.Contains(tag, `type="checkbox"`) {
			return ""
		}
		if !strings.Contains(tag, " disabled") {
			return strings.Replace(tag, "<input", `<input disabled=""`, 1)
		}
		return tag
	})
	return externalLink.ReplaceAllString(h, `<a$1 rel="noopener noreferrer">`)
}

// RenderMarkdown converts markdown text to HTML using goldmark (raw HTML is
// parsed) and then sanitizes the result with the contract allowlist.
// Returns empty string on empty input.
func RenderMarkdown(input string) string {
	if input == "" {
		return ""
	}
	var buf bytes.Buffer
	if err := md.Convert([]byte(input), &buf); err != nil {
		return ""
	}
	return SanitizeHTML(buf.String())
}

// RewriteImages scans for <img src="/images/..."> tags and replaces each with
// a <picture> element containing WebP srcset (480w, 800w, 1280w) and a fallback
// <img>. Non-/images/ src values are left unchanged.
func RewriteImages(htmlStr string) string {
	var out strings.Builder
	rest := htmlStr
	marker := `<img src="/images/`

	for {
		imgStart := strings.Index(rest, marker)
		if imgStart == -1 {
			break
		}

		out.WriteString(rest[:imgStart])
		afterMarker := rest[imgStart+len(marker):]

		srcEnd := strings.Index(afterMarker, `"`)
		if srcEnd == -1 {
			srcEnd = len(afterMarker)
		}
		srcPath := "/images/" + afterMarker[:srcEnd]

		tagEnd := strings.Index(afterMarker, ">")
		if tagEnd == -1 {
			break
		}
		tagInner := afterMarker[:tagEnd]

		alt := ""
		if altStart := strings.Index(tagInner, `alt="`); altStart != -1 {
			afterAlt := tagInner[altStart+5:]
			altEnd := strings.Index(afterAlt, `"`)
			if altEnd == -1 {
				altEnd = len(afterAlt)
			}
			alt = afterAlt[:altEnd]
		}

		out.WriteString(responsivePicture(srcPath, alt))
		rest = afterMarker[tagEnd+1:]
	}
	out.WriteString(rest)
	return out.String()
}

// responsivePicture generates a <picture> element with WebP srcset variants
// and a fallback <img> tag.
func responsivePicture(src, alt string) string {
	return fmt.Sprintf(
		`<picture>`+
			`<source type="image/webp" `+
			`srcset="%[1]s?width=480&format=webp 480w, `+
			`%[1]s?width=800&format=webp 800w, `+
			`%[1]s?width=1280&format=webp 1280w" `+
			`sizes="(max-width: 640px) 100vw, 680px">`+
			`<img alt="%[2]s" src="%[1]s?width=680" loading="lazy">`+
			`</picture>`,
		src, alt,
	)
}
