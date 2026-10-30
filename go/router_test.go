package main

import "testing"

func assertRoute(t *testing.T, method, path string, wantKind RouteKind, wantParam string) {
	t.Helper()
	got := MatchRoute(method, path)
	if got.Kind != wantKind {
		t.Errorf("MatchRoute(%q, %q).Kind = %d, want %d", method, path, got.Kind, wantKind)
	}
	if got.Param != wantParam {
		t.Errorf("MatchRoute(%q, %q).Param = %q, want %q", method, path, got.Param, wantParam)
	}
}

func TestRouteHome(t *testing.T) {
	assertRoute(t, "GET", "/", RouteHome, "")
}

func TestRoutePost(t *testing.T) {
	assertRoute(t, "GET", "/post/hello-world", RoutePost, "hello-world")
}

func TestRouteTag(t *testing.T) {
	assertRoute(t, "GET", "/tag/rust", RouteTag, "rust")
}

func TestRouteImage(t *testing.T) {
	assertRoute(t, "GET", "/images/hero.jpg", RouteImage, "hero.jpg")
}

func TestRouteAsset(t *testing.T) {
	assertRoute(t, "GET", "/assets/style.css", RouteAsset, "style.css")
}

func TestRouteFeed(t *testing.T) {
	assertRoute(t, "GET", "/feed.xml", RouteFeed, "")
}

func TestRouteSitemap(t *testing.T) {
	assertRoute(t, "GET", "/sitemap.xml", RouteSitemap, "")
}

func TestRouteRobots(t *testing.T) {
	assertRoute(t, "GET", "/robots.txt", RouteRobots, "")
}

func TestRouteEdgeInfo(t *testing.T) {
	assertRoute(t, "GET", "/api/edge-info", RouteEdgeInfo, "")
}

func TestRouteAdminLogin(t *testing.T) {
	assertRoute(t, "GET", "/admin/login", RouteAdminLogin, "")
	assertRoute(t, "POST", "/admin/login", RouteAdminLoginPost, "")
}

func TestRouteAdminDashboard(t *testing.T) {
	assertRoute(t, "GET", "/admin", RouteAdminDashboard, "")
}

func TestRouteAdminNewPost(t *testing.T) {
	assertRoute(t, "GET", "/admin/posts/new", RouteAdminNewPost, "")
}

func TestRouteAdminCreatePost(t *testing.T) {
	assertRoute(t, "POST", "/admin/posts", RouteAdminCreatePost, "")
}

func TestRouteAdminEditPost(t *testing.T) {
	assertRoute(t, "GET", "/admin/posts/hello-world/edit", RouteAdminEditPost, "hello-world")
}

func TestRouteAdminUpdatePostPUT(t *testing.T) {
	assertRoute(t, "PUT", "/admin/posts/hello-world", RouteAdminUpdatePost, "hello-world")
}

func TestRouteAdminUpdatePostPOST(t *testing.T) {
	assertRoute(t, "POST", "/admin/posts/hello-world", RouteAdminUpdatePost, "hello-world")
}

func TestRouteAdminDeletePost(t *testing.T) {
	assertRoute(t, "DELETE", "/admin/posts/hello-world", RouteAdminDeletePost, "hello-world")
}

func TestRouteAdminUploadImage(t *testing.T) {
	assertRoute(t, "POST", "/admin/images", RouteAdminUploadImage, "")
}

func TestRouteAdminSidebar(t *testing.T) {
	assertRoute(t, "GET", "/admin/sidebar", RouteAdminSidebar, "")
	assertRoute(t, "PUT", "/admin/sidebar", RouteAdminUpdateSidebar, "")
}

func TestRouteAdminLogout(t *testing.T) {
	assertRoute(t, "POST", "/admin/logout", RouteAdminLogout, "")
}

func TestRouteNotFound(t *testing.T) {
	assertRoute(t, "GET", "/nonexistent", RouteNotFound, "")
	assertRoute(t, "POST", "/nonexistent", RouteNotFound, "")
	assertRoute(t, "PATCH", "/admin/posts/foo", RouteNotFound, "")
}

func TestRouteAdminRebuildIndex(t *testing.T) {
	assertRoute(t, "POST", "/admin/rebuild-index", RouteAdminRebuildIndex, "")
	assertRoute(t, "GET", "/admin/rebuild-index", RouteNotFound, "")
}

func TestRouteHead(t *testing.T) {
	assertRoute(t, "HEAD", "/", RouteHome, "")
}

func TestRouteNoPostSidebar(t *testing.T) {
	assertRoute(t, "POST", "/admin/sidebar", RouteNotFound, "")
}
