package main

import (
	"bytes"
	"fmt"
	"strings"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/renderer/html"
)

var md = goldmark.New(
	goldmark.WithExtensions(extension.GFM),
	goldmark.WithRendererOptions(html.WithUnsafe()),
)

// RenderMarkdown converts markdown text to HTML using goldmark.
// Returns empty string on empty input.
func RenderMarkdown(input string) string {
	if input == "" {
		return ""
	}
	var buf bytes.Buffer
	if err := md.Convert([]byte(input), &buf); err != nil {
		return ""
	}
	return buf.String()
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
