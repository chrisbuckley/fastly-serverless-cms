import { KVStore } from "fastly:kv-store";

import { CSS, ADMIN_JS } from "../templates.js";
import { assetHeaders, imageHeaders } from "../cache.js";

// ---------------------------------------------------------------------------
// Static assets (CSS, JS)
// ---------------------------------------------------------------------------

export function staticFile(path: string): Response {
  let body: string;
  let contentType: string;

  switch (path) {
    case "style.css":
      body = CSS;
      contentType = "text/css; charset=utf-8";
      break;
    case "admin.js":
      body = ADMIN_JS;
      contentType = "application/javascript; charset=utf-8";
      break;
    default:
      return new Response("Asset not found\n", { status: 404 });
  }

  const headers = assetHeaders(["assets"]);
  headers.set("Content-Type", contentType);
  return new Response(body, { status: 200, headers });
}

// ---------------------------------------------------------------------------
// Image serving from KV Store
// ---------------------------------------------------------------------------

function contentTypeForImage(path: string): string {
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".webp")) return "image/webp";
  if (path.endsWith(".gif")) return "image/gif";
  if (path.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

export async function image(_req: Request, path: string): Promise<Response> {
  const store = new KVStore("images");
  const entry = await store.get(`images/${path}`);
  if (!entry) {
    return new Response("Image not found\n", { status: 404 });
  }

  const bytes = await entry.arrayBuffer();
  const ct = contentTypeForImage(path);
  const slug = path.split("/")[0] || "unknown";

  const headers = imageHeaders([`image-${slug}`]);
  headers.set("Content-Type", ct);
  return new Response(bytes, { status: 200, headers });
}
