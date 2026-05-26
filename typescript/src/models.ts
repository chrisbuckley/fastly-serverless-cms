export type PostStatus = "published" | "draft";

export interface Post {
  slug: string;
  title: string;
  content: string;
  excerpt: string;
  status: PostStatus;
  created_at: string;
  updated_at: string;
  tags: string[];
  featured_image: string | null;
  author: string;
}

export interface PostMeta {
  slug: string;
  title: string;
  excerpt: string;
  status: PostStatus;
  created_at: string;
  tags: string[];
  featured_image: string | null;
}

export interface PostIndex {
  posts: PostMeta[];
}

export type SidebarItem =
  | { type: "category"; label: string; slug: string; children: string[] }
  | { type: "link"; label: string; url: string; icon?: string };

export interface SidebarConfig {
  items: SidebarItem[];
}

export function firstContentImage(content: string): string | null {
  const start = content.indexOf("![");
  if (start === -1) return null;
  const paren = content.indexOf("(", start);
  if (paren === -1) return null;
  const urlStart = paren + 1;
  const urlEnd = content.indexOf(")", urlStart);
  if (urlEnd === -1) return null;
  return content.slice(urlStart, urlEnd);
}

export function published(index: PostIndex): PostMeta[] {
  return index.posts.filter((p) => p.status === "published");
}

export function byTag(index: PostIndex, tag: string): PostMeta[] {
  return index.posts.filter(
    (p) => p.status === "published" && p.tags.includes(tag)
  );
}

export function allTags(index: PostIndex): string[] {
  const seen = new Set<string>();
  for (const p of index.posts) {
    if (p.status === "published") {
      for (const t of p.tags) {
        seen.add(t);
      }
    }
  }
  return [...seen].sort();
}

export function addPost(index: PostIndex, post: Post): void {
  index.posts = index.posts.filter((p) => p.slug !== post.slug);
  const image = post.featured_image ?? firstContentImage(post.content);
  index.posts.unshift({
    slug: post.slug,
    title: post.title,
    excerpt: post.excerpt,
    status: post.status,
    created_at: post.created_at,
    tags: post.tags,
    featured_image: image,
  });
}

export function removePost(index: PostIndex, slug: string): void {
  index.posts = index.posts.filter((p) => p.slug !== slug);
}
