import styleCss from "../../../shared/css/style.css";
import adminCss from "../../../shared/css/admin.css";
import siteJs from "../../../shared/js/site.js";
import adminJs from "../../../shared/js/admin.js";
import fraunces from "../../../shared/fonts/fraunces.woff2";
import dmSans from "../../../shared/fonts/dm-sans.woff2";
import jetbrainsMono from "../../../shared/fonts/jetbrains-mono.woff2";

import { assetHeaders } from "../cache.js";
import { notFound } from "../error.js";

interface Asset {
  body: () => string | Uint8Array;
  type: string;
}

// woff2 files are inlined by webpack as base64 data URIs and decoded on demand.
function decodeDataUri(uri: string): Uint8Array {
  const raw = atob(uri.slice(uri.indexOf(",") + 1));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

const text = (s: string) => () => s;
const font = (uri: string) => () => decodeDataUri(uri);

const ASSETS: Record<string, Asset> = {
  "style.css": { body: text(styleCss), type: "text/css; charset=utf-8" },
  "admin.css": { body: text(adminCss), type: "text/css; charset=utf-8" },
  "site.js": { body: text(siteJs), type: "application/javascript; charset=utf-8" },
  "admin.js": { body: text(adminJs), type: "application/javascript; charset=utf-8" },
  "fonts/fraunces.woff2": { body: font(fraunces), type: "font/woff2" },
  "fonts/dm-sans.woff2": { body: font(dmSans), type: "font/woff2" },
  "fonts/jetbrains-mono.woff2": { body: font(jetbrainsMono), type: "font/woff2" },
};

export function staticFile(path: string): Response {
  const asset = Object.prototype.hasOwnProperty.call(ASSETS, path)
    ? ASSETS[path]
    : undefined;
  if (!asset) return notFound();

  const headers = assetHeaders(["assets"]);
  headers.set("Content-Type", asset.type);
  return new Response(asset.body(), { status: 200, headers });
}
