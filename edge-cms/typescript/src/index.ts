/// <reference types="@fastly/js-compute" />
import { env } from "fastly:env";
import { matchRoute } from "./router.js";
import * as pub from "./handlers/public.js";
import * as admin from "./handlers/admin.js";
import * as assets from "./handlers/assets.js";
import { notFound, internalError } from "./error.js";

addEventListener("fetch", (event: FetchEvent) =>
  event.respondWith(handleRequest(event.request))
);

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const route = matchRoute(req.method, url.pathname);

  try {
    let resp: Response;

    switch (route.kind) {
      case "edge-info":
        resp = pub.edgeInfo(req);
        break;
      case "home":
        resp = await pub.home(req);
        break;
      case "post":
        resp = await pub.post(req, route.slug);
        break;
      case "tag":
        resp = await pub.tag(req, route.tag);
        break;
      case "image":
        resp = await assets.image(req, route.path);
        break;
      case "asset":
        resp = assets.staticFile(route.path);
        break;
      case "feed":
        resp = await pub.feed(req);
        break;
      case "sitemap":
        resp = await pub.sitemap(req);
        break;
      case "robots":
        resp = pub.robots();
        break;
      case "admin-login":
        resp = await admin.loginPage(req);
        break;
      case "admin-login-post":
        resp = await admin.loginSubmit(req);
        break;
      case "admin-logout":
        resp = admin.logout();
        break;
      case "admin-dashboard":
        resp = await admin.dashboard(req);
        break;
      case "admin-new-post":
        resp = await admin.newPost(req);
        break;
      case "admin-create-post":
        resp = await admin.createPost(req);
        break;
      case "admin-edit-post":
        resp = await admin.editPost(req, route.slug);
        break;
      case "admin-update-post":
        resp = await admin.updatePost(req, route.slug);
        break;
      case "admin-delete-post":
        resp = await admin.deletePost(req, route.slug);
        break;
      case "admin-upload-image":
        resp = await admin.uploadImage(req);
        break;
      case "admin-sidebar":
        resp = await admin.sidebarPage(req);
        break;
      case "admin-update-sidebar":
        resp = await admin.updateSidebar(req);
        break;
      case "not-found":
      default:
        resp = notFound();
        break;
    }

    const version = env("FASTLY_SERVICE_VERSION") || "local";
    resp.headers.set("X-Edge-CMS-Compute-Version", version);
    return resp;
  } catch (e) {
    console.error("[main]", e);
    return internalError();
  }
}
