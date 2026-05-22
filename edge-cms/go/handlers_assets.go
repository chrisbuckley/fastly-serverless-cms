package main

import (
	"strings"

	"github.com/fastly/compute-sdk-go/fsthttp"
	"github.com/fastly/compute-sdk-go/kvstore"
)

func handleStaticFile(w fsthttp.ResponseWriter, path string) {
	var body, contentType string
	switch path {
	case "style.css":
		body = cssContent
		contentType = "text/css; charset=utf-8"
	case "admin.js":
		body = adminJSContent
		contentType = "application/javascript; charset=utf-8"
	default:
		w.WriteHeader(fsthttp.StatusNotFound)
		w.Write([]byte("Asset not found\n"))
		return
	}
	w.Header().Set("Content-Type", contentType)
	applyCacheHeaders(w, ttlFromConfig("asset_ttl"), "assets")
	w.WriteHeader(fsthttp.StatusOK)
	w.Write([]byte(body))
}

func handleImage(w fsthttp.ResponseWriter, path string) {
	store, err := kvstore.Open("images")
	if err != nil {
		handleInternalError(w)
		return
	}
	entry, err := store.Lookup("images/" + path)
	if err != nil {
		w.WriteHeader(fsthttp.StatusNotFound)
		w.Write([]byte("Image not found\n"))
		return
	}

	ct := "application/octet-stream"
	lp := strings.ToLower(path)
	switch {
	case strings.HasSuffix(lp, ".jpg"), strings.HasSuffix(lp, ".jpeg"):
		ct = "image/jpeg"
	case strings.HasSuffix(lp, ".png"):
		ct = "image/png"
	case strings.HasSuffix(lp, ".webp"):
		ct = "image/webp"
	case strings.HasSuffix(lp, ".gif"):
		ct = "image/gif"
	case strings.HasSuffix(lp, ".svg"):
		ct = "image/svg+xml"
	}

	slug := strings.SplitN(path, "/", 2)[0]
	w.Header().Set("Content-Type", ct)
	applyCacheHeaders(w, ttlFromConfig("image_ttl"), "image-"+slug)
	w.WriteHeader(fsthttp.StatusOK)
	w.Write([]byte(entry.String()))
}
