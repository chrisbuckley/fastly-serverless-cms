import { KVStore } from "fastly:kv-store";
import { SecretStore } from "fastly:secret-store";

import { Post, PostIndex, SidebarConfig, addPost, removePost } from "../models.js";
import { render, renderPage } from "../templates.js";
import { noCacheHeaders, purgeKeys } from "../cache.js";
import {
  createSessionToken,
  verifySessionToken,
  verifyPassword,
  extractCookie,
  sessionCookie,
  clearSessionCookie,
} from "../auth.js";
import { sha256Hex, deriveSigningKey, sign, utcDatetime } from "../sigv4.js";
import { notFound } from "../error.js";
import { readIndex, readSidebar } from "./public.js";

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

async function requireAuth(req: Request): Promise<null | Response> {
  const cookie = req.headers.get("cookie") || "";
  const token = extractCookie(cookie, "session");
  if (!token) return redirectToLogin("expired");

  const secrets = new SecretStore("secrets");
  const hmacSecret = await secrets.get("hmac_key");
  if (!hmacSecret) return redirectToLogin("error");

  const key = new TextEncoder().encode(hmacSecret.plaintext());
  const result = await verifySessionToken(key, token);
  if (result !== "ok") return redirectToLogin(result);

  return null;
}

function redirectToLogin(reason: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: `/admin/login?error=${reason}` },
  });
}

// ---------------------------------------------------------------------------
// Form parsing
// ---------------------------------------------------------------------------

function parseFormBody(body: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const pair of body.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const key = decodeURIComponent(pair.slice(0, eq).replace(/\+/g, " "));
    const value = decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, " "));
    params[key] = value;
  }
  return params;
}

function parseTags(tagStr: string): string[] {
  return tagStr
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

function nowISO8601(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

// ---------------------------------------------------------------------------
// Login handlers
// ---------------------------------------------------------------------------

export async function loginPage(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const reason = url.searchParams.get("error");

  let error: string | null = null;
  if (reason) {
    switch (reason) {
      case "invalid":
        error = "Invalid password. Please try again.";
        break;
      case "expired":
        error = "Session expired. Please log in again.";
        break;
      case "error":
        error = "An error occurred. Please try again.";
        break;
      default:
        error = "Please log in.";
        break;
    }
  }

  const html = render("login", { error });

  const headers = noCacheHeaders();
  headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(html, { status: 200, headers });
}

export async function loginSubmit(req: Request): Promise<Response> {
  const body = await req.text();
  const form = parseFormBody(body);

  const password = form["password"];
  if (!password) {
    return new Response(null, {
      status: 302,
      headers: { Location: "/admin/login?error=invalid" },
    });
  }

  // Read stored password hash from Secret Store
  let secrets: SecretStore;
  try {
    secrets = new SecretStore("secrets");
  } catch {
    return new Response(null, {
      status: 302,
      headers: { Location: "/admin/login?error=error" },
    });
  }

  const hashEntry = await secrets.get("admin_password");
  if (!hashEntry) {
    return new Response(null, {
      status: 302,
      headers: { Location: "/admin/login?error=error" },
    });
  }

  const hash = hashEntry.plaintext();

  // Verify password
  const valid = await verifyPassword(password, hash);
  if (!valid) {
    return new Response(null, {
      status: 302,
      headers: { Location: "/admin/login?error=invalid" },
    });
  }

  // Create session token
  const hmacEntry = await secrets.get("hmac_key");
  if (!hmacEntry) {
    return new Response(null, {
      status: 302,
      headers: { Location: "/admin/login?error=error" },
    });
  }

  const key = new TextEncoder().encode(hmacEntry.plaintext());
  const token = await createSessionToken(key, 3600);
  const cookie = sessionCookie(token);

  return new Response(null, {
    status: 302,
    headers: new Headers([
      ["Location", "/admin"],
      ["Set-Cookie", cookie],
    ]),
  });
}

export function logout(): Response {
  const cookie = clearSessionCookie();
  return new Response(null, {
    status: 302,
    headers: new Headers([
      ["Location", "/"],
      ["Set-Cookie", cookie],
    ]),
  });
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export async function dashboard(req: Request): Promise<Response> {
  const authResp = await requireAuth(req);
  if (authResp) return authResp;

  const index = await readIndex();

  const totalPosts = index.posts.length;
  const publishedCount = index.posts.filter(
    (p) => p.status === "published",
  ).length;
  const draftCount = totalPosts - publishedCount;

  const html = renderPage("admin-dashboard", {
    is_admin: true,
    posts: index.posts,
    total_posts: totalPosts,
    published_count: publishedCount,
    draft_count: draftCount,
  });

  const headers = noCacheHeaders();
  headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(html, { status: 200, headers });
}

// ---------------------------------------------------------------------------
// Post CRUD
// ---------------------------------------------------------------------------

export async function newPost(req: Request): Promise<Response> {
  const authResp = await requireAuth(req);
  if (authResp) return authResp;

  const html = renderPage("admin-editor", {
    is_admin: true,
    editing: false,
  });

  const headers = noCacheHeaders();
  headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(html, { status: 200, headers });
}

export async function createPost(req: Request): Promise<Response> {
  const authResp = await requireAuth(req);
  if (authResp) return authResp;

  const body = await req.text();
  const form = parseFormBody(body);

  const slug = form["slug"] || "";
  const title = form["title"] || "";
  const content = form["content"] || "";
  const excerpt = form["excerpt"] || "";
  const statusStr = form["status"] || "draft";
  const tagsStr = form["tags"] || "";
  const featuredImage = form["featured_image"] || null;

  const status = statusStr === "published" ? "published" : "draft";
  const tags = parseTags(tagsStr);
  const now = nowISO8601();

  const post: Post = {
    slug,
    title,
    content,
    excerpt,
    status,
    created_at: now,
    updated_at: now,
    tags,
    featured_image: featuredImage || null,
    author: "Admin",
  };

  // Write post to KV Store
  const store = new KVStore("content");
  const postJson = JSON.stringify(post);
  await store.put(`post:${slug}`, postJson);

  // Update index
  const index = await readIndex();
  addPost(index, post);
  await store.put("_index", JSON.stringify(index));

  // Purge cache
  await purgeKeys(["post-index"]);

  return new Response(null, {
    status: 302,
    headers: { Location: "/admin" },
  });
}

export async function editPost(req: Request, slug: string): Promise<Response> {
  const authResp = await requireAuth(req);
  if (authResp) return authResp;

  const store = new KVStore("content");
  const entry = await store.get(`post:${slug}`);
  if (!entry) return notFound();

  const post: Post = JSON.parse(await entry.text());
  const tagsStr = post.tags.join(", ");

  const html = renderPage("admin-editor", {
    is_admin: true,
    editing: true,
    post: {
      slug: post.slug,
      title: post.title,
      content: post.content,
      excerpt: post.excerpt,
      status: post.status,
      tags: post.tags,
      tags_str: tagsStr,
      featured_image: post.featured_image,
      author: post.author,
      created_at: post.created_at,
      updated_at: post.updated_at,
    },
  });

  const headers = noCacheHeaders();
  headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(html, { status: 200, headers });
}

export async function updatePost(
  req: Request,
  slug: string,
): Promise<Response> {
  const authResp = await requireAuth(req);
  if (authResp) return authResp;

  const store = new KVStore("content");

  // Read existing post
  const entry = await store.get(`post:${slug}`);
  if (!entry) return notFound();
  const oldPost: Post = JSON.parse(await entry.text());

  const body = await req.text();
  const form = parseFormBody(body);

  const newSlug = form["slug"] || slug;
  const title = form["title"] || oldPost.title;
  const content = form["content"] || oldPost.content;
  const excerpt = form["excerpt"] || oldPost.excerpt;
  const statusStr = form["status"] || "draft";
  const tagsStr = form["tags"] || "";
  const featuredImage = form["featured_image"] || null;

  const status = statusStr === "published" ? "published" : "draft";
  const tags = parseTags(tagsStr);
  const now = nowISO8601();

  const updatedPost: Post = {
    slug: newSlug,
    title,
    content,
    excerpt,
    status,
    created_at: oldPost.created_at,
    updated_at: now,
    tags,
    featured_image: featuredImage || null,
    author: oldPost.author,
  };

  // Write updated post
  const postJson = JSON.stringify(updatedPost);
  await store.put(`post:${newSlug}`, postJson);

  // If slug changed, delete the old key
  if (newSlug !== slug) {
    await store.delete(`post:${slug}`);
  }

  // Update index
  const index = await readIndex();
  if (newSlug !== slug) {
    removePost(index, slug);
  }
  addPost(index, updatedPost);
  await store.put("_index", JSON.stringify(index));

  // Purge cache
  const purgeList = [`post-${slug}`, "post-index"];
  if (newSlug !== slug) {
    purgeList.push(`post-${newSlug}`);
  }
  await purgeKeys(purgeList);

  return new Response(null, {
    status: 302,
    headers: { Location: "/admin" },
  });
}

export async function deletePost(
  req: Request,
  slug: string,
): Promise<Response> {
  const authResp = await requireAuth(req);
  if (authResp) return authResp;

  const store = new KVStore("content");

  // Delete the post (ignore if not found)
  await store.delete(`post:${slug}`);

  // Remove from index
  const index = await readIndex();
  removePost(index, slug);
  await store.put("_index", JSON.stringify(index));

  // Purge cache
  await purgeKeys([`post-${slug}`, "post-index"]);

  return new Response(null, {
    status: 302,
    headers: { Location: "/admin" },
  });
}

// ---------------------------------------------------------------------------
// Image upload
// ---------------------------------------------------------------------------

async function readSecret(
  secrets: SecretStore,
  name: string,
): Promise<string> {
  const entry = await secrets.get(name);
  if (!entry) throw new Error(`missing secret: ${name}`);
  return entry.plaintext();
}

export async function uploadImage(req: Request): Promise<Response> {
  const authResp = await requireAuth(req);
  if (authResp) return authResp;

  const url = new URL(req.url);
  const slug = url.searchParams.get("slug") || "unnamed";
  const filename = url.searchParams.get("filename") || "upload.bin";
  const contentType =
    req.headers.get("Content-Type") || "application/octet-stream";

  const bodyBytes = new Uint8Array(await req.arrayBuffer());

  console.log(
    `[upload_image] slug=${slug} filename=${filename} content_type=${contentType} body_bytes=${bodyBytes.length}`,
  );

  const secrets = new SecretStore("secrets");
  const accessKeyId = await readSecret(secrets, "fos_access_key_id");
  const secretKey = await readSecret(secrets, "fos_secret_key");
  const region = await readSecret(secrets, "fos_region");
  const bucket = await readSecret(secrets, "fos_bucket");

  const host = `${region}.object.fastlystorage.app`;
  const path = `/${bucket}/${slug}/${filename}`;

  console.log(`[upload_image] PUT https://${host}${path}`);

  const [datetime, date] = utcDatetime();
  const bodyHash = await sha256Hex(bodyBytes);

  // Canonical headers must be sorted alphabetically by header name.
  const canonicalHeaders =
    `content-type:${contentType}\n` +
    `host:${host}\n` +
    `x-amz-content-sha256:${bodyHash}\n` +
    `x-amz-date:${datetime}\n`;
  const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";

  const canonicalRequest =
    `PUT\n${path}\n\n${canonicalHeaders}\n${signedHeaders}\n${bodyHash}`;

  const credentialScope = `${date}/${region}/s3/aws4_request`;
  const canonicalRequestHash = await sha256Hex(canonicalRequest);
  const stringToSign =
    `AWS4-HMAC-SHA256\n${datetime}\n${credentialScope}\n${canonicalRequestHash}`;

  const signingKey = await deriveSigningKey(secretKey, date, region, "s3");
  const signature = await sign(signingKey, stringToSign);

  const auth =
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  console.log(
    `[upload_image] signing datetime=${datetime} scope=${credentialScope} body_hash=${bodyHash}`,
  );

  const fosResp = await fetch(`https://${host}${path}`, {
    method: "PUT",
    headers: {
      Host: host,
      "Content-Type": contentType,
      "Content-Length": String(bodyBytes.length),
      "x-amz-date": datetime,
      "x-amz-content-sha256": bodyHash,
      Authorization: auth,
    },
    body: bodyBytes,
    backend: "fastly-object-storage",
  });

  console.log(`[upload_image] FOS response status=${fosResp.status}`);

  if (!fosResp.ok) {
    const errBody = await fosResp.text();
    console.error(`[upload_image] FOS error body: ${errBody}`);
    throw new Error(`FOS PUT failed: ${fosResp.status} — ${errBody}`);
  }

  const imageUrl = `/images/${slug}/${filename}`;
  console.log(`[upload_image] success url=${imageUrl}`);

  const headers = noCacheHeaders();
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify({ url: imageUrl }), {
    status: 200,
    headers,
  });
}

// ---------------------------------------------------------------------------
// Sidebar editor
// ---------------------------------------------------------------------------

export async function sidebarPage(req: Request): Promise<Response> {
  const authResp = await requireAuth(req);
  if (authResp) return authResp;

  const sidebar = await readSidebar();

  const html = renderPage("admin-sidebar", {
    is_admin: true,
    sidebar,
  });

  const headers = noCacheHeaders();
  headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(html, { status: 200, headers });
}

export async function updateSidebar(req: Request): Promise<Response> {
  const authResp = await requireAuth(req);
  if (authResp) return authResp;

  const body = await req.text();
  const sidebar: SidebarConfig = JSON.parse(body);

  const store = new KVStore("content");
  await store.put("_sidebar", JSON.stringify(sidebar));

  // Purge cache
  await purgeKeys(["sidebar"]);

  const headers = noCacheHeaders();
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers,
  });
}
