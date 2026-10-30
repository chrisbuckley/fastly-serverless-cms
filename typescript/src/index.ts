/// <reference types="@fastly/js-compute" />
import { env } from "fastly:env";
import { matchRoute } from "./router.js";
import * as pub from "./handlers/public.js";
import * as admin from "./handlers/admin.js";
import * as assets from "./handlers/assets.js";
import { notFound, internalError } from "./error.js";
import { siteUrl } from "./config.js";
import { setContext } from "./context.js";
import { csrfAllowed, requiresCsrfCheck } from "./csrf.js";
import { applySecurityHeaders, checkOriginAuth, forbidden } from "./security.js";
import { describeError, logLine } from "./logging.js";

addEventListener("fetch", (event: FetchEvent) =>
  event.respondWith(handleRequest(event.request))
);

async function dispatch(req: Request, path: string): Promise<Response> {
  const route = matchRoute(req.method, path);

  switch (route.kind) {
    case "edge-info":
      return pub.edgeInfo(req);
    case "home":
      return pub.home(req);
    case "post":
      return pub.post(req, route.slug);
    case "tag":
      return pub.tag(req, route.tag);
    case "image":
      return notFound();
    case "asset":
      return assets.staticFile(route.path);
    case "feed":
      return pub.feed(req);
    case "sitemap":
      return pub.sitemap(req);
    case "robots":
      return pub.robots();
    case "admin-login":
      return admin.loginPage(req);
    case "admin-login-post":
      return admin.loginSubmit(req);
    case "admin-logout":
      return admin.logout(req);
    case "admin-dashboard":
      return admin.dashboard(req);
    case "admin-new-post":
      return admin.newPost(req);
    case "admin-create-post":
      return admin.createPost(req);
    case "admin-edit-post":
      return admin.editPost(req, route.slug);
    case "admin-update-post":
      return admin.updatePost(req, route.slug);
    case "admin-delete-post":
      return admin.deletePost(req, route.slug);
    case "admin-upload-image":
      return admin.uploadImage(req);
    case "admin-sidebar":
      return admin.sidebarPage(req);
    case "admin-update-sidebar":
      return admin.updateSidebar(req);
    case "admin-rebuild-index":
      return admin.rebuildIndex(req);
    case "not-found":
    default:
      return notFound();
  }
}

async function handleRequest(req: Request): Promise<Response> {
  const started = Date.now();
  const path = new URL(req.url).pathname;
  setContext({ method: req.method, path, siteUrl: "", clientIp: "", trusted: false });

  let resp: Response;
  try {
    const denied = await checkOriginAuth(req);
    if (denied) {
      resp = denied;
    } else {
      // Past origin auth, Fastly-Client-IP is set by our own VCL and trusted.
      setContext({
        method: req.method,
        path,
        siteUrl: siteUrl(req),
        clientIp: req.headers.get("fastly-client-ip") || "",
        trusted: true,
      });

      resp =
        requiresCsrfCheck(req.method, path) &&
        !csrfAllowed(req.headers, siteUrl(req))
          ? forbidden()
          : await dispatch(req, path);
    }
  } catch (e) {
    logLine("error", `unhandled error: ${describeError(e)}`);
    resp = internalError();
  }

  applySecurityHeaders(resp, path);
  resp.headers.set("X-Edge-CMS-Compute-Version", env("FASTLY_SERVICE_VERSION") || "dev");
  logLine("info", "request", { status: resp.status, duration_ms: Date.now() - started });
  return resp;
}
