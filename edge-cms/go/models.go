package main

import (
	"encoding/json"
	"sort"
)

// PostStatus represents the publication status of a post.
type PostStatus string

const (
	StatusPublished PostStatus = "published"
	StatusDraft     PostStatus = "draft"
)

// Post represents a full blog post with content.
type Post struct {
	Slug          string     `json:"slug"`
	Title         string     `json:"title"`
	Content       string     `json:"content"`
	Excerpt       string     `json:"excerpt"`
	Status        PostStatus `json:"status"`
	CreatedAt     string     `json:"created_at"`
	UpdatedAt     string     `json:"updated_at"`
	Tags          []string   `json:"tags"`
	FeaturedImage *string    `json:"featured_image"`
	Author        string     `json:"author"`
}

// PostMeta is a lightweight representation of a post for index listings.
type PostMeta struct {
	Slug          string     `json:"slug"`
	Title         string     `json:"title"`
	Excerpt       string     `json:"excerpt"`
	Status        PostStatus `json:"status"`
	CreatedAt     string     `json:"created_at"`
	Tags          []string   `json:"tags"`
	FeaturedImage *string    `json:"featured_image"`
}

// PostIndex holds the list of all post metadata entries.
type PostIndex struct {
	Posts []PostMeta `json:"posts"`
}

// Published returns only the published posts from the index.
func (idx *PostIndex) Published() []PostMeta {
	var result []PostMeta
	for _, p := range idx.Posts {
		if p.Status == StatusPublished {
			result = append(result, p)
		}
	}
	return result
}

// ByTag returns published posts that contain the given tag.
func (idx *PostIndex) ByTag(tag string) []PostMeta {
	var result []PostMeta
	for _, p := range idx.Posts {
		if p.Status != StatusPublished {
			continue
		}
		for _, t := range p.Tags {
			if t == tag {
				result = append(result, p)
				break
			}
		}
	}
	return result
}

// AllTags returns sorted unique tags from published posts.
func (idx *PostIndex) AllTags() []string {
	seen := map[string]struct{}{}
	for _, p := range idx.Posts {
		if p.Status != StatusPublished {
			continue
		}
		for _, t := range p.Tags {
			seen[t] = struct{}{}
		}
	}
	tags := make([]string, 0, len(seen))
	for t := range seen {
		tags = append(tags, t)
	}
	sort.Strings(tags)
	return tags
}

// Add inserts a post's metadata at the front of the index, removing any
// existing entry with the same slug first.
func (idx *PostIndex) Add(post *Post) {
	idx.Remove(post.Slug)
	meta := PostMeta{
		Slug:          post.Slug,
		Title:         post.Title,
		Excerpt:       post.Excerpt,
		Status:        post.Status,
		CreatedAt:     post.CreatedAt,
		Tags:          post.Tags,
		FeaturedImage: post.FeaturedImage,
	}
	idx.Posts = append([]PostMeta{meta}, idx.Posts...)
}

// Remove filters out the post with the given slug from the index.
func (idx *PostIndex) Remove(slug string) {
	filtered := idx.Posts[:0]
	for _, p := range idx.Posts {
		if p.Slug != slug {
			filtered = append(filtered, p)
		}
	}
	idx.Posts = filtered
}

// SidebarItem represents a single entry in the sidebar navigation.
// It can be a "category" (with slug and children) or a "link" (with url and optional icon).
type SidebarItem struct {
	Type     string   `json:"type"`
	Label    string   `json:"label"`
	Slug     string   `json:"slug,omitempty"`
	Children []string `json:"children,omitempty"`
	URL      string   `json:"url,omitempty"`
	Icon     *string  `json:"icon,omitempty"`
}

// SidebarConfig holds the sidebar navigation configuration.
type SidebarConfig struct {
	Items []SidebarItem `json:"items"`
}

// MarshalJSON ensures Tags is always serialized as an array, never null.
func (p Post) MarshalJSON() ([]byte, error) {
	type PostAlias Post
	a := PostAlias(p)
	if a.Tags == nil {
		a.Tags = []string{}
	}
	return json.Marshal(a)
}

// MarshalJSON ensures Tags is always serialized as an array, never null.
func (pm PostMeta) MarshalJSON() ([]byte, error) {
	type PostMetaAlias PostMeta
	a := PostMetaAlias(pm)
	if a.Tags == nil {
		a.Tags = []string{}
	}
	return json.Marshal(a)
}
