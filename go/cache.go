package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"

	"github.com/fastly/compute-sdk-go/configstore"
	"github.com/fastly/compute-sdk-go/fsthttp"
)

const (
	defaultPageTTL  = 86400
	defaultAssetTTL = 31536000
	defaultPageSize = 10
	maxLoggedBody   = 200
)

// Config holds the values read from the cache_config Config Store.
type Config struct {
	SiteURL  string
	PageTTL  int
	AssetTTL int
	PageSize int
}

// loadConfig reads cache_config, applying the contract defaults for any
// missing or malformed key. SiteURL defaults to https:// plus the Host header.
func loadConfig(host string) Config {
	var lookup func(string) (string, bool)
	if store, err := configstore.Open("cache_config"); err == nil {
		lookup = func(key string) (string, bool) {
			v, err := store.Get(key)
			return v, err == nil
		}
	}
	return buildConfig(lookup, host)
}

// buildConfig is the pure core of loadConfig; lookup may be nil.
func buildConfig(lookup func(string) (string, bool), host string) Config {
	get := func(key string) string {
		if lookup == nil {
			return ""
		}
		v, _ := lookup(key)
		return strings.TrimSpace(v)
	}
	intOr := func(key string, def int) int {
		n, err := strconv.Atoi(get(key))
		if err != nil || n <= 0 {
			return def
		}
		return n
	}
	cfg := Config{
		SiteURL:  strings.TrimRight(get("site_url"), "/"),
		PageTTL:  intOr("page_ttl", defaultPageTTL),
		AssetTTL: intOr("asset_ttl", defaultAssetTTL),
		PageSize: intOr("page_size", defaultPageSize),
	}
	if cfg.SiteURL == "" {
		cfg.SiteURL = "https://" + host
	}
	return cfg
}

// assetVersion identifies the deployed build for cache-busting asset URLs.
func assetVersion() string {
	if v := os.Getenv("FASTLY_SERVICE_VERSION"); v != "" {
		return v
	}
	return "dev"
}

func surrogateControl(ttl int) string {
	return fmt.Sprintf("max-age=%d, stale-while-revalidate=60, stale-if-error=86400", ttl)
}

// applyPageCache marks a rendered HTML page cacheable for page_ttl.
func applyPageCache(w fsthttp.ResponseWriter, cfg Config, keys ...string) {
	w.Header().Set("Surrogate-Control", surrogateControl(cfg.PageTTL))
	w.Header().Set("Cache-Control", fmt.Sprintf("max-age=%d, public", cfg.PageTTL))
	setSurrogateKeys(w, keys)
}

// applyFeedCache is used for feed.xml, sitemap.xml and robots.txt.
func applyFeedCache(w fsthttp.ResponseWriter, cfg Config) {
	w.Header().Set("Surrogate-Control", surrogateControl(cfg.PageTTL))
	w.Header().Set("Cache-Control", "public, max-age=300")
	setSurrogateKeys(w, []string{"post-index"})
}

// applyAssetCache marks a versioned static asset as immutable.
func applyAssetCache(w fsthttp.ResponseWriter, cfg Config) {
	w.Header().Set("Surrogate-Control", fmt.Sprintf("max-age=%d", cfg.AssetTTL))
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	setSurrogateKeys(w, []string{"assets"})
}

func setSurrogateKeys(w fsthttp.ResponseWriter, keys []string) {
	if len(keys) > 0 {
		w.Header().Set("Surrogate-Key", strings.Join(keys, " "))
	}
}

func noCache(w fsthttp.ResponseWriter) {
	w.Header().Del("Surrogate-Control")
	w.Header().Set("Cache-Control", "private, no-store")
}

// dedupeKeys removes empty and repeated surrogate keys, preserving order.
func dedupeKeys(keys []string) []string {
	seen := make(map[string]struct{}, len(keys))
	out := make([]string, 0, len(keys))
	for _, k := range keys {
		if k == "" {
			continue
		}
		if _, dup := seen[k]; dup {
			continue
		}
		seen[k] = struct{}{}
		out = append(out, k)
	}
	return out
}

// postPurgeKeys lists the surrogate keys affected by a change to the post
// identified by slug with the given tags (contract section 7).
func postPurgeKeys(slug string, tags []string) []string {
	keys := []string{"post-index", "post-" + slug, "sidebar"}
	for _, t := range tags {
		keys = append(keys, "tag-"+t)
	}
	return keys
}

// purgeKeys soft-purges surrogate keys on the CDN service named by the
// purge_service_id secret using the Fastly Purge API via the fastly-api
// backend. It reports whether the API answered with a 2xx status.
func purgeKeys(ctx context.Context, keys []string) bool {
	keys = dedupeKeys(keys)
	if len(keys) == 0 {
		return true
	}
	token, err := readSecret("fastly_api_token")
	if err != nil {
		logError("purge: missing fastly_api_token secret")
		return false
	}
	serviceID, err := readSecret("purge_service_id")
	if err != nil {
		logError("purge: missing purge_service_id secret")
		return false
	}
	req, err := fsthttp.NewRequest("POST", "https://api.fastly.com/service/"+serviceID+"/purge", nil)
	if err != nil {
		logError("purge: build request: " + err.Error())
		return false
	}
	req.Header.Set("Fastly-Key", token)
	req.Header.Set("Surrogate-Key", strings.Join(keys, " "))
	req.Header.Set("Fastly-Soft-Purge", "1")
	resp, err := req.Send(ctx, "fastly-api")
	if err != nil {
		logError("purge: send failed: " + err.Error())
		return false
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		logError(fmt.Sprintf("purge: status %d: %s", resp.StatusCode, readSnippet(resp.Body)))
		return false
	}
	return true
}

// readSnippet returns at most maxLoggedBody bytes of r for logging.
func readSnippet(r io.Reader) string {
	b, _ := io.ReadAll(io.LimitReader(r, maxLoggedBody))
	return string(b)
}

// withPurgeFlag appends ?purge=failed to a redirect target when a purge failed.
func withPurgeFlag(target string, ok bool) string {
	if ok {
		return target
	}
	if strings.Contains(target, "?") {
		return target + "&purge=failed"
	}
	return target + "?purge=failed"
}
