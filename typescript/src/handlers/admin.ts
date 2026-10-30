import { SecretStore } from "fastly:secret-store";

import { Post, PostIndex, addPost, removePost } from "../models.js";
import { render, renderPage } from "../templates.js";
import { purgeKeys } from "../cache.js";
import {
  SESSION_TTL_SECONDS,
  createSessionToken,
  verifySessionToken,
  verifyPassword,
  extractCookie,
  sessionCookie,
  clearSessionCookie,
} from "../auth.js";
import { sha256Hex, deriveSigningKey, sign, utcDatetime } from "../sigv4.js";
import { notFound } from "../error.js";
import { nowISO8601 } from "../dates.js";
import { parseFormBody, parseQuery } from "../forms.js";
import { validateSidebar } from "../sidebar.js";
import { getContext } from "../context.js";
import { loginRateLimited, tooManyLogins } from "../security.js";
import { clip, logLine } from "../logging.js";
import {
  BodyResult,
  htmlResponse,
  jsonResponse,
  plainError,
  readBody,
  redirect,
  wantsJson,
} from "../http.js";
import {
  MAX_CONTENT_BYTES,
  MAX_FORM_BYTES,
  MAX_SIDEBAR_BYTES,
  MAX_UPLOAD_BYTES,
  contentTooLarge,
  detectImageType,
  extensionMatchesType,
  isSafeUrl,
  isValidSlug,
  isValidStatus,
  isValidUploadFilename,
  normalizeTags,
  validateExcerpt,
  validateTitle,
} from "../validation.js";
import {
  deletePostKey,
  isSessionRevoked,
  postExists,
  readIndex,
  readPost,
  readSidebar,
  rebuildIndexFromPosts,
  revokeSession,
  writeIndex,
  writePost,
  writeRevision,
  writeSidebar,
  writeTrash,
} from "../kv.js";
import { sidebarViewItems } from "../sidebar.js";

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

function redirectToLogin(reason: string): Response {
  return redirect(`/admin/login?error=${reason}`);
}

async function hmacKey(): Promise<Uint8Array | null> {
  const entry = await new SecretStore("secrets").get("hmac_key");
  return entry ? new TextEncoder().encode(entry.plaintext()) : null;
}

async function requireAuth(req: Request): Promise<null | Response> {
  const token = extractCookie(req.headers.get("cookie") || "", "session");
  if (!token) return redirectToLogin("expired");

  const key = await hmacKey();
  if (!key) return redirectToLogin("error");

  const result = await verifySessionToken(key, token);
  if (result.status !== "ok" || !result.nonce) {
    return redirectToLogin(result.status);
  }
  if (await isSessionRevoked(result.nonce)) return redirectToLogin("expired");

  return null;
}

function adminVars(title: string): Record<string, unknown> {
  return {
    is_admin: true,
    noindex: true,
    page_title: title,
    meta_description: "edge/cms administration",
  };
}

// ---------------------------------------------------------------------------
// Request field parsing
// ---------------------------------------------------------------------------

type Fields = Record<string, string | undefined>;
type FieldsResult = { ok: true; fields: Fields } | { ok: false; status: number; message: string };

function bodyText(body: BodyResult): string | null {
  return body.ok ? new TextDecoder().decode(body.bytes) : null;
}

function jsonFields(text: string): Fields | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const out: Fields = Object.create(null);
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v === "string") out[k] = v;
    else if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
      out[k] = v.join(",");
    }
  }
  return out;
}

async function readFields(req: Request): Promise<FieldsResult> {
  const text = bodyText(await readBody(req, MAX_FORM_BYTES));
  if (text === null) return { ok: false, status: 413, message: "Request body too large" };

  const isJson = (req.headers.get("content-type") || "").toLowerCase().includes("application/json");
  if (!isJson) return { ok: true, fields: parseFormBody(text) };

  const fields = jsonFields(text);
  return fields
    ? { ok: true, fields }
    : { ok: false, status: 400, message: "Invalid JSON body" };
}

function purgeSet(slugs: string[], tags: string[]): string[] {
  const keys = new Set<string>(["post-index", "sidebar"]);
  for (const s of slugs) keys.add(`post-${s}`);
  for (const t of tags) keys.add(`tag-${t}`);
  return [...keys];
}

function adminRedirect(purgeOk: boolean): Response {
  return redirect(purgeOk ? "/admin" : "/admin?purge=failed");
}

// ---------------------------------------------------------------------------
// Login handlers
// ---------------------------------------------------------------------------

const LOGIN_ERRORS: Record<string, string> = {
  invalid: "Invalid password. Please try again.",
  expired: "Session expired. Please log in again.",
  error: "An error occurred. Please try again.",
};

export async function loginPage(req: Request): Promise<Response> {
  const reason = new URL(req.url).searchParams.get("error");
  const error = reason ? (LOGIN_ERRORS[reason] ?? "Please log in.") : null;

  const html = render("login", {
    ...adminVars("Login"),
    is_admin: false,
    meta_description: "Sign in to edge/cms",
    error,
  });
  return htmlResponse(html);
}

export async function loginSubmit(req: Request): Promise<Response> {
  if (loginRateLimited(getContext().clientIp)) return tooManyLogins();

  const text = bodyText(await readBody(req, MAX_FORM_BYTES));
  if (text === null) return plainError(413, "Request body too large");
  const password = parseFormBody(text)["password"];
  if (!password) return redirectToLogin("invalid");

  const secrets = new SecretStore("secrets");
  const hashEntry = await secrets.get("admin_password");
  const hmacEntry = await secrets.get("hmac_key");
  if (!hashEntry || !hmacEntry) return redirectToLogin("error");

  if (!(await verifyPassword(password, hashEntry.plaintext()))) {
    logLine("warn", "login failed", { status: 302 });
    return redirectToLogin("invalid");
  }

  const key = new TextEncoder().encode(hmacEntry.plaintext());
  const token = await createSessionToken(key, SESSION_TTL_SECONDS);
  return redirect("/admin", [["Set-Cookie", sessionCookie(token)]]);
}

export async function logout(req: Request): Promise<Response> {
  const token = extractCookie(req.headers.get("cookie") || "", "session");
  const key = token ? await hmacKey() : null;
  if (token && key) {
    const result = await verifySessionToken(key, token);
    if (result.status === "ok" && result.nonce && result.expires) {
      await revokeSession(result.nonce, result.expires, Math.floor(Date.now() / 1000));
    }
  }
  return redirect("/", [["Set-Cookie", clearSessionCookie()]]);
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export async function dashboard(req: Request): Promise<Response> {
  const authResp = await requireAuth(req);
  if (authResp) return authResp;

  const index = await readIndex();
  const total = index.posts.length;
  const publishedCount = index.posts.filter((p) => p.status === "published").length;

  const html = renderPage("admin-dashboard", {
    ...adminVars("Dashboard"),
    posts: index.posts,
    total_posts: total,
    published_count: publishedCount,
    draft_count: total - publishedCount,
    purge_failed: new URL(req.url).searchParams.get("purge") === "failed",
  });
  return htmlResponse(html);
}

// ---------------------------------------------------------------------------
// Post CRUD
// ---------------------------------------------------------------------------

interface EditorPost {
  slug: string;
  title: string;
  content: string;
  excerpt: string;
  status: string;
  tags_str: string;
  featured_image: string;
}

function editorPage(
  isNew: boolean,
  post: EditorPost,
  error: string | null,
  status = 200,
): Response {
  const html = renderPage("admin-editor", {
    ...adminVars(isNew ? "New post" : "Edit post"),
    is_new: isNew,
    editing: !isNew,
    error,
    post,
  });
  return htmlResponse(html, status);
}

function editorFromFields(fields: Fields, fallbackSlug: string): EditorPost {
  return {
    slug: fields.slug ?? fallbackSlug,
    title: fields.title ?? "",
    content: fields.content ?? "",
    excerpt: fields.excerpt ?? "",
    status: fields.status ?? "draft",
    tags_str: fields.tags ?? "",
    featured_image: fields.featured_image ?? "",
  };
}

function editorFromPost(post: Post): EditorPost {
  return {
    slug: post.slug,
    title: post.title,
    content: post.content,
    excerpt: post.excerpt,
    status: post.status,
    tags_str: post.tags.join(", "),
    featured_image: post.featured_image ?? "",
  };
}

function failure(
  req: Request,
  status: number,
  message: string,
  isNew: boolean,
  editor: EditorPost,
): Response {
  return wantsJson(req)
    ? jsonResponse({ error: message }, status)
    : editorPage(isNew, editor, message, status);
}

function cleanFeaturedImage(raw: string | undefined): string | null {
  const value = (raw ?? "").trim();
  return value !== "" && value.length <= 500 && isSafeUrl(value) ? value : null;
}

interface Validated {
  title: string;
  content: string;
  excerpt: string;
}

function validateText(
  fields: Fields,
  existing: Post | null,
): { ok: true; value: Validated } | { ok: false; status: number; message: string } {
  const title = (fields.title ? fields.title : existing?.title ?? "").trim();
  const content = fields.content ? fields.content : existing?.content ?? "";
  const excerpt = fields.excerpt ?? existing?.excerpt ?? "";

  if (!validateTitle(title)) {
    return { ok: false, status: 400, message: "Title must be 1-200 characters" };
  }
  if (!validateExcerpt(excerpt)) {
    return { ok: false, status: 400, message: "Excerpt must be at most 500 characters" };
  }
  if (contentTooLarge(content)) {
    return {
      ok: false,
      status: 413,
      message: `Content must be at most ${MAX_CONTENT_BYTES / 1024} KiB`,
    };
  }
  return { ok: true, value: { title, content, excerpt } };
}

export async function newPost(req: Request): Promise<Response> {
  const authResp = await requireAuth(req);
  if (authResp) return authResp;

  return editorPage(
    true,
    { slug: "", title: "", content: "", excerpt: "", status: "draft", tags_str: "", featured_image: "" },
    null,
  );
}

export async function createPost(req: Request): Promise<Response> {
  const authResp = await requireAuth(req);
  if (authResp) return authResp;

  const parsed = await readFields(req);
  if (!parsed.ok) {
    return wantsJson(req)
      ? jsonResponse({ error: parsed.message }, parsed.status)
      : plainError(parsed.status, parsed.message);
  }
  const fields = parsed.fields;
  const editor = editorFromFields(fields, "");
  const fail = (status: number, message: string) => failure(req, status, message, true, editor);

  const slug = (fields.slug ?? "").trim();
  if (!isValidSlug(slug)) return fail(400, "Slug must be lowercase letters, numbers and hyphens (max 100)");

  const text = validateText(fields, null);
  if (!text.ok) return fail(text.status, text.message);

  const status = fields.status ?? "draft";
  if (!isValidStatus(status)) return fail(400, "Status must be published or draft");

  if (await postExists(slug)) return fail(409, "A post with this slug already exists");

  const now = nowISO8601();
  const post: Post = {
    slug,
    ...text.value,
    status,
    created_at: now,
    updated_at: now,
    tags: normalizeTags(fields.tags ?? ""),
    featured_image: cleanFeaturedImage(fields.featured_image),
    author: "Admin",
  };

  await writePost(post);
  const index = await readIndex();
  addPost(index, post);
  await writeIndex(index);

  const purged = await purgeKeys(purgeSet([slug], post.tags));
  return adminRedirect(purged);
}

export async function editPost(req: Request, slug: string): Promise<Response> {
  const authResp = await requireAuth(req);
  if (authResp) return authResp;

  if (!isValidSlug(slug)) return notFound();
  const post = await readPost(slug);
  if (!post) return notFound();

  return editorPage(false, editorFromPost(post), null);
}

export async function updatePost(req: Request, slug: string): Promise<Response> {
  const authResp = await requireAuth(req);
  if (authResp) return authResp;

  if (!isValidSlug(slug)) return notFound();
  const old = await readPost(slug);
  if (!old) return notFound();

  const parsed = await readFields(req);
  if (!parsed.ok) {
    return wantsJson(req)
      ? jsonResponse({ error: parsed.message }, parsed.status)
      : plainError(parsed.status, parsed.message);
  }
  const fields = parsed.fields;
  const editor = { ...editorFromPost(old), ...definedFields(fields) };
  const fail = (status: number, message: string) => failure(req, status, message, false, editor);

  const newSlug = fields.slug ? fields.slug.trim() : slug;
  if (!isValidSlug(newSlug)) return fail(400, "Slug must be lowercase letters, numbers and hyphens (max 100)");

  const text = validateText(fields, old);
  if (!text.ok) return fail(text.status, text.message);

  const status = fields.status ?? old.status;
  if (!isValidStatus(status)) return fail(400, "Status must be published or draft");

  const renamed = newSlug !== slug;
  if (renamed && (await postExists(newSlug))) {
    return fail(409, "A post with the new slug already exists");
  }

  const updated: Post = {
    slug: newSlug,
    ...text.value,
    status,
    created_at: old.created_at,
    updated_at: nowISO8601(),
    tags: fields.tags === undefined ? old.tags : normalizeTags(fields.tags),
    featured_image:
      fields.featured_image === undefined
        ? old.featured_image
        : cleanFeaturedImage(fields.featured_image),
    author: old.author,
  };

  await writeRevision(old, Math.floor(Date.now() / 1000));
  await writePost(updated);

  const index = await readIndex();
  if (renamed) removePost(index, slug);
  addPost(index, updated);
  await writeIndex(index);

  if (renamed) await deletePostKey(slug);

  const purged = await purgeKeys(
    purgeSet([slug, newSlug], [...old.tags, ...updated.tags]),
  );
  return adminRedirect(purged);
}

function definedFields(fields: Fields): Partial<EditorPost> {
  const out: Partial<EditorPost> = {};
  if (fields.slug !== undefined) out.slug = fields.slug;
  if (fields.title !== undefined) out.title = fields.title;
  if (fields.content !== undefined) out.content = fields.content;
  if (fields.excerpt !== undefined) out.excerpt = fields.excerpt;
  if (fields.status !== undefined) out.status = fields.status;
  if (fields.tags !== undefined) out.tags_str = fields.tags;
  if (fields.featured_image !== undefined) out.featured_image = fields.featured_image;
  return out;
}

export async function deletePost(req: Request, slug: string): Promise<Response> {
  const authResp = await requireAuth(req);
  if (authResp) return authResp;

  if (!isValidSlug(slug)) return notFound();
  const existing = await readPost(slug);
  if (existing) {
    await writeTrash(existing);
    await deletePostKey(slug);
  }

  const index = await readIndex();
  removePost(index, slug);
  await writeIndex(index);

  const purged = await purgeKeys(purgeSet([slug], existing?.tags ?? []));
  return adminRedirect(purged);
}

export async function rebuildIndex(req: Request): Promise<Response> {
  const authResp = await requireAuth(req);
  if (authResp) return authResp;

  const index: PostIndex = await rebuildIndexFromPosts();
  await writeIndex(index);

  const purged = await purgeKeys(["post-index"]);
  return adminRedirect(purged);
}

// ---------------------------------------------------------------------------
// Image upload
// ---------------------------------------------------------------------------

async function readSecret(secrets: SecretStore, name: string): Promise<string> {
  const entry = await secrets.get(name);
  if (!entry) throw new Error(`missing secret: ${name}`);
  return entry.plaintext();
}

export async function uploadImage(req: Request): Promise<Response> {
  const authResp = await requireAuth(req);
  if (authResp) return authResp;

  const query = parseQuery(new URL(req.url).search);
  const slug = query["slug"] ?? "";
  const filename = query["filename"] ?? "";
  if (!isValidSlug(slug)) return jsonResponse({ error: "Invalid slug" }, 400);
  if (!isValidUploadFilename(filename)) {
    return jsonResponse({ error: "Invalid filename" }, 400);
  }

  const body = await readBody(req, MAX_UPLOAD_BYTES);
  if (!body.ok) return jsonResponse({ error: "Upload too large" }, 413);

  const contentType = detectImageType(body.bytes);
  if (!contentType || !extensionMatchesType(filename, contentType)) {
    return jsonResponse({ error: "Unsupported or mismatched image type" }, 415);
  }
  const bodyBytes = body.bytes;

  const secrets = new SecretStore("secrets");
  const accessKeyId = await readSecret(secrets, "fos_access_key_id");
  const secretKey = await readSecret(secrets, "fos_secret_key");
  const region = await readSecret(secrets, "fos_region");
  const bucket = await readSecret(secrets, "fos_bucket");

  const host = `${region}.object.fastlystorage.app`;
  const path = `/${bucket}/${slug}/${filename}`;

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

  if (!fosResp.ok) {
    const errBody = clip(await fosResp.text());
    logLine("error", `object storage PUT failed: status=${fosResp.status} body=${errBody}`);
    throw new Error(`Object Storage PUT failed: ${fosResp.status}`);
  }

  const purged = await purgeKeys([`image-${slug}`]);
  const result: Record<string, unknown> = { url: `/images/${slug}/${filename}` };
  if (!purged) result.purge_failed = true;
  return jsonResponse(result);
}

// ---------------------------------------------------------------------------
// Sidebar editor
// ---------------------------------------------------------------------------

export async function sidebarPage(req: Request): Promise<Response> {
  const authResp = await requireAuth(req);
  if (authResp) return authResp;

  const sidebar = await readSidebar();
  const html = renderPage("admin-sidebar", {
    ...adminVars("Sidebar"),
    sidebar: { items: sidebarViewItems(sidebar) },
  });
  return htmlResponse(html);
}

export async function updateSidebar(req: Request): Promise<Response> {
  const authResp = await requireAuth(req);
  if (authResp) return authResp;

  const body = await readBody(req, MAX_FORM_BYTES);
  if (!body.ok) return jsonResponse({ error: "Request body too large" }, 413);
  if (body.bytes.length > MAX_SIDEBAR_BYTES) {
    return jsonResponse({ error: "Sidebar JSON must be at most 64 KiB" }, 400);
  }

  let input: unknown;
  try {
    input = JSON.parse(new TextDecoder().decode(body.bytes));
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  const result = validateSidebar(input);
  if (!result.ok) return jsonResponse({ error: result.error }, 400);

  await writeSidebar(result.sidebar);
  const purged = await purgeKeys(["sidebar", "post-index"]);
  return jsonResponse(purged ? { ok: true } : { ok: true, purge_failed: true });
}
