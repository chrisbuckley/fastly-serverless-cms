package main

import (
	"fmt"
	"log"
	"strings"

	"github.com/fastly/compute-sdk-go/fsthttp"
	"github.com/fastly/compute-sdk-go/purge"
)

func applyCacheHeaders(w fsthttp.ResponseWriter, edgeTTL, browserTTL int, keys ...string) {
	w.Header().Set("Surrogate-Control", fmt.Sprintf("max-age=%d", edgeTTL))
	w.Header().Set("Cache-Control", fmt.Sprintf("max-age=%d, public", browserTTL))
	if len(keys) > 0 {
		w.Header().Set("Surrogate-Key", strings.Join(keys, " "))
	}
}

func noCache(w fsthttp.ResponseWriter) {
	w.Header().Set("Cache-Control", "private, no-store")
}

func purgeKeys(keys []string) {
	for _, key := range keys {
		if err := purge.PurgeSurrogateKey(key, purge.PurgeOptions{Soft: true}); err != nil {
			log.Printf("purge error key=%s: %v", key, err)
		}
	}
}
