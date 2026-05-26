export type Route =
  | { kind: "edge-info" }
  | { kind: "home" }
  | { kind: "post"; slug: string }
  | { kind: "tag"; tag: string }
  | { kind: "image"; path: string }
  | { kind: "asset"; path: string }
  | { kind: "feed" }
  | { kind: "sitemap" }
  | { kind: "robots" }
  | { kind: "admin-login" }
  | { kind: "admin-login-post" }
  | { kind: "admin-logout" }
  | { kind: "admin-dashboard" }
  | { kind: "admin-new-post" }
  | { kind: "admin-create-post" }
  | { kind: "admin-edit-post"; slug: string }
  | { kind: "admin-update-post"; slug: string }
  | { kind: "admin-delete-post"; slug: string }
  | { kind: "admin-upload-image" }
  | { kind: "admin-sidebar" }
  | { kind: "admin-update-sidebar" }
  | { kind: "not-found" };

export function matchRoute(method: string, path: string): Route {
  if (method === "GET") {
    switch (path) {
      case "/":
        return { kind: "home" };
      case "/api/edge-info":
        return { kind: "edge-info" };
      case "/feed.xml":
        return { kind: "feed" };
      case "/sitemap.xml":
        return { kind: "sitemap" };
      case "/robots.txt":
        return { kind: "robots" };
      case "/admin/login":
        return { kind: "admin-login" };
      case "/admin":
        return { kind: "admin-dashboard" };
      case "/admin/posts/new":
        return { kind: "admin-new-post" };
      case "/admin/sidebar":
        return { kind: "admin-sidebar" };
    }

    if (path.startsWith("/post/"))
      return { kind: "post", slug: path.slice("/post/".length) };
    if (path.startsWith("/tag/"))
      return { kind: "tag", tag: path.slice("/tag/".length) };
    if (path.startsWith("/images/"))
      return { kind: "image", path: path.slice("/images/".length) };
    if (path.startsWith("/assets/"))
      return { kind: "asset", path: path.slice("/assets/".length) };
    if (path.startsWith("/admin/posts/") && path.endsWith("/edit")) {
      const slug = path.slice("/admin/posts/".length, -"/edit".length);
      return { kind: "admin-edit-post", slug };
    }

    return { kind: "not-found" };
  }

  if (method === "POST") {
    switch (path) {
      case "/admin/login":
        return { kind: "admin-login-post" };
      case "/admin/logout":
        return { kind: "admin-logout" };
      case "/admin/posts":
        return { kind: "admin-create-post" };
      case "/admin/images":
        return { kind: "admin-upload-image" };
      case "/admin/sidebar":
        return { kind: "admin-update-sidebar" };
    }

    if (path.startsWith("/admin/posts/"))
      return { kind: "admin-update-post", slug: path.slice("/admin/posts/".length) };
  }

  if (method === "PUT") {
    if (path === "/admin/sidebar")
      return { kind: "admin-update-sidebar" };
    if (path.startsWith("/admin/posts/"))
      return { kind: "admin-update-post", slug: path.slice("/admin/posts/".length) };
  }

  if (method === "DELETE") {
    if (path.startsWith("/admin/posts/"))
      return { kind: "admin-delete-post", slug: path.slice("/admin/posts/".length) };
  }

  return { kind: "not-found" };
}
