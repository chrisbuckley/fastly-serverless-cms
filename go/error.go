package main

import (
	"encoding/json"
	"fmt"

	"github.com/fastly/compute-sdk-go/fsthttp"
)

func handleNotFound(w fsthttp.ResponseWriter, r *fsthttp.Request) {
	renderError(w, r, fsthttp.StatusNotFound, "404", "Page not found.")
}

func handleInternalError(w fsthttp.ResponseWriter, r *fsthttp.Request) {
	renderError(w, r, fsthttp.StatusInternalServerError, "500", "Something went wrong.")
}

// renderError writes an uncacheable HTML error page.
func renderError(w fsthttp.ResponseWriter, r *fsthttp.Request, status int, code, message string) {
	cfg := loadConfig(r.Host)
	data := layoutVars(cfg, r.URL.Path, fmt.Sprintf("%s Error", code), message)
	data["noindex"] = true
	data["error_code"] = code
	data["error_message"] = message
	data["sidebar"] = sidebarView(SidebarConfig{})
	data["all_tags"] = []string{}

	noCache(w)
	html, err := renderPage("error", data)
	if err != nil {
		logErrorf("render error page: %v", err)
		writeText(w, status, fmt.Sprintf("%s %s\n", code, message))
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	w.Write([]byte(html))
}

// writeText sends an uncacheable plain-text response.
func writeText(w fsthttp.ResponseWriter, status int, body string) {
	noCache(w)
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(status)
	w.Write([]byte(body))
}

// writeJSON sends an uncacheable JSON response.
func writeJSON(w fsthttp.ResponseWriter, status int, v interface{}) {
	b, err := json.Marshal(v)
	if err != nil {
		logErrorf("marshal json response: %v", err)
		b = []byte(`{"error":"internal error"}`)
		status = fsthttp.StatusInternalServerError
	}
	noCache(w)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	w.Write(b)
}

func writeJSONError(w fsthttp.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}
