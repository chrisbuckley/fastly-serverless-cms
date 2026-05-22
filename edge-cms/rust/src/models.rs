use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum PostStatus {
    Published,
    Draft,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Post {
    pub slug: String,
    pub title: String,
    pub content: String,
    pub excerpt: String,
    pub status: PostStatus,
    pub created_at: String,
    pub updated_at: String,
    pub tags: Vec<String>,
    pub featured_image: Option<String>,
    pub author: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PostMeta {
    pub slug: String,
    pub title: String,
    pub excerpt: String,
    pub status: PostStatus,
    pub created_at: String,
    pub tags: Vec<String>,
    pub featured_image: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PostIndex {
    pub posts: Vec<PostMeta>,
}

impl PostIndex {
    pub fn published(&self) -> Vec<&PostMeta> {
        self.posts
            .iter()
            .filter(|p| p.status == PostStatus::Published)
            .collect()
    }

    pub fn by_tag(&self, tag: &str) -> Vec<&PostMeta> {
        self.posts
            .iter()
            .filter(|p| p.status == PostStatus::Published && p.tags.contains(&tag.to_string()))
            .collect()
    }

    pub fn all_tags(&self) -> Vec<String> {
        let mut seen = std::collections::BTreeSet::new();
        for p in &self.posts {
            if p.status == PostStatus::Published {
                for t in &p.tags {
                    seen.insert(t.clone());
                }
            }
        }
        seen.into_iter().collect()
    }

    pub fn add(&mut self, post: &Post) {
        self.posts.retain(|p| p.slug != post.slug);
        self.posts.insert(
            0,
            PostMeta {
                slug: post.slug.clone(),
                title: post.title.clone(),
                excerpt: post.excerpt.clone(),
                status: post.status.clone(),
                created_at: post.created_at.clone(),
                tags: post.tags.clone(),
                featured_image: post.featured_image.clone(),
            },
        );
    }

    pub fn remove(&mut self, slug: &str) {
        self.posts.retain(|p| p.slug != slug);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum SidebarItem {
    #[serde(rename = "category")]
    Category {
        label: String,
        slug: String,
        children: Vec<String>,
    },
    #[serde(rename = "link")]
    Link {
        label: String,
        url: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        icon: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SidebarConfig {
    pub items: Vec<SidebarItem>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deserialize_post() {
        let json = include_str!("../../shared/test-fixtures/sample-post.json");
        let post: Post = serde_json::from_str(json).expect("should deserialize post");
        assert_eq!(post.slug, "hello-world");
        assert_eq!(post.title, "Hello World");
        assert_eq!(post.status, PostStatus::Published);
        assert_eq!(post.tags, vec!["fastly", "edge"]);
        assert!(post.content.contains("**markdown**"));
        assert!(post.content.contains("```rust"));
        assert_eq!(post.author, "Admin");
        assert_eq!(
            post.featured_image,
            Some("/images/hello-world/hero.jpg".to_string())
        );
    }

    #[test]
    fn deserialize_index() {
        let json = include_str!("../../shared/test-fixtures/sample-index.json");
        let index: PostIndex = serde_json::from_str(json).expect("should deserialize index");
        assert_eq!(index.posts.len(), 2);

        let published = index.published();
        assert_eq!(published.len(), 1);
        assert_eq!(published[0].slug, "hello-world");

        let fastly_posts = index.by_tag("fastly");
        assert_eq!(fastly_posts.len(), 1);
        assert_eq!(fastly_posts[0].slug, "hello-world");

        let wip_posts = index.by_tag("wip");
        assert_eq!(
            wip_posts.len(),
            0,
            "draft posts should not appear in by_tag"
        );
    }

    #[test]
    fn deserialize_sidebar() {
        let json = include_str!("../../shared/test-fixtures/sample-sidebar.json");
        let sidebar: SidebarConfig =
            serde_json::from_str(json).expect("should deserialize sidebar");
        assert_eq!(sidebar.items.len(), 3);

        match &sidebar.items[0] {
            SidebarItem::Category {
                label,
                slug,
                children,
            } => {
                assert_eq!(label, "Getting Started");
                assert_eq!(slug, "getting-started");
                assert_eq!(children, &vec!["hello-world".to_string()]);
            }
            _ => panic!("first item should be a category"),
        }

        match &sidebar.items[2] {
            SidebarItem::Link { label, url, icon } => {
                assert_eq!(label, "Fastly Docs");
                assert_eq!(url, "https://docs.fastly.com");
                assert!(icon.is_none(), "third link should have no icon");
            }
            _ => panic!("third item should be a link"),
        }
    }

    #[test]
    fn index_add_and_remove() {
        let mut index = PostIndex { posts: vec![] };

        let post = Post {
            slug: "test-post".to_string(),
            title: "Test".to_string(),
            content: "body".to_string(),
            excerpt: "exc".to_string(),
            status: PostStatus::Published,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            updated_at: "2026-01-01T00:00:00Z".to_string(),
            tags: vec!["test".to_string()],
            featured_image: None,
            author: "Admin".to_string(),
        };

        index.add(&post);
        assert_eq!(index.posts.len(), 1);
        assert_eq!(index.posts[0].slug, "test-post");

        // Adding same slug again should deduplicate
        index.add(&post);
        assert_eq!(index.posts.len(), 1, "should deduplicate on add");

        index.remove("test-post");
        assert_eq!(index.posts.len(), 0, "should be empty after remove");
    }

    #[test]
    fn post_roundtrip_json() {
        let post = Post {
            slug: "roundtrip".to_string(),
            title: "Roundtrip Test".to_string(),
            content: "# Content\n\nWith **markdown**.".to_string(),
            excerpt: "A roundtrip test".to_string(),
            status: PostStatus::Draft,
            created_at: "2026-05-20T12:00:00Z".to_string(),
            updated_at: "2026-05-20T12:30:00Z".to_string(),
            tags: vec!["test".to_string(), "roundtrip".to_string()],
            featured_image: None,
            author: "Tester".to_string(),
        };

        let json = serde_json::to_string(&post).expect("should serialize");
        let deserialized: Post = serde_json::from_str(&json).expect("should deserialize");

        assert_eq!(deserialized.slug, post.slug);
        assert_eq!(deserialized.title, post.title);
        assert_eq!(deserialized.content, post.content);
        assert_eq!(deserialized.status, post.status);
        assert_eq!(deserialized.tags, post.tags);
        assert_eq!(deserialized.featured_image, post.featured_image);
        assert_eq!(deserialized.author, post.author);
    }
}
