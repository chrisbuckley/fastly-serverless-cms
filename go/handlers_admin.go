package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/fastly/compute-sdk-go/erl"
	"github.com/fastly/compute-sdk-go/fsthttp"
	"github.com/fastly/compute-sdk-go/secretstore"
)

const (
	loginMaxAttempts  = 5
	loginPenaltyTTL   = 15 * time.Minute
	loginRetryAfter   = "900"
	minRevocationTTL  = 60
	adminHome         = "/admin"
	authReasonExpired = "expired"
	authReasonInvalid = "invalid"
	authReasonError   = "error"
)

// authError describes why a request is not authenticated; its message is the
// reason code shown on the login page.
type authError struct{ reason string }

func (e *authError) Error() string { return e.reason }

// requireAuth verifies the session cookie, its HMAC and that the session has
// not been revoked by a logout.
func requireAuth(r *fsthttp.Request) error {
	token := ExtractCookie(r.Header.Get("Cookie"), "session")
	if token == "" {
		return &authError{authReasonExpired}
	}
	hmacKey, err := secretstore.Plaintext("secrets", "hmac_key")
	if err != nil {
		logErrorf("auth: read hmac_key: %v", err)
		return &authError{authReasonError}
	}
	session, err := ParseSessionToken(hmacKey, token)
	if err != nil {
		if errors.Is(err, ErrSessionExpired) {
			return &authError{authReasonExpired}
		}
		return &authError{authReasonInvalid}
	}
	store, err := openContent()
	if err != nil {
		logErrorf("auth: %v", err)
		return &authError{authReasonError}
	}
	_, revoked, err := kvGet(store, RevocationKey(session.Nonce))
	if err != nil {
		logErrorf("auth: %v", err)
		return &authError{authReasonError}
	}
	if revoked {
		return &authError{authReasonInvalid}
	}
	return nil
}

// redirectToLogin sends a 302 redirect to the login page with an error reason.
func redirectToLogin(w fsthttp.ResponseWriter, reason string) {
	noCache(w)
	w.Header().Set("Location", "/admin/login?error="+url.QueryEscape(reason))
	w.WriteHeader(fsthttp.StatusFound)
}

func redirectTo(w fsthttp.ResponseWriter, location string) {
	noCache(w)
	w.Header().Set("Location", location)
	w.WriteHeader(fsthttp.StatusFound)
}

// authorize returns true when the request is authenticated; otherwise it
// writes the appropriate response (login redirect, or 401 JSON for API calls).
func authorize(w fsthttp.ResponseWriter, r *fsthttp.Request, apiCall bool) bool {
	err := requireAuth(r)
	if err == nil {
		return true
	}
	if apiCall {
		writeJSONError(w, fsthttp.StatusUnauthorized, "unauthorized")
	} else {
		redirectToLogin(w, err.Error())
	}
	return false
}

// readLimitedBody reads at most limit bytes, checking Content-Length first.
func readLimitedBody(r *fsthttp.Request, limit int64) ([]byte, error) {
	if cl := r.Header.Get("Content-Length"); cl != "" {
		if n, err := strconv.ParseInt(cl, 10, 64); err == nil && n > limit {
			return nil, errBodyTooLarge
		}
	}
	if r.Body == nil {
		return nil, nil
	}
	b, err := io.ReadAll(io.LimitReader(r.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > limit {
		return nil, errBodyTooLarge
	}
	return b, nil
}

// parseFormBody parses a URL-encoded form body. Decoding never fails: a value
// or key with malformed escapes is kept raw.
func parseFormBody(body string) map[string]string {
	result := make(map[string]string)
	for _, pair := range strings.Split(body, "&") {
		if pair == "" {
			continue
		}
		parts := strings.SplitN(pair, "=", 2)
		key := decodeFormComponent(parts[0])
		value := ""
		if len(parts) == 2 {
			value = decodeFormComponent(parts[1])
		}
		result[key] = value
	}
	return result
}

func decodeFormComponent(s string) string {
	decoded, err := url.QueryUnescape(s)
	if err != nil {
		return s
	}
	return decoded
}

// parseFields extracts post fields from a form or JSON body. Absent keys are
// absent from the result, which lets updates distinguish omitted from empty.
func parseFields(contentType string, body []byte) (map[string]string, error) {
	if !strings.Contains(strings.ToLower(contentType), "application/json") {
		return parseFormBody(string(body)), nil
	}
	var raw map[string]interface{}
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, badRequest("invalid JSON")
	}
	fields := make(map[string]string, len(raw))
	for k, v := range raw {
		switch val := v.(type) {
		case string:
			fields[k] = val
		case []interface{}:
			parts := make([]string, 0, len(val))
			for _, item := range val {
				if s, ok := item.(string); ok {
					parts = append(parts, s)
				}
			}
			fields[k] = strings.Join(parts, ",")
		case nil:
			fields[k] = ""
		}
	}
	return fields, nil
}

// wantsJSON reports whether the caller expects a JSON error response.
func wantsJSON(r *fsthttp.Request) bool {
	if strings.Contains(strings.ToLower(r.Header.Get("Content-Type")), "application/json") {
		return true
	}
	accept := r.Header.Get("Accept")
	return strings.Contains(accept, "application/json") && !strings.Contains(accept, "text/html")
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

func loginErrorMessage(code string) interface{} {
	switch code {
	case "invalid":
		return "Invalid password. Please try again."
	case "expired":
		return "Session expired. Please log in again."
	case "error":
		return "An error occurred. Please try again."
	}
	return nil
}

// handleLoginPage renders the login page with an optional error message.
func handleLoginPage(ctx context.Context, w fsthttp.ResponseWriter, r *fsthttp.Request) {
	cfg := loadConfig(r.Host)
	data := layoutVars(cfg, "/admin/login", "Login", "edge/cms administration login")
	data["noindex"] = true
	data["error"] = loginErrorMessage(r.URL.Query().Get("error"))

	html, err := renderTemplate("login", data)
	if err != nil {
		logErrorf("render login: %v", err)
		handleInternalError(w, r)
		return
	}
	noCache(w)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(fsthttp.StatusOK)
	w.Write([]byte(html))
}

// loginOverLimit reports whether count exceeds the allowed attempts per window.
func loginOverLimit(count uint32) bool { return count > loginMaxAttempts }

// loginRateLimited applies the in-Compute login limiter (contract section 4).
// Limiter failures are logged and fail open so a platform fault cannot lock the
// administrator out; the VCL layer still rate limits.
func loginRateLimited(ip string) bool {
	box := erl.OpenPenaltyBox("login_penalty")
	counter := erl.OpenRateCounter("login_attempts")
	if in, err := box.Has(ip); err == nil && in {
		return true
	}
	if err := counter.Increment(ip, 1); err != nil {
		logErrorf("login limiter increment: %v", err)
		return false
	}
	count, err := counter.LookupCount(ip, erl.CounterDuration60s)
	if err != nil {
		logErrorf("login limiter lookup: %v", err)
		return false
	}
	if !loginOverLimit(count) {
		return false
	}
	if err := box.Add(ip, loginPenaltyTTL); err != nil {
		logErrorf("login limiter penalty: %v", err)
	}
	return true
}

func writeTooManyAttempts(w fsthttp.ResponseWriter) {
	w.Header().Set("Retry-After", loginRetryAfter)
	writeText(w, fsthttp.StatusTooManyRequests, "Too many login attempts\n")
}

// handleLoginSubmit processes login form submission.
func handleLoginSubmit(ctx context.Context, w fsthttp.ResponseWriter, r *fsthttp.Request) {
	if loginRateLimited(rateLimitKey(clientIP(r))) {
		writeTooManyAttempts(w)
		return
	}
	body, err := readLimitedBody(r, maxFormBodyBytes)
	if errors.Is(err, errBodyTooLarge) {
		writeText(w, fsthttp.StatusRequestEntityTooLarge, "Payload too large\n")
		return
	}
	if err != nil {
		redirectToLogin(w, authReasonError)
		return
	}
	password := parseFormBody(string(body))["password"]

	adminHash, err := readSecret("admin_password")
	if err != nil {
		logErrorf("auth: read admin_password: %v", err)
		redirectToLogin(w, authReasonError)
		return
	}
	if err := VerifyPassword(password, adminHash); err != nil {
		redirectToLogin(w, authReasonInvalid)
		return
	}
	hmacKey, err := secretstore.Plaintext("secrets", "hmac_key")
	if err != nil {
		logErrorf("auth: read hmac_key: %v", err)
		redirectToLogin(w, authReasonError)
		return
	}
	token, err := CreateSessionToken(hmacKey, sessionTTL)
	if err != nil {
		logErrorf("auth: %v", err)
		redirectToLogin(w, authReasonError)
		return
	}
	w.Header().Set("Set-Cookie", SessionCookie(token))
	redirectTo(w, adminHome)
}

// handleLogout revokes the session nonce, clears the cookie and redirects home.
func handleLogout(ctx context.Context, w fsthttp.ResponseWriter, r *fsthttp.Request) {
	if token := ExtractCookie(r.Header.Get("Cookie"), "session"); token != "" {
		if hmacKey, err := secretstore.Plaintext("secrets", "hmac_key"); err == nil {
			if session, err := ParseSessionToken(hmacKey, token); err == nil {
				if err := revokeSession(session); err != nil {
					logErrorf("logout: %v", err)
					handleInternalError(w, r)
					return
				}
			}
		}
	}
	w.Header().Set("Set-Cookie", ClearSessionCookie())
	redirectTo(w, "/")
}

// revokeSession records the nonce as revoked until the token would expire.
func revokeSession(s Session) error {
	store, err := openContent()
	if err != nil {
		return err
	}
	remaining := s.Expires - time.Now().Unix()
	if remaining < minRevocationTTL {
		remaining = minRevocationTTL
	}
	return kvPut(store, RevocationKey(s.Nonce), strconv.FormatInt(s.Expires, 10), uint32(remaining))
}

// handleDashboard renders the admin dashboard with post listings.
func handleDashboard(ctx context.Context, w fsthttp.ResponseWriter, r *fsthttp.Request) {
	if !authorize(w, r, false) {
		return
	}
	cfg := loadConfig(r.Host)
	index, err := readIndex()
	if err != nil {
		logErrorf("dashboard: %v", err)
		handleInternalError(w, r)
		return
	}
	publishedCount := len(index.Published())

	data := adminVars(cfg, adminHome, "Dashboard")
	data["posts"] = postMetaView(index.Posts)
	data["total_posts"] = len(index.Posts)
	data["published_count"] = publishedCount
	data["draft_count"] = len(index.Posts) - publishedCount
	data["purge_failed"] = r.URL.Query().Get("purge") == "failed"
	writeAdminPage(w, r, fsthttp.StatusOK, "admin-dashboard", data)
}

// writeAdminPage renders an uncacheable admin page with the given status.
func writeAdminPage(w fsthttp.ResponseWriter, r *fsthttp.Request, status int, name string, data map[string]interface{}) {
	html, err := renderPage(name, data)
	if err != nil {
		logErrorf("render %s: %v", name, err)
		handleInternalError(w, r)
		return
	}
	noCache(w)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	w.Write([]byte(html))
}

// renderEditor renders the post editor, optionally with an error message.
func renderEditor(w fsthttp.ResponseWriter, r *fsthttp.Request, status int, post Post, isNew bool, message string) {
	cfg := loadConfig(r.Host)
	title := "New Post"
	path := "/admin/posts/new"
	if !isNew {
		title = "Edit Post"
		path = "/admin/posts/" + post.Slug + "/edit"
	}
	data := adminVars(cfg, path, title)
	data["post"] = editorPost(post)
	data["is_new"] = isNew
	data["editing"] = !isNew
	if message == "" {
		data["error"] = nil
	} else {
		data["error"] = message
	}
	writeAdminPage(w, r, status, "admin-editor", data)
}

// handleNewPost renders the editor for creating a new post.
func handleNewPost(ctx context.Context, w fsthttp.ResponseWriter, r *fsthttp.Request) {
	if !authorize(w, r, false) {
		return
	}
	renderEditor(w, r, fsthttp.StatusOK, Post{Status: StatusDraft, Tags: []string{}}, true, "")
}

// postFailure reports a validation or conflict error to either an HTML form
// (re-rendering the editor) or a JSON caller.
func postFailure(w fsthttp.ResponseWriter, r *fsthttp.Request, status int, message string, post Post, isNew bool) {
	if wantsJSON(r) {
		writeJSONError(w, status, message)
		return
	}
	renderEditor(w, r, status, post, isNew, message)
}

func failureStatus(err error) (int, string) {
	var ve *ValidationError
	if errors.As(err, &ve) {
		return ve.Status, ve.Message
	}
	return fsthttp.StatusBadRequest, err.Error()
}

// draftFromFields builds a best-effort Post from submitted fields so a failed
// form can be redisplayed with the user's input.
func draftFromFields(fields map[string]string, slug string) Post {
	post := Post{
		Slug:    slug,
		Title:   fields["title"],
		Content: fields["content"],
		Excerpt: fields["excerpt"],
		Status:  PostStatus(fields["status"]),
		Tags:    ParseTags(fields["tags"]),
	}
	post.FeaturedImage = CleanFeaturedImage(fields["featured_image"])
	if post.Status != StatusPublished {
		post.Status = StatusDraft
	}
	return post
}

// readPostFields reads and parses a form/JSON post body. On failure it has
// already written the response and returns ok=false.
func readPostFields(w fsthttp.ResponseWriter, r *fsthttp.Request, blank Post, isNew bool) (map[string]string, bool) {
	body, err := readLimitedBody(r, maxFormBodyBytes)
	if errors.Is(err, errBodyTooLarge) {
		postFailure(w, r, fsthttp.StatusRequestEntityTooLarge, "Request body is too large", blank, isNew)
		return nil, false
	}
	if err != nil {
		logErrorf("read body: %v", err)
		handleInternalError(w, r)
		return nil, false
	}
	fields, err := parseFields(r.Header.Get("Content-Type"), body)
	if err != nil {
		status, msg := failureStatus(err)
		postFailure(w, r, status, msg, blank, isNew)
		return nil, false
	}
	return fields, true
}

// handleCreatePost creates a new post from form or JSON submission.
func handleCreatePost(ctx context.Context, w fsthttp.ResponseWriter, r *fsthttp.Request) {
	if !authorize(w, r, wantsJSON(r)) {
		return
	}
	fields, ok := readPostFields(w, r, Post{Status: StatusDraft, Tags: []string{}}, true)
	if !ok {
		return
	}
	draft := draftFromFields(fields, fields["slug"])

	post, err := buildNewPost(fields)
	if err != nil {
		status, msg := failureStatus(err)
		postFailure(w, r, status, msg, draft, true)
		return
	}

	store, err := openContent()
	if err != nil {
		logErrorf("create: %v", err)
		handleInternalError(w, r)
		return
	}
	_, exists, err := kvGet(store, "post:"+post.Slug)
	if err != nil {
		logErrorf("create: %v", err)
		handleInternalError(w, r)
		return
	}
	if exists {
		postFailure(w, r, fsthttp.StatusConflict, "A post with that slug already exists", draft, true)
		return
	}
	if err := writePost(store, &post); err != nil {
		logErrorf("create: %v", err)
		handleInternalError(w, r)
		return
	}
	if err := updateIndex(store, func(idx *PostIndex) { idx.Add(&post) }); err != nil {
		logErrorf("create: %v", err)
		handleInternalError(w, r)
		return
	}
	purged := purgeKeys(ctx, postPurgeKeys(post.Slug, post.Tags))
	redirectTo(w, withPurgeFlag(adminHome, purged))
}

// buildNewPost validates submitted fields for a new post.
func buildNewPost(fields map[string]string) (Post, error) {
	slug := fields["slug"]
	if !ValidSlug(slug) {
		return Post{}, badRequest("invalid slug: use lowercase letters, digits and hyphens")
	}
	title, err := ValidateTitle(fields["title"])
	if err != nil {
		return Post{}, err
	}
	if err := ValidateExcerpt(fields["excerpt"]); err != nil {
		return Post{}, err
	}
	if err := ValidateContent(fields["content"]); err != nil {
		return Post{}, err
	}
	status, err := ParseStatus(fields["status"], StatusDraft)
	if err != nil {
		return Post{}, err
	}
	now := nowISO8601()
	post := Post{
		Slug:      slug,
		Title:     title,
		Content:   fields["content"],
		Excerpt:   fields["excerpt"],
		Status:    status,
		CreatedAt: now,
		UpdatedAt: now,
		Tags:      ParseTags(fields["tags"]),
		Author:    "Admin",
	}
	post.FeaturedImage = CleanFeaturedImage(fields["featured_image"])
	return post, nil
}

// mergePostUpdate applies submitted fields to an existing post. Omitted fields,
// and empty title/content/slug/status, keep their existing values.
func mergePostUpdate(old Post, fields map[string]string, now string) (Post, error) {
	updated := old
	updated.UpdatedAt = now

	if slug := fields["slug"]; slug != "" {
		if !ValidSlug(slug) {
			return Post{}, badRequest("invalid slug: use lowercase letters, digits and hyphens")
		}
		updated.Slug = slug
	}
	if title, ok := fields["title"]; ok && strings.TrimSpace(title) != "" {
		validTitle, err := ValidateTitle(title)
		if err != nil {
			return Post{}, err
		}
		updated.Title = validTitle
	}
	if excerpt, ok := fields["excerpt"]; ok {
		if err := ValidateExcerpt(excerpt); err != nil {
			return Post{}, err
		}
		updated.Excerpt = excerpt
	}
	if content, ok := fields["content"]; ok && content != "" {
		if err := ValidateContent(content); err != nil {
			return Post{}, err
		}
		updated.Content = content
	}
	if raw, ok := fields["status"]; ok {
		if raw == "" {
			return Post{}, badRequest("status must be published or draft")
		}
		status, err := ParseStatus(raw, old.Status)
		if err != nil {
			return Post{}, err
		}
		updated.Status = status
	}
	if tags, ok := fields["tags"]; ok {
		updated.Tags = ParseTags(tags)
	}
	if fi, ok := fields["featured_image"]; ok {
		updated.FeaturedImage = CleanFeaturedImage(fi)
	}
	return updated, nil
}

// handleEditPost renders the editor for an existing post.
func handleEditPost(ctx context.Context, w fsthttp.ResponseWriter, r *fsthttp.Request, slug string) {
	if !authorize(w, r, false) {
		return
	}
	if !ValidSlug(slug) {
		handleNotFound(w, r)
		return
	}
	store, err := openContent()
	if err != nil {
		logErrorf("edit: %v", err)
		handleInternalError(w, r)
		return
	}
	post, found, err := readPost(store, slug)
	if err != nil {
		logErrorf("edit %s: %v", slug, err)
		handleInternalError(w, r)
		return
	}
	if !found {
		handleNotFound(w, r)
		return
	}
	renderEditor(w, r, fsthttp.StatusOK, post, false, "")
}

// handleUpdatePost updates an existing post, keeping existing values for
// omitted fields, and keeps revisions of the previous content.
func handleUpdatePost(ctx context.Context, w fsthttp.ResponseWriter, r *fsthttp.Request, slug string) {
	if !authorize(w, r, wantsJSON(r)) {
		return
	}
	if !ValidSlug(slug) {
		handleNotFound(w, r)
		return
	}
	store, err := openContent()
	if err != nil {
		logErrorf("update: %v", err)
		handleInternalError(w, r)
		return
	}
	oldPost, found, err := readPost(store, slug)
	if err != nil {
		logErrorf("update %s: %v", slug, err)
		handleInternalError(w, r)
		return
	}
	if !found {
		handleNotFound(w, r)
		return
	}
	fields, ok := readPostFields(w, r, oldPost, false)
	if !ok {
		return
	}
	draft := draftFromFields(fields, slug)

	updated, err := mergePostUpdate(oldPost, fields, nowISO8601())
	if err != nil {
		status, msg := failureStatus(err)
		postFailure(w, r, status, msg, draft, false)
		return
	}
	renamed := updated.Slug != slug
	if renamed {
		_, exists, err := kvGet(store, "post:"+updated.Slug)
		if err != nil {
			logErrorf("update %s: %v", slug, err)
			handleInternalError(w, r)
			return
		}
		if exists {
			postFailure(w, r, fsthttp.StatusConflict, "A post with that slug already exists", draft, false)
			return
		}
	}

	oldJSON, err := json.Marshal(&oldPost)
	if err != nil {
		logErrorf("update %s: %v", slug, err)
		handleInternalError(w, r)
		return
	}
	steps := []func() error{
		func() error { return kvPut(store, revisionKey(slug, time.Now()), string(oldJSON), retentionTTLSeconds) },
		func() error { return writePost(store, &updated) },
		func() error {
			return updateIndex(store, func(idx *PostIndex) {
				if renamed {
					idx.Remove(slug)
				}
				idx.Add(&updated)
			})
		},
	}
	if renamed {
		steps = append(steps, func() error {
			if err := store.Delete("post:" + slug); err != nil {
				return fmt.Errorf("delete post:%s: %w", slug, err)
			}
			return nil
		})
	}
	for _, step := range steps {
		if err := step(); err != nil {
			logErrorf("update %s: %v", slug, err)
			handleInternalError(w, r)
			return
		}
	}

	keys := append(postPurgeKeys(updated.Slug, updated.Tags), postPurgeKeys(slug, oldPost.Tags)...)
	purged := purgeKeys(ctx, keys)
	redirectTo(w, withPurgeFlag(adminHome, purged))
}

// handleDeletePost soft-deletes a post: a copy is kept under trash:<slug>.
func handleDeletePost(ctx context.Context, w fsthttp.ResponseWriter, r *fsthttp.Request, slug string) {
	if !authorize(w, r, wantsJSON(r)) {
		return
	}
	if !ValidSlug(slug) {
		handleNotFound(w, r)
		return
	}
	store, err := openContent()
	if err != nil {
		logErrorf("delete: %v", err)
		handleInternalError(w, r)
		return
	}
	post, found, err := readPost(store, slug)
	if err != nil {
		logErrorf("delete %s: %v", slug, err)
		handleInternalError(w, r)
		return
	}
	if !found {
		if err := updateIndex(store, func(idx *PostIndex) { idx.Remove(slug) }); err != nil {
			logErrorf("delete %s: %v", slug, err)
			handleInternalError(w, r)
			return
		}
		purged := purgeKeys(ctx, postPurgeKeys(slug, nil))
		redirectTo(w, withPurgeFlag(adminHome, purged))
		return
	}
	postJSON, err := json.Marshal(&post)
	if err != nil {
		logErrorf("delete %s: %v", slug, err)
		handleInternalError(w, r)
		return
	}
	if err := kvPut(store, trashKey(slug), string(postJSON), retentionTTLSeconds); err != nil {
		logErrorf("delete %s: %v", slug, err)
		handleInternalError(w, r)
		return
	}
	if err := store.Delete("post:" + slug); err != nil {
		logErrorf("delete %s: %v", slug, err)
		handleInternalError(w, r)
		return
	}
	if err := updateIndex(store, func(idx *PostIndex) { idx.Remove(slug) }); err != nil {
		logErrorf("delete %s: %v", slug, err)
		handleInternalError(w, r)
		return
	}
	purged := purgeKeys(ctx, postPurgeKeys(slug, post.Tags))
	redirectTo(w, withPurgeFlag(adminHome, purged))
}

// handleRebuildIndex regenerates _index from the stored posts.
func handleRebuildIndex(ctx context.Context, w fsthttp.ResponseWriter, r *fsthttp.Request) {
	if !authorize(w, r, false) {
		return
	}
	store, err := openContent()
	if err != nil {
		logErrorf("rebuild-index: %v", err)
		handleInternalError(w, r)
		return
	}
	if err := rebuildIndex(store); err != nil {
		logErrorf("rebuild-index: %v", err)
		handleInternalError(w, r)
		return
	}
	purged := purgeKeys(ctx, []string{"post-index"})
	redirectTo(w, withPurgeFlag(adminHome, purged))
}

// fosCredentials are the Object Storage settings read from the secret store.
type fosCredentials struct {
	accessKeyID, secretKey, region, bucket string
}

func readFOSCredentials() (fosCredentials, error) {
	var c fosCredentials
	fields := []struct {
		name string
		dst  *string
	}{
		{"fos_access_key_id", &c.accessKeyID},
		{"fos_secret_key", &c.secretKey},
		{"fos_region", &c.region},
		{"fos_bucket", &c.bucket},
	}
	for _, f := range fields {
		v, err := readSecret(f.name)
		if err != nil {
			return fosCredentials{}, fmt.Errorf("read %s: %w", f.name, err)
		}
		*f.dst = v
	}
	return c, nil
}

// signedUploadHeaders computes the SigV4 headers for a PUT to Fastly Object
// Storage. content-type, host, x-amz-content-sha256 and x-amz-date are signed.
func signedUploadHeaders(c fosCredentials, host, path, contentType string, body []byte, datetime, date string) (authorization, payloadHash string) {
	payloadHash = sha256Hex(body)
	canonicalHeaders := fmt.Sprintf("content-type:%s\nhost:%s\nx-amz-content-sha256:%s\nx-amz-date:%s\n", contentType, host, payloadHash, datetime)
	signedHeaders := "content-type;host;x-amz-content-sha256;x-amz-date"
	canonicalRequest := fmt.Sprintf("PUT\n%s\n\n%s\n%s\n%s", path, canonicalHeaders, signedHeaders, payloadHash)

	credentialScope := fmt.Sprintf("%s/%s/s3/aws4_request", date, c.region)
	stringToSign := fmt.Sprintf("AWS4-HMAC-SHA256\n%s\n%s\n%s", datetime, credentialScope, sha256Hex([]byte(canonicalRequest)))
	signature := signSigV4(deriveSigningKey(c.secretKey, date, c.region, "s3"), stringToSign)

	authorization = fmt.Sprintf("AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s",
		c.accessKeyID, credentialScope, signedHeaders, signature)
	return authorization, payloadHash
}

// handleUploadImage validates an image and uploads it to Fastly Object Storage
// with a SigV4-signed PUT.
func handleUploadImage(ctx context.Context, w fsthttp.ResponseWriter, r *fsthttp.Request) {
	if !authorize(w, r, true) {
		return
	}
	body, err := readLimitedBody(r, maxUploadBytes)
	if errors.Is(err, errBodyTooLarge) {
		writeJSONError(w, fsthttp.StatusRequestEntityTooLarge, "upload exceeds 10 MiB")
		return
	}
	if err != nil {
		logErrorf("upload: read body: %v", err)
		writeJSONError(w, fsthttp.StatusInternalServerError, "failed to read body")
		return
	}

	query := r.URL.Query()
	slug := query.Get("slug")
	filename := query.Get("filename")
	if !ValidSlug(slug) {
		writeJSONError(w, fsthttp.StatusBadRequest, "invalid slug")
		return
	}
	if !ValidFilename(filename) {
		writeJSONError(w, fsthttp.StatusBadRequest, "invalid filename")
		return
	}
	contentType := DetectImageType(body)
	if contentType == "" || !ImageTypeMatchesFilename(contentType, filename) {
		writeJSONError(w, fsthttp.StatusUnsupportedMediaType, "unsupported or mismatched image type")
		return
	}

	creds, err := readFOSCredentials()
	if err != nil {
		logErrorf("upload: %v", err)
		writeJSONError(w, fsthttp.StatusInternalServerError, "storage is not configured")
		return
	}
	host := creds.region + ".object.fastlystorage.app"
	path := fmt.Sprintf("/%s/%s/%s", creds.bucket, slug, filename)
	datetime, date := utcDatetime()
	authorization, payloadHash := signedUploadHeaders(creds, host, path, contentType, body, datetime, date)

	req, err := fsthttp.NewRequest("PUT", "https://"+host+path, strings.NewReader(string(body)))
	if err != nil {
		logErrorf("upload: build request: %v", err)
		writeJSONError(w, fsthttp.StatusInternalServerError, "request error")
		return
	}
	req.Header.Set("Host", host)
	req.Header.Set("Authorization", authorization)
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("x-amz-content-sha256", payloadHash)
	req.Header.Set("x-amz-date", datetime)

	resp, err := req.Send(ctx, "fastly-object-storage")
	if err != nil {
		logErrorf("upload: backend send: %v", err)
		writeJSONError(w, fsthttp.StatusBadGateway, "upload failed")
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		logErrorf("upload: storage returned %d: %s", resp.StatusCode, readSnippet(resp.Body))
		writeJSONError(w, fsthttp.StatusBadGateway, "upload rejected by storage")
		return
	}

	purgeKeys(ctx, []string{"image-" + slug})
	writeJSON(w, fsthttp.StatusOK, map[string]string{"url": "/images/" + slug + "/" + filename})
}

// handleSidebarPage renders the sidebar editor page.
func handleSidebarPage(ctx context.Context, w fsthttp.ResponseWriter, r *fsthttp.Request) {
	if !authorize(w, r, false) {
		return
	}
	cfg := loadConfig(r.Host)
	sidebar, err := readSidebar()
	if err != nil {
		logErrorf("sidebar page: %v", err)
		handleInternalError(w, r)
		return
	}
	sidebarJSON, err := json.Marshal(&sidebar)
	if err != nil {
		logErrorf("sidebar page: %v", err)
		handleInternalError(w, r)
		return
	}
	data := adminVars(cfg, "/admin/sidebar", "Sidebar")
	data["sidebar"] = sidebarView(sidebar)
	data["sidebar_json"] = string(sidebarJSON)
	writeAdminPage(w, r, fsthttp.StatusOK, "admin-sidebar", data)
}

// handleUpdateSidebar validates and saves the sidebar configuration (JSON).
func handleUpdateSidebar(ctx context.Context, w fsthttp.ResponseWriter, r *fsthttp.Request) {
	if !authorize(w, r, true) {
		return
	}
	body, err := readLimitedBody(r, maxFormBodyBytes)
	if errors.Is(err, errBodyTooLarge) {
		writeJSONError(w, fsthttp.StatusRequestEntityTooLarge, "request body is too large")
		return
	}
	if err != nil {
		writeJSONError(w, fsthttp.StatusBadRequest, "failed to read body")
		return
	}
	sidebar, err := ValidateSidebar(body)
	if err != nil {
		status, msg := failureStatus(err)
		writeJSONError(w, status, msg)
		return
	}
	sidebarJSON, err := json.Marshal(&sidebar)
	if err != nil {
		logErrorf("sidebar: %v", err)
		writeJSONError(w, fsthttp.StatusInternalServerError, "marshal error")
		return
	}
	store, err := openContent()
	if err != nil {
		logErrorf("sidebar: %v", err)
		writeJSONError(w, fsthttp.StatusInternalServerError, "store error")
		return
	}
	if err := kvPut(store, sidebarKey, string(sidebarJSON), 0); err != nil {
		logErrorf("sidebar: %v", err)
		writeJSONError(w, fsthttp.StatusInternalServerError, "write error")
		return
	}
	response := map[string]interface{}{"ok": true}
	if !purgeKeys(ctx, []string{"sidebar", "post-index"}) {
		response["purge_failed"] = true
	}
	writeJSON(w, fsthttp.StatusOK, response)
}
