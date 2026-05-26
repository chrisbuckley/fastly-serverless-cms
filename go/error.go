package main

import (
	"fmt"

	"github.com/fastly/compute-sdk-go/fsthttp"
)

func handleNotFound(w fsthttp.ResponseWriter) {
	renderError(w, fsthttp.StatusNotFound, "404", "Page not found.")
}

func handleInternalError(w fsthttp.ResponseWriter) {
	renderError(w, fsthttp.StatusInternalServerError, "500", "Something went wrong.")
}

func renderError(w fsthttp.ResponseWriter, status int, code, message string) {
	data := map[string]interface{}{
		"error_code":    code,
		"error_message": message,
		"page_title":    fmt.Sprintf("%s Error", code),
		"sidebar":       SidebarConfig{Items: []SidebarItem{}},
		"pop_city":      "Edge",
		"pop_code":      "CDN",
	}
	html, err := renderPage("error", data)
	if err != nil {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(status)
		fmt.Fprintf(w, "%s %s\n", code, message)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	w.Write([]byte(html))
}
