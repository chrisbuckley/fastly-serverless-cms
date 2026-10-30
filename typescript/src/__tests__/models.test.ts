import {
  Post,
  addPost,
  removePost,
  rebuildIndex,
  published,
  byTag,
  allTags,
  firstContentImage,
  parseJsonSafe,
} from "../models.js";

const post = (over: Partial<Post> = {}): Post => ({
  slug: "a",
  title: "A",
  content: "body",
  excerpt: "e",
  status: "published",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
  tags: ["x"],
  featured_image: null,
  author: "Admin",
  ...over,
});

describe("index helpers", () => {
  it("addPost puts newest first, replaces by slug, carries updated_at and first content image", () => {
    const idx = { posts: [] as import("../models.js").PostMeta[] };
    addPost(idx, post({ slug: "a", content: "![x](/images/a/1.png)" }));
    addPost(idx, post({ slug: "b" }));
    addPost(idx, post({ slug: "a", title: "A2" }));
    expect(idx.posts.map((p) => p.slug)).toEqual(["a", "b"]);
    expect(idx.posts[0].title).toBe("A2");
    expect(idx.posts[0].updated_at).toBe("2026-01-02T00:00:00Z");
    expect(idx.posts[1].featured_image).toBeNull();
    addPost(idx, post({ slug: "c", content: "![x](/images/c/1.png)" }));
    expect(idx.posts[0].featured_image).toBe("/images/c/1.png");
  });

  it("removePost, published, byTag, allTags", () => {
    const idx = { posts: [] as import("../models.js").PostMeta[] };
    addPost(idx, post({ slug: "a", tags: ["z", "y"] }));
    addPost(idx, post({ slug: "b", status: "draft", tags: ["hidden"] }));
    expect(published(idx)).toHaveLength(1);
    expect(byTag(idx, "z")).toHaveLength(1);
    expect(byTag(idx, "hidden")).toHaveLength(0);
    expect(allTags(idx)).toEqual(["y", "z"]);
    removePost(idx, "a");
    expect(idx.posts.map((p) => p.slug)).toEqual(["b"]);
  });

  it("rebuildIndex sorts by created_at desc", () => {
    const idx = rebuildIndex([
      post({ slug: "old", created_at: "2025-01-01T00:00:00Z" }),
      post({ slug: "new", created_at: "2026-06-01T00:00:00Z" }),
      post({ slug: "mid", created_at: "2025-06-01T00:00:00Z" }),
    ]);
    expect(idx.posts.map((p) => p.slug)).toEqual(["new", "mid", "old"]);
  });

  it("firstContentImage edge cases", () => {
    expect(firstContentImage("none")).toBeNull();
    expect(firstContentImage("![x]")).toBeNull();
    expect(firstContentImage("![x](unterminated")).toBeNull();
    expect(firstContentImage("![x](/a.png)")).toBe("/a.png");
  });

  it("parseJsonSafe returns null on bad JSON", () => {
    expect(parseJsonSafe("{")).toBeNull();
    expect(parseJsonSafe('{"a":1}')).toEqual({ a: 1 });
  });
});
