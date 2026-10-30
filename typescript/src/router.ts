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
  | { kind: "admin-rebuild-index" }
  | { kind: "not-found" };

const NOT_FOUND: Route = { kind: "not-found" };

function segment(path: string, prefix: string, suffix = ""): string | null {
  if (!path.startsWith(prefix) || !path.endsWith(suffix)) return null;
  const rest = path.slice(prefix.length, path.length - suffix.length);
  return rest === "" || rest.includes("/") ? null : rest;
}

function matchGet(path: string): Route {
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

  const post = segment(path, "/post/");
  if (post) return { kind: "post", slug: post };
  const tag = segment(path, "/tag/");
  if (tag) return { kind: "tag", tag };
  if (path.startsWith("/images/")) {
    return { kind: "image", path: path.slice("/images/".length) };
  }
  if (path.startsWith("/assets/")) {
    return { kind: "asset", path: path.slice("/assets/".length) };
  }
  const edit = segment(path, "/admin/posts/", "/edit");
  if (edit) return { kind: "admin-edit-post", slug: edit };

  return NOT_FOUND;
}

export function matchRoute(method: string, path: string): Route {
  const adminPost = segment(path, "/admin/posts/");

  switch (method) {
    case "GET":
    case "HEAD":
      return matchGet(path);
    case "POST":
      switch (path) {
        case "/admin/login":
          return { kind: "admin-login-post" };
        case "/admin/logout":
          return { kind: "admin-logout" };
        case "/admin/posts":
          return { kind: "admin-create-post" };
        case "/admin/images":
          return { kind: "admin-upload-image" };
        case "/admin/rebuild-index":
          return { kind: "admin-rebuild-index" };
      }
      return adminPost ? { kind: "admin-update-post", slug: adminPost } : NOT_FOUND;
    case "PUT":
      if (path === "/admin/sidebar") return { kind: "admin-update-sidebar" };
      return adminPost ? { kind: "admin-update-post", slug: adminPost } : NOT_FOUND;
    case "DELETE":
      return adminPost ? { kind: "admin-delete-post", slug: adminPost } : NOT_FOUND;
    default:
      return NOT_FOUND;
  }
}
