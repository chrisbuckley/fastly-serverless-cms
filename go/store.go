package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/fastly/compute-sdk-go/kvstore"
)

const (
	retentionTTLSeconds = 30 * 24 * 3600
	indexWriteRetries   = 5
	indexKey            = "_index"
	sidebarKey          = "_sidebar"
)

func openContent() (*kvstore.Store, error) {
	store, err := kvstore.Open("content")
	if err != nil {
		return nil, fmt.Errorf("open content store: %w", err)
	}
	return store, nil
}

// kvGet returns the value for key. A missing key is (_, false, nil); every
// other failure is returned as an error so it can surface as a 500.
func kvGet(store *kvstore.Store, key string) (value string, found bool, err error) {
	entry, err := store.Lookup(key)
	if err != nil {
		if errors.Is(err, kvstore.ErrKeyNotFound) {
			return "", false, nil
		}
		return "", false, fmt.Errorf("lookup %s: %w", key, err)
	}
	return entry.String(), true, nil
}

// kvPut overwrites key. ttlSeconds of 0 means no expiry.
func kvPut(store *kvstore.Store, key, value string, ttlSeconds uint32) error {
	cfg := &kvstore.InsertConfig{Mode: kvstore.InsertModeOverwrite, TTLSec: ttlSeconds}
	if err := store.InsertWithConfig(key, strings.NewReader(value), cfg); err != nil {
		return fmt.Errorf("insert %s: %w", key, err)
	}
	return nil
}

func readPost(store *kvstore.Store, slug string) (Post, bool, error) {
	raw, found, err := kvGet(store, "post:"+slug)
	if err != nil || !found {
		return Post{}, false, err
	}
	var post Post
	if err := json.Unmarshal([]byte(raw), &post); err != nil {
		return Post{}, false, fmt.Errorf("parse post %s: %w", slug, err)
	}
	return post, true, nil
}

func writePost(store *kvstore.Store, post *Post) error {
	b, err := json.Marshal(post)
	if err != nil {
		return err
	}
	return kvPut(store, "post:"+post.Slug, string(b), 0)
}

func parseIndex(raw string) (PostIndex, error) {
	var index PostIndex
	if err := json.Unmarshal([]byte(raw), &index); err != nil {
		return PostIndex{}, fmt.Errorf("parse index: %w", err)
	}
	if index.Posts == nil {
		index.Posts = []PostMeta{}
	}
	return index, nil
}

// readIndexFrom loads the post index. Only a missing key yields an empty
// index; any other error propagates.
func readIndexFrom(store *kvstore.Store) (PostIndex, error) {
	raw, found, err := kvGet(store, indexKey)
	if err != nil {
		return PostIndex{}, err
	}
	if !found {
		return PostIndex{Posts: []PostMeta{}}, nil
	}
	return parseIndex(raw)
}

func readIndex() (PostIndex, error) {
	store, err := openContent()
	if err != nil {
		return PostIndex{}, err
	}
	return readIndexFrom(store)
}

func readSidebar() (SidebarConfig, error) {
	store, err := openContent()
	if err != nil {
		return SidebarConfig{}, err
	}
	raw, found, err := kvGet(store, sidebarKey)
	if err != nil {
		return SidebarConfig{}, err
	}
	if !found {
		return SidebarConfig{Items: []SidebarItem{}}, nil
	}
	var sidebar SidebarConfig
	if err := json.Unmarshal([]byte(raw), &sidebar); err != nil {
		return SidebarConfig{}, fmt.Errorf("parse sidebar: %w", err)
	}
	if sidebar.Items == nil {
		sidebar.Items = []SidebarItem{}
	}
	return sidebar, nil
}

// updateIndex applies mutate to the stored index using a generation-conditional
// insert (kvstore IfGenerationMatch), retrying up to five times when another
// writer changed the index in between. A missing index is written with a plain
// insert because generation 0 cannot be expressed as a condition by the SDK.
func updateIndex(store *kvstore.Store, mutate func(*PostIndex)) error {
	var lastErr error
	for attempt := 0; attempt < indexWriteRetries; attempt++ {
		var index PostIndex
		var generation uint64

		entry, err := store.Lookup(indexKey)
		switch {
		case err == nil:
			generation = entry.Generation()
			if index, err = parseIndex(entry.String()); err != nil {
				return err
			}
		case errors.Is(err, kvstore.ErrKeyNotFound):
			index = PostIndex{Posts: []PostMeta{}}
		default:
			return fmt.Errorf("lookup %s: %w", indexKey, err)
		}

		mutate(&index)
		b, err := json.Marshal(&index)
		if err != nil {
			return err
		}
		cfg := &kvstore.InsertConfig{Mode: kvstore.InsertModeOverwrite, IfGenerationMatch: generation}
		err = store.InsertWithConfig(indexKey, strings.NewReader(string(b)), cfg)
		if err == nil {
			return nil
		}
		if !errors.Is(err, kvstore.ErrPreconditionFailed) {
			return fmt.Errorf("insert %s: %w", indexKey, err)
		}
		lastErr = err
	}
	return fmt.Errorf("update index: too many concurrent writers: %w", lastErr)
}

// rebuildIndex regenerates _index from every post:<slug> key.
func rebuildIndex(store *kvstore.Store) error {
	var metas []PostMeta
	it := store.List(&kvstore.ListConfig{Prefix: "post:", Mode: kvstore.ListConsistencyStrong})
	for it.Next() {
		for _, key := range it.Page().Data {
			slug := strings.TrimPrefix(key, "post:")
			post, found, err := readPost(store, slug)
			if err != nil {
				return err
			}
			if !found {
				continue
			}
			var idx PostIndex
			idx.Add(&post)
			metas = append(metas, idx.Posts...)
		}
	}
	if err := it.Err(); err != nil {
		return fmt.Errorf("list posts: %w", err)
	}
	sort.SliceStable(metas, func(i, j int) bool { return metas[i].CreatedAt > metas[j].CreatedAt })
	if metas == nil {
		metas = []PostMeta{}
	}
	b, err := json.Marshal(&PostIndex{Posts: metas})
	if err != nil {
		return err
	}
	return kvPut(store, indexKey, string(b), 0)
}

// revisionKey names the backup written before a post is overwritten.
func revisionKey(slug string, at time.Time) string {
	return fmt.Sprintf("rev:%s:%d", slug, at.Unix())
}

func trashKey(slug string) string { return "trash:" + slug }
