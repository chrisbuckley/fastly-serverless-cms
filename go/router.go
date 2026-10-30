package main

import "strings"

// RouteKind identifies which handler should process the request.
type RouteKind int

const (
	RouteEdgeInfo RouteKind = iota
	RouteHome
	RoutePost
	RouteTag
	RouteImage
	RouteAsset
	RouteFeed
	RouteSitemap
	RouteRobots
	RouteAdminLogin
	RouteAdminLoginPost
	RouteAdminLogout
	RouteAdminDashboard
	RouteAdminNewPost
	RouteAdminCreatePost
	RouteAdminEditPost
	RouteAdminUpdatePost
	RouteAdminDeletePost
	RouteAdminUploadImage
	RouteAdminSidebar
	RouteAdminUpdateSidebar
	RouteAdminRebuildIndex
	RouteNotFound
)

// Route is the result of matching a request method + path.
// Param carries the slug/tag/path for parameterized routes, empty otherwise.
type Route struct {
	Kind  RouteKind
	Param string
}

// MatchRoute dispatches a request method and path to the appropriate Route.
// Exact matches are checked before prefix matches.
func MatchRoute(method, path string) Route {
	switch method {
	case "GET", "HEAD":
		return matchGet(path)
	case "POST":
		return matchPost(path)
	case "PUT":
		return matchPut(path)
	case "DELETE":
		return matchDelete(path)
	default:
		return Route{Kind: RouteNotFound}
	}
}

func matchGet(path string) Route {
	// Exact matches first.
	switch path {
	case "/api/edge-info":
		return Route{Kind: RouteEdgeInfo}
	case "/":
		return Route{Kind: RouteHome}
	case "/feed.xml":
		return Route{Kind: RouteFeed}
	case "/sitemap.xml":
		return Route{Kind: RouteSitemap}
	case "/robots.txt":
		return Route{Kind: RouteRobots}
	case "/admin/login":
		return Route{Kind: RouteAdminLogin}
	case "/admin":
		return Route{Kind: RouteAdminDashboard}
	case "/admin/posts/new":
		return Route{Kind: RouteAdminNewPost}
	case "/admin/sidebar":
		return Route{Kind: RouteAdminSidebar}
	}

	// Prefix matches — order matters.
	if strings.HasPrefix(path, "/admin/posts/") {
		// /admin/posts/{slug}/edit
		rest := path[len("/admin/posts/"):]
		if strings.HasSuffix(rest, "/edit") {
			slug := rest[:len(rest)-len("/edit")]
			if slug != "" {
				return Route{Kind: RouteAdminEditPost, Param: slug}
			}
		}
	}

	if strings.HasPrefix(path, "/post/") {
		return Route{Kind: RoutePost, Param: path[len("/post/"):]}
	}
	if strings.HasPrefix(path, "/tag/") {
		return Route{Kind: RouteTag, Param: path[len("/tag/"):]}
	}
	if strings.HasPrefix(path, "/images/") {
		return Route{Kind: RouteImage, Param: path[len("/images/"):]}
	}
	if strings.HasPrefix(path, "/assets/") {
		return Route{Kind: RouteAsset, Param: path[len("/assets/"):]}
	}

	return Route{Kind: RouteNotFound}
}

func matchPost(path string) Route {
	switch path {
	case "/admin/login":
		return Route{Kind: RouteAdminLoginPost}
	case "/admin/logout":
		return Route{Kind: RouteAdminLogout}
	case "/admin/posts":
		return Route{Kind: RouteAdminCreatePost}
	case "/admin/images":
		return Route{Kind: RouteAdminUploadImage}
	case "/admin/rebuild-index":
		return Route{Kind: RouteAdminRebuildIndex}
	}

	// POST /admin/posts/{slug} → update
	if strings.HasPrefix(path, "/admin/posts/") {
		slug := path[len("/admin/posts/"):]
		if slug != "" {
			return Route{Kind: RouteAdminUpdatePost, Param: slug}
		}
	}

	return Route{Kind: RouteNotFound}
}

func matchPut(path string) Route {
	if path == "/admin/sidebar" {
		return Route{Kind: RouteAdminUpdateSidebar}
	}

	// PUT /admin/posts/{slug} → update
	if strings.HasPrefix(path, "/admin/posts/") {
		slug := path[len("/admin/posts/"):]
		if slug != "" {
			return Route{Kind: RouteAdminUpdatePost, Param: slug}
		}
	}

	return Route{Kind: RouteNotFound}
}

func matchDelete(path string) Route {
	// DELETE /admin/posts/{slug}
	if strings.HasPrefix(path, "/admin/posts/") {
		slug := path[len("/admin/posts/"):]
		if slug != "" {
			return Route{Kind: RouteAdminDeletePost, Param: slug}
		}
	}

	return Route{Kind: RouteNotFound}
}
