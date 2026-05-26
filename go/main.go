package main

import (
	"context"
	"log"
	"os"
	"time"

	"github.com/fastly/compute-sdk-go/fsthttp"
)

func main() {
	fsthttp.ServeFunc(func(ctx context.Context, w fsthttp.ResponseWriter, r *fsthttp.Request) {
		method := r.Method
		path := r.URL.Path
		start := time.Now()

		route := MatchRoute(method, path)

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
			handleImage(w, route.Param)
		case RouteAsset:
			handleStaticFile(w, route.Param)
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
		case RouteNotFound:
			handleNotFound(w)
		}

		log.Printf("[%s] %s %dms", method, path, time.Since(start).Milliseconds())

		if v := os.Getenv("FASTLY_SERVICE_VERSION"); v != "" {
			w.Header().Set("X-Edge-CMS-Compute-Version", v)
		}
	})
}
