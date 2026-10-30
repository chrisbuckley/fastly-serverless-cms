import { env } from "fastly:env";

import {
  published,
  byTag,
  allTags,
  firstContentImage,
  PostIndex,
  SidebarConfig,
} from "../models.js";
import { renderPage, DEFAULT_DESCRIPTION } from "../templates.js";
import { pageHeaders, feedHeaders } from "../cache.js";
import { renderPostHtml } from "../markdown.js";
import { notFound } from "../error.js";
import { getContext } from "../context.js";
import { pageSize } from "../config.js";
import { paginate } from "../pagination.js";
import { sidebarViewItems } from "../sidebar.js";
import { absoluteUrl, buildJsonLd, percentEncode, robotsTxt, rssXml, sitemapXml } from "../seo.js";
import { isValidSlug, isValidTag } from "../validation.js";
import { htmlResponse } from "../http.js";
import { readIndex, readSidebar, readPost } from "../kv.js";

function sidebarVars(index: PostIndex, sidebar: SidebarConfig) {
  return {
    sidebar: { items: sidebarViewItems(sidebar) },
    all_tags: allTags(index),
  };
}

export function edgeInfo(_req: Request): Response {
  const pop = env("FASTLY_POP") || "local";
  return new Response(JSON.stringify({ pop }), {
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

  const page = paginate(
    published(index),
    new URL(req.url).searchParams.get("page"),
    pageSize(),
    "/",
  );
  if (!page) return notFound();

  const html = renderPage("home", {
    page_title: "Home",
    meta_description: DEFAULT_DESCRIPTION,
    posts: page.items,
    pagination: page.pagination,
    ...sidebarVars(index, sidebar),
  });

  const headers = pageHeaders(["post-index", "sidebar"]);
  return htmlResponse(html, 200, headers);
}

export async function post(_req: Request, slug: string): Promise<Response> {
  if (!isValidSlug(slug)) return notFound();

  const p = await readPost(slug);
  if (!p || p.status === "draft") return notFound();

  const index = await readIndex();
  const sidebar = await readSidebar();

  const { siteUrl } = getContext();
  const canonical = `${siteUrl}/post/${slug}`;
  const image = absoluteUrl(siteUrl, p.featured_image ?? firstContentImage(p.content));
  const description = p.excerpt || DEFAULT_DESCRIPTION;

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
    rendered_content: renderPostHtml(p.content),
    page_title: p.title,
    meta_description: description,
    canonical_url: canonical,
    og_type: "article",
    og_image: image,
    json_ld: buildJsonLd({
      siteUrl,
      canonicalUrl: canonical,
      title: p.title,
      description,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
      author: p.author,
      image,
    }),
    share_url_encoded: percentEncode(canonical),
    share_title_encoded: percentEncode(p.title),
    ...sidebarVars(index, sidebar),
  });

  const headers = pageHeaders([`post-${slug}`, "sidebar"]);
  return htmlResponse(html, 200, headers);
}

export async function tag(req: Request, tagName: string): Promise<Response> {
  if (!isValidTag(tagName)) return notFound();

  const index = await readIndex();
  const sidebar = await readSidebar();

  const page = paginate(
    byTag(index, tagName),
    new URL(req.url).searchParams.get("page"),
    pageSize(),
    `/tag/${tagName}`,
  );
  if (!page) return notFound();

  const title = `Posts tagged "${tagName}"`;
  const html = renderPage("tag", {
    tag: tagName,
    posts: page.items,
    pagination: page.pagination,
    page_title: title,
    meta_description: title,
    ...sidebarVars(index, sidebar),
  });

  const headers = pageHeaders(["post-index", "sidebar", `tag-${tagName}`]);
  return htmlResponse(html, 200, headers);
}

export async function feed(_req: Request): Promise<Response> {
  const index = await readIndex();
  const xml = rssXml(getContext().siteUrl, published(index));
  const headers = feedHeaders(["post-index"]);
  headers.set("Content-Type", "application/rss+xml; charset=utf-8");
  return new Response(xml, { status: 200, headers });
}

export async function sitemap(_req: Request): Promise<Response> {
  const index = await readIndex();
  const xml = sitemapXml(getContext().siteUrl, published(index));
  const headers = feedHeaders(["post-index"]);
  headers.set("Content-Type", "application/xml; charset=utf-8");
  return new Response(xml, { status: 200, headers });
}

export function robots(): Response {
  const headers = feedHeaders(["post-index"]);
  headers.set("Content-Type", "text/plain; charset=utf-8");
  return new Response(robotsTxt(getContext().siteUrl), { status: 200, headers });
}
