import { matchRoute } from "../router.js";

describe("matchRoute", () => {
  it("routes public GETs", () => {
    expect(matchRoute("GET", "/").kind).toBe("home");
    expect(matchRoute("GET", "/post/hello")).toEqual({ kind: "post", slug: "hello" });
    expect(matchRoute("GET", "/tag/edge")).toEqual({ kind: "tag", tag: "edge" });
    expect(matchRoute("GET", "/feed.xml").kind).toBe("feed");
    expect(matchRoute("GET", "/sitemap.xml").kind).toBe("sitemap");
    expect(matchRoute("GET", "/robots.txt").kind).toBe("robots");
    expect(matchRoute("GET", "/api/edge-info").kind).toBe("edge-info");
    expect(matchRoute("GET", "/assets/style.css")).toEqual({ kind: "asset", path: "style.css" });
    expect(matchRoute("GET", "/assets/fonts/dm-sans.woff2")).toEqual({
      kind: "asset",
      path: "fonts/dm-sans.woff2",
    });
  });

  it("routes /images/* to image (handler returns 404)", () => {
    expect(matchRoute("GET", "/images/a/b.png").kind).toBe("image");
  });

  it("routes admin GETs", () => {
    expect(matchRoute("GET", "/admin").kind).toBe("admin-dashboard");
    expect(matchRoute("GET", "/admin/login").kind).toBe("admin-login");
    expect(matchRoute("GET", "/admin/posts/new").kind).toBe("admin-new-post");
    expect(matchRoute("GET", "/admin/posts/x/edit")).toEqual({ kind: "admin-edit-post", slug: "x" });
    expect(matchRoute("GET", "/admin/sidebar").kind).toBe("admin-sidebar");
  });

  it("routes admin writes", () => {
    expect(matchRoute("POST", "/admin/login").kind).toBe("admin-login-post");
    expect(matchRoute("POST", "/admin/logout").kind).toBe("admin-logout");
    expect(matchRoute("POST", "/admin/posts").kind).toBe("admin-create-post");
    expect(matchRoute("POST", "/admin/posts/x")).toEqual({ kind: "admin-update-post", slug: "x" });
    expect(matchRoute("PUT", "/admin/posts/x")).toEqual({ kind: "admin-update-post", slug: "x" });
    expect(matchRoute("DELETE", "/admin/posts/x")).toEqual({ kind: "admin-delete-post", slug: "x" });
    expect(matchRoute("POST", "/admin/images").kind).toBe("admin-upload-image");
    expect(matchRoute("PUT", "/admin/sidebar").kind).toBe("admin-update-sidebar");
    expect(matchRoute("POST", "/admin/rebuild-index").kind).toBe("admin-rebuild-index");
  });

  it("has no POST /admin/sidebar route", () => {
    expect(matchRoute("POST", "/admin/sidebar").kind).toBe("not-found");
  });

  it("does not route unknown methods or GET to rebuild-index", () => {
    expect(matchRoute("GET", "/admin/rebuild-index").kind).toBe("not-found");
    expect(matchRoute("PATCH", "/admin/posts/x").kind).toBe("not-found");
    expect(matchRoute("GET", "/nope").kind).toBe("not-found");
  });

  it("keeps empty-slug and nested paths from matching posts", () => {
    expect(matchRoute("GET", "/post/").kind).toBe("not-found");
    expect(matchRoute("GET", "/post/a/b").kind).toBe("not-found");
    expect(matchRoute("GET", "/tag/").kind).toBe("not-found");
    expect(matchRoute("POST", "/admin/posts/").kind).toBe("not-found");
    expect(matchRoute("GET", "/admin/posts//edit").kind).toBe("not-found");
  });

  it("treats HEAD like GET", () => {
    expect(matchRoute("HEAD", "/").kind).toBe("home");
  });
});
