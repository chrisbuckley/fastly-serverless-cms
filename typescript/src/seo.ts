import type { PostMeta } from "./models.js";
import { rfc822 } from "./dates.js";

export function absoluteUrl(siteUrl: string, path: string | null): string {
  if (!path) return "";
  if (/^https?:\/\//i.test(path)) return path;
  return `${siteUrl}${path.startsWith("/") ? "" : "/"}${path}`;
}

export function percentEncode(s: string): string {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export interface JsonLdInput {
  siteUrl: string;
  canonicalUrl: string;
  title: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  author: string;
  image: string;
}

export function buildJsonLd(input: JsonLdInput): string {
  const doc: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: input.title,
    description: input.description,
    datePublished: input.createdAt,
    dateModified: input.updatedAt || input.createdAt,
    author: { "@type": "Person", name: input.author },
    mainEntityOfPage: input.canonicalUrl,
    publisher: { "@type": "Organization", name: "edge/cms" },
  };
  if (input.image) doc.image = input.image;
  return JSON.stringify(doc).replace(/<\//g, "<\\/");
}

export function robotsTxt(siteUrl: string): string {
  return `User-agent: *\nDisallow: /admin\nDisallow: /api/\nSitemap: ${siteUrl}/sitemap.xml\n`;
}

export function sitemapXml(siteUrl: string, posts: PostMeta[]): string {
  let xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    `  <url>\n    <loc>${xmlEscape(siteUrl)}/</loc>\n  </url>\n`;

  const tags = new Set<string>();
  for (const p of posts) for (const t of p.tags) tags.add(t);
  for (const t of [...tags].sort()) {
    xml += `  <url>\n    <loc>${xmlEscape(`${siteUrl}/tag/${t}`)}</loc>\n  </url>\n`;
  }

  for (const p of posts) {
    const lastmod = (p.updated_at || p.created_at).substring(0, 10);
    xml +=
      `  <url>\n    <loc>${xmlEscape(`${siteUrl}/post/${p.slug}`)}</loc>\n` +
      `    <lastmod>${lastmod}</lastmod>\n  </url>\n`;
  }
  return xml + "</urlset>\n";
}

export function rssXml(siteUrl: string, posts: PostMeta[]): string {
  const items = posts.slice(0, 20);
  const built = rfc822(items.length > 0 ? items[0].created_at : "");

  let xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n' +
    "<channel>\n" +
    "  <title>edge/cms</title>\n" +
    "  <description>A CMS running entirely on Fastly Compute</description>\n" +
    `  <link>${xmlEscape(siteUrl)}/</link>\n` +
    `  <atom:link href="${xmlEscape(siteUrl)}/feed.xml" rel="self" type="application/rss+xml"/>\n` +
    `  <lastBuildDate>${built}</lastBuildDate>\n`;

  for (const p of items) {
    const link = xmlEscape(`${siteUrl}/post/${p.slug}`);
    xml +=
      "  <item>\n" +
      `    <title>${xmlEscape(p.title)}</title>\n` +
      `    <link>${link}</link>\n` +
      `    <guid isPermaLink="true">${link}</guid>\n` +
      `    <description>${xmlEscape(p.excerpt)}</description>\n` +
      `    <pubDate>${rfc822(p.created_at)}</pubDate>\n` +
      "  </item>\n";
  }
  return xml + "</channel>\n</rss>\n";
}
