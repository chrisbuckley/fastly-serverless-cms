package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

const (
	maxFormBodyBytes = 1 << 20
	maxContentBytes  = 512 << 10
	maxSidebarBytes  = 64 << 10
	maxUploadBytes   = 10 << 20
	maxSidebarItems  = 50
	maxTagsPerPost   = 20
	maxTitleChars    = 200
	maxExcerptChars  = 500
	maxSidebarLabel  = 100
	maxFeaturedImage = 500
)

var (
	slugRe     = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$`)
	filenameRe = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}\.(jpg|jpeg|png|webp|gif)$`)
	tagRe      = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,49}$`)
	iconRe     = regexp.MustCompile(`^[a-z0-9-]{1,32}$`)
)

// errBodyTooLarge signals a request body above the allowed limit.
var errBodyTooLarge = errors.New("request body too large")

// ValidationError carries the HTTP status that a failed validation maps to.
type ValidationError struct {
	Status  int
	Message string
}

func (e *ValidationError) Error() string { return e.Message }

func badRequest(format string, args ...interface{}) *ValidationError {
	return &ValidationError{Status: http.StatusBadRequest, Message: fmt.Sprintf(format, args...)}
}

// ValidSlug reports whether s is an acceptable post slug.
func ValidSlug(s string) bool { return slugRe.MatchString(s) }

// ValidateTitle trims the title and enforces the 1-200 character rule.
func ValidateTitle(title string) (string, error) {
	title = strings.TrimSpace(title)
	n := utf8.RuneCountInString(title)
	if n < 1 || n > maxTitleChars {
		return "", badRequest("title must be 1-%d characters", maxTitleChars)
	}
	return title, nil
}

// ValidateExcerpt enforces the 500 character limit.
func ValidateExcerpt(excerpt string) error {
	if utf8.RuneCountInString(excerpt) > maxExcerptChars {
		return badRequest("excerpt must be at most %d characters", maxExcerptChars)
	}
	return nil
}

// ValidateContent enforces the 512 KiB limit (413 on failure).
func ValidateContent(content string) error {
	if len(content) > maxContentBytes {
		return &ValidationError{Status: http.StatusRequestEntityTooLarge, Message: "content exceeds 512 KiB"}
	}
	return nil
}

// ParseTags splits a comma-separated list, normalises each tag, silently drops
// invalid entries, de-duplicates and caps the result at 20 tags.
func ParseTags(raw string) []string {
	tags := []string{}
	seen := map[string]struct{}{}
	for _, part := range strings.Split(raw, ",") {
		t := strings.ToLower(strings.TrimSpace(part))
		t = strings.Join(strings.Fields(t), "-")
		if !tagRe.MatchString(t) {
			continue
		}
		if _, dup := seen[t]; dup {
			continue
		}
		seen[t] = struct{}{}
		tags = append(tags, t)
		if len(tags) == maxTagsPerPost {
			break
		}
	}
	return tags
}

// ParseStatus resolves a submitted status. An empty value yields fallback;
// any value other than published/draft is a 400.
func ParseStatus(raw string, fallback PostStatus) (PostStatus, error) {
	switch PostStatus(raw) {
	case "":
		return fallback, nil
	case StatusPublished, StatusDraft:
		return PostStatus(raw), nil
	}
	return "", badRequest("status must be published or draft")
}

// ValidFilename reports whether name is an acceptable upload filename.
func ValidFilename(name string) bool { return filenameRe.MatchString(name) }

// DetectImageType returns the MIME type implied by the leading magic bytes,
// or "" when the data is not a supported image.
func DetectImageType(b []byte) string {
	switch {
	case bytes.HasPrefix(b, []byte{0xFF, 0xD8, 0xFF}):
		return "image/jpeg"
	case bytes.HasPrefix(b, []byte{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A}):
		return "image/png"
	case bytes.HasPrefix(b, []byte("GIF87a")), bytes.HasPrefix(b, []byte("GIF89a")):
		return "image/gif"
	case len(b) >= 12 && bytes.Equal(b[:4], []byte("RIFF")) && bytes.Equal(b[8:12], []byte("WEBP")):
		return "image/webp"
	}
	return ""
}

// ImageTypeMatchesFilename reports whether the detected content type agrees
// with the filename extension.
func ImageTypeMatchesFilename(contentType, filename string) bool {
	dot := strings.LastIndex(filename, ".")
	if dot < 0 {
		return false
	}
	switch strings.ToLower(filename[dot+1:]) {
	case "jpg", "jpeg":
		return contentType == "image/jpeg"
	case "png":
		return contentType == "image/png"
	case "webp":
		return contentType == "image/webp"
	case "gif":
		return contentType == "image/gif"
	}
	return false
}

// SafeLinkURL implements sidebar URL rule U: https://, http:// or a rooted
// path that is not protocol-relative.
func SafeLinkURL(u string) bool {
	if strings.Contains(u, "\\") || strings.IndexFunc(u, unicode.IsSpace) >= 0 {
		return false
	}
	lower := strings.ToLower(u)
	switch {
	case strings.HasPrefix(lower, "https://"), strings.HasPrefix(lower, "http://"):
		return true
	case strings.HasPrefix(u, "/"):
		return !strings.HasPrefix(u, "//")
	}
	return false
}

// CleanFeaturedImage returns nil for an empty value, one longer than 500
// characters, or one that fails the safe-URL rule.
func CleanFeaturedImage(raw string) *string {
	if raw == "" || utf8.RuneCountInString(raw) > maxFeaturedImage || !SafeLinkURL(raw) {
		return nil
	}
	return &raw
}

// ValidateSidebar parses and validates a sidebar JSON document. Unknown JSON
// fields are dropped by the typed decoding.
func ValidateSidebar(body []byte) (SidebarConfig, error) {
	if len(body) > maxSidebarBytes {
		return SidebarConfig{}, badRequest("sidebar exceeds 64 KiB")
	}
	var cfg SidebarConfig
	if err := json.Unmarshal(body, &cfg); err != nil {
		return SidebarConfig{}, badRequest("invalid JSON")
	}
	if cfg.Items == nil {
		return SidebarConfig{}, badRequest("items is required")
	}
	if len(cfg.Items) > maxSidebarItems {
		return SidebarConfig{}, badRequest("at most %d sidebar items", maxSidebarItems)
	}
	for i, item := range cfg.Items {
		if n := utf8.RuneCountInString(item.Label); n < 1 || n > maxSidebarLabel {
			return SidebarConfig{}, badRequest("item %d: label must be 1-%d characters", i, maxSidebarLabel)
		}
		switch item.Type {
		case "category":
			if !ValidSlug(item.Slug) {
				return SidebarConfig{}, badRequest("item %d: invalid category slug", i)
			}
			for _, child := range item.Children {
				if !ValidSlug(child) {
					return SidebarConfig{}, badRequest("item %d: invalid child slug", i)
				}
			}
			cfg.Items[i].URL = ""
			cfg.Items[i].Icon = nil
		case "link":
			if !SafeLinkURL(item.URL) {
				return SidebarConfig{}, badRequest("item %d: invalid url", i)
			}
			if item.Icon != nil && !iconRe.MatchString(*item.Icon) {
				return SidebarConfig{}, badRequest("item %d: invalid icon", i)
			}
			cfg.Items[i].Slug = ""
			cfg.Items[i].Children = nil
		default:
			return SidebarConfig{}, badRequest("item %d: unknown type", i)
		}
	}
	return cfg, nil
}
