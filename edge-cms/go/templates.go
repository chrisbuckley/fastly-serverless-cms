package main

import (
	"embed"
	"fmt"
	"strings"
	"sync"

	"github.com/aymerick/raymond"
)

// Go's embed package does not follow symlinks or ".." paths.
// The build step copies ../shared/ into ./shared/ before compilation.
// See Makefile target "copy-shared".

//go:embed shared/templates/*.hbs
var templateFS embed.FS

//go:embed shared/css/style.css
var cssContent string

//go:embed shared/js/admin.js
var adminJSContent string

var (
	initOnce    sync.Once
	templateMap map[string]*raymond.Template
	layoutTpl   *raymond.Template
)

// templateNames lists all templates to load (excluding the _sidebar partial).
var templateNames = []string{
	"layout",
	"home",
	"post",
	"tag",
	"error",
	"login",
	"admin-dashboard",
	"admin-editor",
	"admin-sidebar",
}

func initTemplates() {
	initOnce.Do(func() {
		templateMap = make(map[string]*raymond.Template)

		// Embedded files are accessed via the symlink path: shared/templates/<name>.hbs
		basePath := "shared/templates/"

		// Parse all named templates.
		for _, name := range templateNames {
			data, err := templateFS.ReadFile(basePath + name + ".hbs")
			if err != nil {
				panic(fmt.Sprintf("failed to read template %q: %v", name, err))
			}
			tpl, err := raymond.Parse(string(data))
			if err != nil {
				panic(fmt.Sprintf("failed to parse template %q: %v", name, err))
			}
			templateMap[name] = tpl
		}

		// Store layout separately for renderPage.
		layoutTpl = templateMap["layout"]

		// Register _sidebar as a partial.
		sidebarData, err := templateFS.ReadFile(basePath + "_sidebar.hbs")
		if err != nil {
			panic(fmt.Sprintf("failed to read sidebar partial: %v", err))
		}
		raymond.RegisterPartial("_sidebar", string(sidebarData))

		// Register global helpers.
		raymond.RegisterHelper("format_date", formatDateHelper)
		raymond.RegisterHelper("reading_time", readingTimeHelper)
		raymond.RegisterHelper("eq", eqHelper)
	})
}

// renderTemplate renders a single template by name with the given data.
func renderTemplate(name string, data interface{}) (string, error) {
	initTemplates()
	tpl, ok := templateMap[name]
	if !ok {
		return "", fmt.Errorf("template %q not found", name)
	}
	return tpl.Exec(data)
}

// renderPage renders a body template, then wraps it in the layout template.
// The body content is inserted as the "body" key in the data map, using
// raymond.SafeString to prevent HTML escaping.
func renderPage(name string, data map[string]interface{}) (string, error) {
	initTemplates()
	tpl, ok := templateMap[name]
	if !ok {
		return "", fmt.Errorf("template %q not found", name)
	}
	body, err := tpl.Exec(data)
	if err != nil {
		return "", fmt.Errorf("rendering body template %q: %w", name, err)
	}
	data["body"] = raymond.SafeString(body)
	return layoutTpl.Exec(data)
}

// formatDateHelper converts "2026-05-20T14:30:00Z" to "May 20, 2026".
// If the input is shorter than 10 characters, it is returned as-is.
func formatDateHelper(dateStr string) string {
	if len(dateStr) < 10 {
		return dateStr
	}
	parts := strings.Split(dateStr[:10], "-")
	if len(parts) != 3 {
		return dateStr
	}
	months := map[string]string{
		"01": "Jan", "02": "Feb", "03": "Mar", "04": "Apr",
		"05": "May", "06": "Jun", "07": "Jul", "08": "Aug",
		"09": "Sep", "10": "Oct", "11": "Nov", "12": "Dec",
	}
	month, ok := months[parts[1]]
	if !ok {
		return dateStr
	}
	// Strip leading zero from day.
	day := strings.TrimLeft(parts[2], "0")
	if day == "" {
		day = "0"
	}
	return fmt.Sprintf("%s %s, %s", month, day, parts[0])
}

// readingTimeHelper estimates reading time from word count (200 wpm, min 1 minute).
func readingTimeHelper(content string) string {
	words := len(strings.Fields(content))
	minutes := words / 200
	if minutes < 1 {
		minutes = 1
	}
	return fmt.Sprintf("%d", minutes)
}

// eqHelper returns true if a and b are equal strings.
func eqHelper(a, b string) bool {
	return a == b
}
