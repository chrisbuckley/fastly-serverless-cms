package main

import (
	"context"
	"time"

	"github.com/fastly/compute-sdk-go/fsthttp"
)

// statusRecorder remembers the status code written so it can be logged.
type statusRecorder struct {
	fsthttp.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	if s.status == 0 {
		s.status = code
	}
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusRecorder) Write(p []byte) (int, error) {
	if s.status == 0 {
		s.status = fsthttp.StatusOK
	}
	return s.ResponseWriter.Write(p)
}

// originAuthorized enforces the VCL-injected shared secret (contract section 1).
func originAuthorized(r *fsthttp.Request) bool {
	expected, err := readSecret("origin_auth_token")
	if err != nil {
		return false
	}
	return OriginAuthOK(expected, r.Header.Get("Edge-CMS-Origin-Auth"))
}

func main() {
	fsthttp.ServeFunc(func(ctx context.Context, rw fsthttp.ResponseWriter, r *fsthttp.Request) {
		start := time.Now()
		w := &statusRecorder{ResponseWriter: rw}
		path := r.URL.Path

		applySecurityHeaders(w.Header(), path)
		w.Header().Set("X-Edge-CMS-Compute-Version", assetVersion())

		dispatch(ctx, w, r)

		logRequest(r.Method, path, w.status, time.Since(start), clientIP(r))
	})
}

// dispatch performs origin authentication, CSRF checks and routing.
func dispatch(ctx context.Context, w fsthttp.ResponseWriter, r *fsthttp.Request) {
	if !originAuthorized(r) {
		writeText(w, fsthttp.StatusForbidden, "Forbidden\n")
		return
	}

	route := MatchRoute(r.Method, r.URL.Path)
	if isAdminPath(r.URL.Path) && !IsSafeMethod(r.Method) {
		cfg := loadConfig(r.Host)
		if !CSRFAllowed(r.Header.Get("Sec-Fetch-Site"), r.Header.Get("Origin"), cfg.SiteURL) {
			writeText(w, fsthttp.StatusForbidden, "Forbidden\n")
			return
		}
	}

	switch route.Kind {
	case RouteEdgeInfo:
		handleEdgeInfo(ctx, w, r)
	case RouteHome:
		handleHome(ctx, w, r)
	case RoutePost:
		handlePost(ctx, w, r, route.Param)
	case RouteTag:
		handleTag(ctx, w, r, route.Param)
	case RouteImage:
		handleNotFound(w, r)
	case RouteAsset:
		handleStaticFile(w, r, route.Param)
	case RouteFeed:
		handleFeed(ctx, w, r)
	case RouteSitemap:
		handleSitemap(ctx, w, r)
	case RouteRobots:
		handleRobots(ctx, w, r)
	case RouteAdminLogin:
		handleLoginPage(ctx, w, r)
	case RouteAdminLoginPost:
		handleLoginSubmit(ctx, w, r)
	case RouteAdminLogout:
		handleLogout(ctx, w, r)
	case RouteAdminDashboard:
		handleDashboard(ctx, w, r)
	case RouteAdminNewPost:
		handleNewPost(ctx, w, r)
	case RouteAdminCreatePost:
		handleCreatePost(ctx, w, r)
	case RouteAdminEditPost:
		handleEditPost(ctx, w, r, route.Param)
	case RouteAdminUpdatePost:
		handleUpdatePost(ctx, w, r, route.Param)
	case RouteAdminDeletePost:
		handleDeletePost(ctx, w, r, route.Param)
	case RouteAdminUploadImage:
		handleUploadImage(ctx, w, r)
	case RouteAdminSidebar:
		handleSidebarPage(ctx, w, r)
	case RouteAdminUpdateSidebar:
		handleUpdateSidebar(ctx, w, r)
	case RouteAdminRebuildIndex:
		handleRebuildIndex(ctx, w, r)
	default:
		handleNotFound(w, r)
	}
}
