package main

import (
	"encoding/json"
	"os"
	"testing"
)

func TestDeserializePost(t *testing.T) {
	data, err := os.ReadFile("../shared/test-fixtures/sample-post.json")
	if err != nil {
		t.Fatalf("failed to read sample-post.json: %v", err)
	}

	var post Post
	if err := json.Unmarshal(data, &post); err != nil {
		t.Fatalf("failed to unmarshal post: %v", err)
	}

	if post.Slug != "hello-world" {
		t.Errorf("slug = %q, want %q", post.Slug, "hello-world")
	}
	if post.Title != "Hello World" {
		t.Errorf("title = %q, want %q", post.Title, "Hello World")
	}
	if post.Status != StatusPublished {
		t.Errorf("status = %q, want %q", post.Status, StatusPublished)
	}
	if len(post.Tags) != 2 || post.Tags[0] != "fastly" || post.Tags[1] != "edge" {
		t.Errorf("tags = %v, want [fastly edge]", post.Tags)
	}
	if post.FeaturedImage == nil || *post.FeaturedImage != "/images/hello-world/hero.jpg" {
		t.Errorf("featured_image = %v, want /images/hello-world/hero.jpg", post.FeaturedImage)
	}
	if post.Author != "Admin" {
		t.Errorf("author = %q, want %q", post.Author, "Admin")
	}
}

func TestDeserializeIndex(t *testing.T) {
	data, err := os.ReadFile("../shared/test-fixtures/sample-index.json")
	if err != nil {
		t.Fatalf("failed to read sample-index.json: %v", err)
	}

	var index PostIndex
	if err := json.Unmarshal(data, &index); err != nil {
		t.Fatalf("failed to unmarshal index: %v", err)
	}

	if len(index.Posts) != 2 {
		t.Fatalf("posts count = %d, want 2", len(index.Posts))
	}

	published := index.Published()
	if len(published) != 1 {
		t.Fatalf("published count = %d, want 1", len(published))
	}
	if published[0].Slug != "hello-world" {
		t.Errorf("published[0].slug = %q, want %q", published[0].Slug, "hello-world")
	}

	fastlyPosts := index.ByTag("fastly")
	if len(fastlyPosts) != 1 {
		t.Fatalf("by_tag(fastly) count = %d, want 1", len(fastlyPosts))
	}

	wipPosts := index.ByTag("wip")
	if len(wipPosts) != 0 {
		t.Errorf("by_tag(wip) count = %d, want 0 (drafts excluded)", len(wipPosts))
	}
}

func TestDeserializeSidebar(t *testing.T) {
	data, err := os.ReadFile("../shared/test-fixtures/sample-sidebar.json")
	if err != nil {
		t.Fatalf("failed to read sample-sidebar.json: %v", err)
	}

	var sidebar SidebarConfig
	if err := json.Unmarshal(data, &sidebar); err != nil {
		t.Fatalf("failed to unmarshal sidebar: %v", err)
	}

	if len(sidebar.Items) != 3 {
		t.Fatalf("items count = %d, want 3", len(sidebar.Items))
	}

	item0 := sidebar.Items[0]
	if item0.Type != "category" {
		t.Errorf("items[0].type = %q, want %q", item0.Type, "category")
	}
	if item0.Label != "Getting Started" {
		t.Errorf("items[0].label = %q, want %q", item0.Label, "Getting Started")
	}
	if item0.Slug != "getting-started" {
		t.Errorf("items[0].slug = %q, want %q", item0.Slug, "getting-started")
	}
	if len(item0.Children) != 1 || item0.Children[0] != "hello-world" {
		t.Errorf("items[0].children = %v, want [hello-world]", item0.Children)
	}

	item2 := sidebar.Items[2]
	if item2.Type != "link" {
		t.Errorf("items[2].type = %q, want %q", item2.Type, "link")
	}
	if item2.Label != "Fastly Docs" {
		t.Errorf("items[2].label = %q, want %q", item2.Label, "Fastly Docs")
	}
	if item2.Icon != nil {
		t.Errorf("items[2].icon = %v, want nil", item2.Icon)
	}
}

func TestIndexAddAndRemove(t *testing.T) {
	index := PostIndex{Posts: []PostMeta{}}

	post := Post{
		Slug:          "test-post",
		Title:         "Test",
		Content:       "body",
		Excerpt:       "exc",
		Status:        StatusPublished,
		CreatedAt:     "2026-01-01T00:00:00Z",
		UpdatedAt:     "2026-01-01T00:00:00Z",
		Tags:          []string{"test"},
		FeaturedImage: nil,
		Author:        "Admin",
	}

	index.Add(&post)
	if len(index.Posts) != 1 {
		t.Fatalf("after add: posts count = %d, want 1", len(index.Posts))
	}
	if index.Posts[0].Slug != "test-post" {
		t.Errorf("after add: posts[0].slug = %q, want %q", index.Posts[0].Slug, "test-post")
	}

	// Adding same slug again should deduplicate
	index.Add(&post)
	if len(index.Posts) != 1 {
		t.Errorf("after duplicate add: posts count = %d, want 1", len(index.Posts))
	}

	index.Remove("test-post")
	if len(index.Posts) != 0 {
		t.Errorf("after remove: posts count = %d, want 0", len(index.Posts))
	}
}

func TestPostRoundtripJSON(t *testing.T) {
	post := Post{
		Slug:          "roundtrip",
		Title:         "Roundtrip Test",
		Content:       "# Content\n\nWith **markdown**.",
		Excerpt:       "A roundtrip test",
		Status:        StatusDraft,
		CreatedAt:     "2026-05-20T12:00:00Z",
		UpdatedAt:     "2026-05-20T12:30:00Z",
		Tags:          []string{"test", "roundtrip"},
		FeaturedImage: nil,
		Author:        "Tester",
	}

	data, err := json.Marshal(&post)
	if err != nil {
		t.Fatalf("failed to marshal post: %v", err)
	}

	// Verify featured_image is present as null, not omitted
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("failed to unmarshal raw: %v", err)
	}
	if _, ok := raw["featured_image"]; !ok {
		t.Error("featured_image key missing from JSON (should be null, not omitted)")
	} else if string(raw["featured_image"]) != "null" {
		t.Errorf("featured_image = %s, want null", string(raw["featured_image"]))
	}

	var deserialized Post
	if err := json.Unmarshal(data, &deserialized); err != nil {
		t.Fatalf("failed to unmarshal post: %v", err)
	}

	if deserialized.Slug != post.Slug {
		t.Errorf("slug = %q, want %q", deserialized.Slug, post.Slug)
	}
	if deserialized.Title != post.Title {
		t.Errorf("title = %q, want %q", deserialized.Title, post.Title)
	}
	if deserialized.Content != post.Content {
		t.Errorf("content = %q, want %q", deserialized.Content, post.Content)
	}
	if deserialized.Status != post.Status {
		t.Errorf("status = %q, want %q", deserialized.Status, post.Status)
	}
	if len(deserialized.Tags) != len(post.Tags) {
		t.Errorf("tags len = %d, want %d", len(deserialized.Tags), len(post.Tags))
	}
	if deserialized.FeaturedImage != post.FeaturedImage {
		t.Errorf("featured_image = %v, want %v", deserialized.FeaturedImage, post.FeaturedImage)
	}
	if deserialized.Author != post.Author {
		t.Errorf("author = %q, want %q", deserialized.Author, post.Author)
	}
}

func TestIndexPublishedExcludesDrafts(t *testing.T) {
	img := "/images/test.jpg"
	index := PostIndex{
		Posts: []PostMeta{
			{
				Slug:          "pub-1",
				Title:         "Published 1",
				Excerpt:       "First published",
				Status:        StatusPublished,
				CreatedAt:     "2026-01-01T00:00:00Z",
				Tags:          []string{"a"},
				FeaturedImage: &img,
			},
			{
				Slug:          "draft-1",
				Title:         "Draft 1",
				Excerpt:       "A draft",
				Status:        StatusDraft,
				CreatedAt:     "2026-01-02T00:00:00Z",
				Tags:          []string{"b"},
				FeaturedImage: nil,
			},
			{
				Slug:          "pub-2",
				Title:         "Published 2",
				Excerpt:       "Second published",
				Status:        StatusPublished,
				CreatedAt:     "2026-01-03T00:00:00Z",
				Tags:          []string{"a"},
				FeaturedImage: nil,
			},
		},
	}

	published := index.Published()
	if len(published) != 2 {
		t.Fatalf("published count = %d, want 2", len(published))
	}
	for _, p := range published {
		if p.Status != StatusPublished {
			t.Errorf("published post %q has status %q", p.Slug, p.Status)
		}
	}
}
