package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/url"
	"strings"
	"time"

	"github.com/fastly/compute-sdk-go/fsthttp"
	"github.com/fastly/compute-sdk-go/kvstore"
	"github.com/fastly/compute-sdk-go/secretstore"
)

// requireAuth checks the session cookie and verifies the HMAC token.
// Returns nil on success, or an error describing the failure.
func requireAuth(r *fsthttp.Request) error {
	cookieHeader := r.Header.Get("Cookie")
	token := ExtractCookie(cookieHeader, "session")
	if token == "" {
		return fmt.Errorf("expired")
	}

	hmacKey, err := secretstore.Plaintext("secrets", "hmac_key")
	if err != nil {
		return fmt.Errorf("error")
	}

	err = VerifySessionToken(hmacKey, token)
	if err != nil {
		if err == ErrSessionExpired {
			return fmt.Errorf("expired")
		}
		return fmt.Errorf("invalid")
	}
	return nil
}

// redirectToLogin sends a 302 redirect to the login page with an error reason.
func redirectToLogin(w fsthttp.ResponseWriter, reason string) {
	w.Header().Set("Location", "/admin/login?error="+reason)
	w.WriteHeader(fsthttp.StatusFound)
}

// parseFormBody parses a URL-encoded form body into a key-value map.
func parseFormBody(body string) map[string]string {
	result := make(map[string]string)
	pairs := strings.Split(body, "&")
	for _, pair := range pairs {
		parts := strings.SplitN(pair, "=", 2)
		if len(parts) != 2 {
			continue
		}
		key := parts[0]
		value := strings.ReplaceAll(parts[1], "+", " ")
		decoded, err := url.QueryUnescape(value)
		if err != nil {
			decoded = value
		}
		result[key] = decoded
	}
	return result
}

// nowISO8601 returns the current UTC time in ISO 8601 format.
func nowISO8601() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05Z")
}

// readSecret reads a named secret from the "secrets" secret store.
func readSecret(name string) (string, error) {
	val, err := secretstore.Plaintext("secrets", name)
	if err != nil {
		return "", err
	}
	return string(val), nil
}

// handleLoginPage renders the login page with optional error message.
func handleLoginPage(ctx context.Context, w fsthttp.ResponseWriter, r *fsthttp.Request) {
	errorParam := r.URL.Query().Get("error")
	var errorMessage string
	switch errorParam {
	case "invalid":
		errorMessage = "Invalid password. Please try again."
	case "expired":
		errorMessage = "Session expired. Please log in again."
	case "error":
		errorMessage = "An error occurred. Please try again."
	}

	data := map[string]interface{}{
		"error_message": errorMessage,
	}

	html, err := renderTemplate("login", data)
	if err != nil {
		handleInternalError(w)
		return
	}
	noCache(w)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(fsthttp.StatusOK)
	w.Write([]byte(html))
}

// handleLoginSubmit processes login form submission.
func handleLoginSubmit(ctx context.Context, w fsthttp.ResponseWriter, r *fsthttp.Request) {
	bodyBytes, err := io.ReadAll(r.Body)
	if err != nil {
		redirectToLogin(w, "error")
		return
	}
	form := parseFormBody(string(bodyBytes))
	password := form["password"]

	adminHash, err := readSecret("admin_password")
	if err != nil {
		log.Printf("[auth] failed to read admin_password secret: %v", err)
		redirectToLogin(w, "error")
		return
	}

	if err := VerifyPassword(password, adminHash); err != nil {
		clientIP := r.Header.Get("Fastly-Client-IP")
		if clientIP == "" {
			clientIP = r.RemoteAddr
		}
		log.Printf("[auth] login failed ip=%s", clientIP)
		redirectToLogin(w, "invalid")
		return
	}

	hmacKey, err := secretstore.Plaintext("secrets", "hmac_key")
	if err != nil {
		log.Printf("[auth] failed to read hmac_key secret: %v", err)
		redirectToLogin(w, "error")
		return
	}

	token := CreateSessionToken(hmacKey, 3600)
	w.Header().Set("Set-Cookie", SessionCookie(token))
	w.Header().Set("Location", "/admin")
	w.WriteHeader(fsthttp.StatusFound)
}

// handleLogout clears the session cookie and redirects to home.
func handleLogout(ctx context.Context, w fsthttp.ResponseWriter, r *fsthttp.Request) {
	w.Header().Set("Set-Cookie", ClearSessionCookie())
	w.Header().Set("Location", "/")
	w.WriteHeader(fsthttp.StatusFound)
}

// handleDashboard renders the admin dashboard with post listings.
func handleDashboard(ctx context.Context, w fsthttp.ResponseWriter, r *fsthttp.Request) {
	if err := requireAuth(r); err != nil {
		redirectToLogin(w, err.Error())
		return
	}

	index, err := readIndex()
	if err != nil {
		handleInternalError(w)
		return
	}

	publishedCount := 0
	draftCount := 0
	for _, p := range index.Posts {
		if p.Status == StatusPublished {
			publishedCount++
		} else {
			draftCount++
		}
	}

	data := map[string]interface{}{
		"is_admin":        true,
		"posts":           index.Posts,
		"total_posts":     len(index.Posts),
		"published_count": publishedCount,
		"draft_count":     draftCount,
		"page_title":      "Dashboard",
	}

	html, err := renderPage("admin-dashboard", data)
	if err != nil {
		handleInternalError(w)
		return
	}
	noCache(w)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(fsthttp.StatusOK)
	w.Write([]byte(html))
}

// handleNewPost renders the editor for creating a new post.
func handleNewPost(ctx context.Context, w fsthttp.ResponseWriter, r *fsthttp.Request) {
	if err := requireAuth(r); err != nil {
		redirectToLogin(w, err.Error())
		return
	}

	data := map[string]interface{}{
		"is_admin":   true,
		"editing":    false,
		"page_title": "New Post",
	}
	html, err := renderPage("admin-editor", data)
	if err != nil {
		handleInternalError(w)
		return
	}
	noCache(w)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(fsthttp.StatusOK)
	w.Write([]byte(html))
}

// handleCreatePost creates a new post from form submission.
func handleCreatePost(ctx context.Context, w fsthttp.ResponseWriter, r *fsthttp.Request) {
	if err := requireAuth(r); err != nil {
		redirectToLogin(w, err.Error())
		return
	}

	bodyBytes, err := io.ReadAll(r.Body)
	if err != nil {
		handleInternalError(w)
		return
	}
	form := parseFormBody(string(bodyBytes))

	now := nowISO8601()
	tags := parseTags(form["tags"])
	var featuredImage *string
	if fi := form["featured_image"]; fi != "" {
		featuredImage = &fi
	}

	status := PostStatus(form["status"])
	if status != StatusPublished && status != StatusDraft {
		status = StatusDraft
	}

	post := Post{
		Slug:          form["slug"],
		Title:         form["title"],
		Content:       form["content"],
		Excerpt:       form["excerpt"],
		Status:        status,
		CreatedAt:     now,
		UpdatedAt:     now,
		Tags:          tags,
		FeaturedImage: featuredImage,
		Author:        "Admin",
	}

	postJSON, err := json.Marshal(&post)
	if err != nil {
		handleInternalError(w)
		return
	}

	store, err := kvstore.Open("content")
	if err != nil {
		handleInternalError(w)
		return
	}

	if err := store.Insert("post:"+post.Slug, strings.NewReader(string(postJSON))); err != nil {
		handleInternalError(w)
		return
	}

	// Update index
	index, err := readIndex()
	if err != nil {
		handleInternalError(w)
		return
	}
	index.Add(&post)
	indexJSON, err := json.Marshal(&index)
	if err != nil {
		handleInternalError(w)
		return
	}
	if err := store.Insert("_index", strings.NewReader(string(indexJSON))); err != nil {
		handleInternalError(w)
		return
	}

	purgeKeys([]string{"post-index"})

	w.Header().Set("Location", "/admin")
	w.WriteHeader(fsthttp.StatusFound)
}

// handleEditPost renders the editor for an existing post.
func handleEditPost(ctx context.Context, w fsthttp.ResponseWriter, r *fsthttp.Request, slug string) {
	if err := requireAuth(r); err != nil {
		redirectToLogin(w, err.Error())
		return
	}

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

	tagsStr := strings.Join(post.Tags, ", ")

	data := map[string]interface{}{
		"is_admin":       true,
		"editing":        true,
		"slug":           post.Slug,
		"title":          post.Title,
		"content":        post.Content,
		"excerpt":        post.Excerpt,
		"status":         string(post.Status),
		"tags":           tagsStr,
		"featured_image": post.FeaturedImage,
		"author":         post.Author,
		"created_at":     post.CreatedAt,
		"page_title":     "Edit: " + post.Title,
	}

	html, err := renderPage("admin-editor", data)
	if err != nil {
		handleInternalError(w)
		return
	}
	noCache(w)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(fsthttp.StatusOK)
	w.Write([]byte(html))
}

// handleUpdatePost updates an existing post from form submission.
func handleUpdatePost(ctx context.Context, w fsthttp.ResponseWriter, r *fsthttp.Request, slug string) {
	if err := requireAuth(r); err != nil {
		redirectToLogin(w, err.Error())
		return
	}

	// Read old post to preserve created_at and author
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
	var oldPost Post
	if err := json.Unmarshal([]byte(entry.String()), &oldPost); err != nil {
		handleInternalError(w)
		return
	}

	bodyBytes, err := io.ReadAll(r.Body)
	if err != nil {
		handleInternalError(w)
		return
	}
	form := parseFormBody(string(bodyBytes))

	tags := parseTags(form["tags"])
	var featuredImage *string
	if fi := form["featured_image"]; fi != "" {
		featuredImage = &fi
	}

	status := PostStatus(form["status"])
	if status != StatusPublished && status != StatusDraft {
		status = oldPost.Status
	}

	newSlug := form["slug"]
	if newSlug == "" {
		newSlug = slug
	}

	updatedPost := Post{
		Slug:          newSlug,
		Title:         form["title"],
		Content:       form["content"],
		Excerpt:       form["excerpt"],
		Status:        status,
		CreatedAt:     oldPost.CreatedAt,
		UpdatedAt:     nowISO8601(),
		Tags:          tags,
		FeaturedImage: featuredImage,
		Author:        oldPost.Author,
	}

	postJSON, err := json.Marshal(&updatedPost)
	if err != nil {
		handleInternalError(w)
		return
	}

	// Write new key
	if err := store.Insert("post:"+newSlug, strings.NewReader(string(postJSON))); err != nil {
		handleInternalError(w)
		return
	}

	// Delete old key if slug changed
	if newSlug != slug {
		if err := store.Delete("post:" + slug); err != nil {
			log.Printf("[update] failed to delete old key post:%s: %v", slug, err)
		}
	}

	// Update index
	index, err := readIndex()
	if err != nil {
		handleInternalError(w)
		return
	}
	if newSlug != slug {
		index.Remove(slug)
	}
	index.Add(&updatedPost)
	indexJSON, err := json.Marshal(&index)
	if err != nil {
		handleInternalError(w)
		return
	}
	if err := store.Insert("_index", strings.NewReader(string(indexJSON))); err != nil {
		handleInternalError(w)
		return
	}

	purgeKeys([]string{"post-index", "post-" + slug, "post-" + newSlug})

	w.Header().Set("Location", "/admin")
	w.WriteHeader(fsthttp.StatusFound)
}

// handleDeletePost deletes a post by slug.
func handleDeletePost(ctx context.Context, w fsthttp.ResponseWriter, r *fsthttp.Request, slug string) {
	if err := requireAuth(r); err != nil {
		redirectToLogin(w, err.Error())
		return
	}

	store, err := kvstore.Open("content")
	if err != nil {
		handleInternalError(w)
		return
	}

	if err := store.Delete("post:" + slug); err != nil {
		log.Printf("[delete] failed to delete post:%s: %v", slug, err)
	}

	// Update index
	index, err := readIndex()
	if err != nil {
		handleInternalError(w)
		return
	}
	index.Remove(slug)
	indexJSON, err := json.Marshal(&index)
	if err != nil {
		handleInternalError(w)
		return
	}
	if err := store.Insert("_index", strings.NewReader(string(indexJSON))); err != nil {
		log.Printf("[delete] failed to update index: %v", err)
	}

	purgeKeys([]string{"post-index", "post-" + slug})

	w.Header().Set("Location", "/admin")
	w.WriteHeader(fsthttp.StatusFound)
}

// handleUploadImage uploads an image to Fastly Object Storage via SigV4-signed PUT.
func handleUploadImage(ctx context.Context, w fsthttp.ResponseWriter, r *fsthttp.Request) {
	if err := requireAuth(r); err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(fsthttp.StatusUnauthorized)
		w.Write([]byte(`{"error":"unauthorized"}`))
		return
	}

	slug := r.URL.Query().Get("slug")
	filename := r.URL.Query().Get("filename")
	if slug == "" || filename == "" {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(fsthttp.StatusBadRequest)
		w.Write([]byte(`{"error":"slug and filename required"}`))
		return
	}

	bodyBytes, err := io.ReadAll(r.Body)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(fsthttp.StatusInternalServerError)
		w.Write([]byte(`{"error":"failed to read body"}`))
		return
	}

	accessKeyID, err := readSecret("fos_access_key_id")
	if err != nil {
		log.Printf("[upload] failed to read fos_access_key_id: %v", err)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(fsthttp.StatusInternalServerError)
		w.Write([]byte(`{"error":"config error"}`))
		return
	}
	secretKey, err := readSecret("fos_secret_key")
	if err != nil {
		log.Printf("[upload] failed to read fos_secret_key: %v", err)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(fsthttp.StatusInternalServerError)
		w.Write([]byte(`{"error":"config error"}`))
		return
	}
	region, err := readSecret("fos_region")
	if err != nil {
		log.Printf("[upload] failed to read fos_region: %v", err)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(fsthttp.StatusInternalServerError)
		w.Write([]byte(`{"error":"config error"}`))
		return
	}
	bucket, err := readSecret("fos_bucket")
	if err != nil {
		log.Printf("[upload] failed to read fos_bucket: %v", err)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(fsthttp.StatusInternalServerError)
		w.Write([]byte(`{"error":"config error"}`))
		return
	}

	objectKey := fmt.Sprintf("images/%s/%s", slug, filename)
	host := fmt.Sprintf("%s.s3.%s.amazonaws.com", bucket, region)
	urlStr := fmt.Sprintf("https://%s/%s", host, objectKey)

	datetime, date := utcDatetime()
	payloadHash := sha256Hex(bodyBytes)

	// Canonical request
	canonicalHeaders := fmt.Sprintf("host:%s\nx-amz-content-sha256:%s\nx-amz-date:%s\n", host, payloadHash, datetime)
	signedHeaders := "host;x-amz-content-sha256;x-amz-date"
	canonicalRequest := fmt.Sprintf("PUT\n/%s\n\n%s\n%s\n%s", objectKey, canonicalHeaders, signedHeaders, payloadHash)

	// String to sign
	credentialScope := fmt.Sprintf("%s/%s/s3/aws4_request", date, region)
	stringToSign := fmt.Sprintf("AWS4-HMAC-SHA256\n%s\n%s\n%s", datetime, credentialScope, sha256Hex([]byte(canonicalRequest)))

	// Signing key and signature
	signingKey := deriveSigningKey(secretKey, date, region, "s3")
	signature := signSigV4(signingKey, stringToSign)

	authHeader := fmt.Sprintf("AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s",
		accessKeyID, credentialScope, signedHeaders, signature)

	// Determine content type from filename
	ct := "application/octet-stream"
	lf := strings.ToLower(filename)
	switch {
	case strings.HasSuffix(lf, ".jpg"), strings.HasSuffix(lf, ".jpeg"):
		ct = "image/jpeg"
	case strings.HasSuffix(lf, ".png"):
		ct = "image/png"
	case strings.HasSuffix(lf, ".webp"):
		ct = "image/webp"
	case strings.HasSuffix(lf, ".gif"):
		ct = "image/gif"
	case strings.HasSuffix(lf, ".svg"):
		ct = "image/svg+xml"
	}

	req, err := fsthttp.NewRequest("PUT", urlStr, strings.NewReader(string(bodyBytes)))
	if err != nil {
		log.Printf("[upload] failed to create request: %v", err)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(fsthttp.StatusInternalServerError)
		w.Write([]byte(`{"error":"request error"}`))
		return
	}
	req.Header.Set("Host", host)
	req.Header.Set("Authorization", authHeader)
	req.Header.Set("x-amz-content-sha256", payloadHash)
	req.Header.Set("x-amz-date", datetime)
	req.Header.Set("Content-Type", ct)

	resp, err := req.Send(ctx, "fastly-object-storage")
	if err != nil {
		log.Printf("[upload] backend send error: %v", err)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(fsthttp.StatusBadGateway)
		w.Write([]byte(`{"error":"upload failed"}`))
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		respBody, _ := io.ReadAll(resp.Body)
		log.Printf("[upload] FOS returned %d: %s", resp.StatusCode, string(respBody))
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(fsthttp.StatusBadGateway)
		w.Write([]byte(`{"error":"upload rejected by storage"}`))
		return
	}

	imageURL := fmt.Sprintf("/images/%s/%s", slug, filename)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(fsthttp.StatusOK)
	fmt.Fprintf(w, `{"url":"%s"}`, imageURL)
}

// handleSidebarPage renders the sidebar editor page.
func handleSidebarPage(ctx context.Context, w fsthttp.ResponseWriter, r *fsthttp.Request) {
	if err := requireAuth(r); err != nil {
		redirectToLogin(w, err.Error())
		return
	}

	sidebar, err := readSidebar()
	if err != nil {
		handleInternalError(w)
		return
	}

	sidebarJSON, err := json.Marshal(&sidebar)
	if err != nil {
		handleInternalError(w)
		return
	}

	data := map[string]interface{}{
		"is_admin":     true,
		"sidebar":      sidebar,
		"sidebar_json": string(sidebarJSON),
		"page_title":   "Sidebar Editor",
	}
	html, err := renderPage("admin-sidebar", data)
	if err != nil {
		handleInternalError(w)
		return
	}
	noCache(w)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(fsthttp.StatusOK)
	w.Write([]byte(html))
}

// handleUpdateSidebar saves sidebar configuration from JSON body.
func handleUpdateSidebar(ctx context.Context, w fsthttp.ResponseWriter, r *fsthttp.Request) {
	if err := requireAuth(r); err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(fsthttp.StatusUnauthorized)
		w.Write([]byte(`{"error":"unauthorized"}`))
		return
	}

	bodyBytes, err := io.ReadAll(r.Body)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(fsthttp.StatusBadRequest)
		w.Write([]byte(`{"error":"failed to read body"}`))
		return
	}

	var sidebar SidebarConfig
	if err := json.Unmarshal(bodyBytes, &sidebar); err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(fsthttp.StatusBadRequest)
		w.Write([]byte(`{"error":"invalid JSON"}`))
		return
	}

	sidebarJSON, err := json.Marshal(&sidebar)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(fsthttp.StatusInternalServerError)
		w.Write([]byte(`{"error":"marshal error"}`))
		return
	}

	store, err := kvstore.Open("content")
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(fsthttp.StatusInternalServerError)
		w.Write([]byte(`{"error":"store error"}`))
		return
	}

	if err := store.Insert("_sidebar", strings.NewReader(string(sidebarJSON))); err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(fsthttp.StatusInternalServerError)
		w.Write([]byte(`{"error":"write error"}`))
		return
	}

	purgeKeys([]string{"sidebar"})

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(fsthttp.StatusOK)
	w.Write([]byte(`{"ok":true}`))
}

// parseTags splits a comma-separated tag string into a cleaned slice.
func parseTags(tagStr string) []string {
	if tagStr == "" {
		return []string{}
	}
	parts := strings.Split(tagStr, ",")
	var tags []string
	for _, t := range parts {
		t = strings.TrimSpace(t)
		if t != "" {
			tags = append(tags, t)
		}
	}
	if tags == nil {
		tags = []string{}
	}
	return tags
}
