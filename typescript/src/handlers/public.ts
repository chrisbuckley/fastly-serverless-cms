import { KVStore } from "fastly:kv-store";
import { env } from "fastly:env";
import { getGeolocationForIpAddress } from "fastly:geolocation";

import {
  Post,
  PostIndex,
  SidebarConfig,
  published,
  byTag,
  allTags,
} from "../models.js";
import { renderPage } from "../templates.js";
import { pageHeaders } from "../cache.js";
import { renderMarkdown, rewriteImages } from "../markdown.js";
import { notFound } from "../error.js";

// ---------------------------------------------------------------------------
// Shared data readers
// ---------------------------------------------------------------------------

export async function readIndex(): Promise<PostIndex> {
  const store = new KVStore("content");
  const entry = await store.get("_index");
  if (!entry) return { posts: [] };
  return JSON.parse(await entry.text()) as PostIndex;
}

export async function readSidebar(): Promise<SidebarConfig> {
  const store = new KVStore("content");
  const entry = await store.get("_sidebar");
  if (!entry) return { items: [] };
  return JSON.parse(await entry.text()) as SidebarConfig;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function geoContext(req: Request): [string, string] {
  try {
    const ip = req.headers.get("fastly-client-ip") || "127.0.0.1";
    const geo = getGeolocationForIpAddress(ip);
    const city = geo?.city || "Edge";
    const code = env("FASTLY_POP") || "CDN";
    return [city, code];
  } catch {
    return ["Edge", env("FASTLY_POP") || "CDN"];
  }
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

export function edgeInfo(_req: Request): Response {
  const pop = env("FASTLY_POP") || "local";
  const body = JSON.stringify({ pop });
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Surrogate-Control": "no-store",
    },
  });
}

export async function home(req: Request): Promise<Response> {
  const index = await readIndex();
  const sidebar = await readSidebar();
  const [popCity, popCode] = geoContext(req);

  const posts = published(index);
  const tags = allTags(index);

  const html = renderPage("home", {
    posts,
    sidebar,
    all_tags: tags,
    pop_city: popCity,
    pop_code: popCode,
  });

  const headers = pageHeaders(["post-index", "sidebar"]);
  headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(html, { status: 200, headers });
}

export async function post(req: Request, slug: string): Promise<Response> {
  const store = new KVStore("content");
  const entry = await store.get(`post:${slug}`);
  if (!entry) return notFound();

  const p: Post = JSON.parse(await entry.text());
  if (p.status === "draft") return notFound();

  const index = await readIndex();
  const sidebar = await readSidebar();
  const tags = allTags(index);
  const [popCity, popCode] = geoContext(req);

  const renderedContent = rewriteImages(renderMarkdown(p.content));
  const canonicalUrl = `/post/${slug}`;

  const html = renderPage("post", {
    slug: p.slug,
    title: p.title,
    content: p.content,
    excerpt: p.excerpt,
    created_at: p.created_at,
    updated_at: p.updated_at,
    tags: p.tags,
    featured_image: p.featured_image,
    author: p.author,
    rendered_content: renderedContent,
    canonical_url: canonicalUrl,
    page_title: p.title,
    og_title: p.title,
    og_description: p.excerpt,
    og_type: "article",
    og_image: p.featured_image,
    og_url: canonicalUrl,
    sidebar,
    all_tags: tags,
    pop_city: popCity,
    pop_code: popCode,
  });

  const surrogateKey = `post-${slug}`;
  const headers = pageHeaders([surrogateKey, "sidebar"]);
  headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(html, { status: 200, headers });
}

export async function tag(req: Request, tagName: string): Promise<Response> {
  const index = await readIndex();
  const sidebar = await readSidebar();
  const [popCity, popCode] = geoContext(req);

  const filtered = byTag(index, tagName);
  const tags = allTags(index);

  const html = renderPage("tag", {
    tag: tagName,
    posts: filtered,
    sidebar,
    all_tags: tags,
    pop_city: popCity,
    pop_code: popCode,
    page_title: `Posts tagged "${tagName}"`,
  });

  const headers = pageHeaders(["post-index", "sidebar"]);
  headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(html, { status: 200, headers });
}

export async function feed(_req: Request): Promise<Response> {
  const index = await readIndex();
  const posts = published(index);
  const items = posts.slice(0, 20);

  let xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<rss version="2.0">\n' +
    "<channel>\n" +
    "  <title>edge/cms</title>\n" +
    "  <description>A CMS running entirely on Fastly Compute</description>\n" +
    "  <link>/</link>\n";

  for (const p of items) {
    xml += "  <item>\n";
    xml += `    <title>${xmlEscape(p.title)}</title>\n`;
    xml += `    <link>/post/${p.slug}</link>\n`;
    xml += `    <guid isPermaLink="true">/post/${p.slug}</guid>\n`;
    xml += `    <description>${xmlEscape(p.excerpt)}</description>\n`;
    xml += `    <pubDate>${p.created_at}</pubDate>\n`;
    xml += "  </item>\n";
  }

  xml += "</channel>\n</rss>\n";

  const headers = pageHeaders(["post-index"]);
  headers.set("Content-Type", "application/rss+xml; charset=utf-8");
  return new Response(xml, { status: 200, headers });
}

export async function sitemap(_req: Request): Promise<Response> {
  const index = await readIndex();
  const posts = published(index);

  let xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    "  <url>\n" +
    "    <loc>/</loc>\n" +
    "  </url>\n";

  for (const p of posts) {
    xml += "  <url>\n";
    xml += `    <loc>/post/${p.slug}</loc>\n`;
    xml += `    <lastmod>${p.created_at.substring(0, 10)}</lastmod>\n`;
    xml += "  </url>\n";
  }

  xml += "</urlset>\n";

  const headers = pageHeaders(["post-index"]);
  headers.set("Content-Type", "application/xml; charset=utf-8");
  return new Response(xml, { status: 200, headers });
}

export function robots(): Response {
  const body = "User-agent: *\nAllow: /\nSitemap: /sitemap.xml\n";
  const headers = pageHeaders(["post-index"]);
  headers.set("Content-Type", "text/plain; charset=utf-8");
  return new Response(body, { status: 200, headers });
}
