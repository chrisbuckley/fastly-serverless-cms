package main

import (
	"github.com/fastly/compute-sdk-go/fsthttp"
)

// staticAsset maps a public /assets/ path to its embedded source and type.
type staticAsset struct {
	file        string
	contentType string
}

var staticAssets = map[string]staticAsset{
	"style.css":                  {"shared/css/style.css", "text/css; charset=utf-8"},
	"admin.css":                  {"shared/css/admin.css", "text/css; charset=utf-8"},
	"site.js":                    {"shared/js/site.js", "application/javascript; charset=utf-8"},
	"admin.js":                   {"shared/js/admin.js", "application/javascript; charset=utf-8"},
	"fonts/fraunces.woff2":       {"shared/fonts/fraunces.woff2", "font/woff2"},
	"fonts/dm-sans.woff2":        {"shared/fonts/dm-sans.woff2", "font/woff2"},
	"fonts/jetbrains-mono.woff2": {"shared/fonts/jetbrains-mono.woff2", "font/woff2"},
}

func handleStaticFile(w fsthttp.ResponseWriter, r *fsthttp.Request, name string) {
	asset, ok := staticAssets[name]
	if !ok {
		handleNotFound(w, r)
		return
	}
	body, err := assetFS.ReadFile(asset.file)
	if err != nil {
		logErrorf("asset %s: %v", name, err)
		handleInternalError(w, r)
		return
	}
	w.Header().Set("Content-Type", asset.contentType)
	applyAssetCache(w, loadConfig(r.Host))
	w.WriteHeader(fsthttp.StatusOK)
	w.Write(body)
}
