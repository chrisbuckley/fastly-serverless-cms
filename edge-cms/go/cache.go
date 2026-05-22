package main

import (
	"fmt"
	"log"
	"strconv"
	"strings"

	"github.com/fastly/compute-sdk-go/configstore"
	"github.com/fastly/compute-sdk-go/fsthttp"
	"github.com/fastly/compute-sdk-go/purge"
)

func ttlFromConfig(key string) int {
	store, err := configstore.Open("cache_config")
	if err != nil {
		return 3600
	}
	val, err := store.Get(key)
	if err != nil {
		return 3600
	}
	n, err := strconv.Atoi(val)
	if err != nil {
		return 3600
	}
	return n
}

func applyCacheHeaders(w fsthttp.ResponseWriter, ttl int, keys ...string) {
	w.Header().Set("Surrogate-Control", fmt.Sprintf("max-age=%d", ttl))
	w.Header().Set("Cache-Control", fmt.Sprintf("max-age=%d, public", ttl))
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
