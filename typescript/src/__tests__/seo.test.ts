import {
  absoluteUrl,
  buildJsonLd,
  percentEncode,
  robotsTxt,
  rssXml,
  sitemapXml,
  xmlEscape,
} from "../seo.js";
import type { PostMeta } from "../models.js";

const SITE = "https://blog.example";

const meta = (over: Partial<PostMeta> = {}): PostMeta => ({
  slug: "hello",
  title: "Hello & <World>",
  excerpt: "An \"excerpt\"",
  status: "published",
  created_at: "2026-05-20T14:30:00Z",
  tags: ["fastly", "edge"],
  featured_image: null,
  ...over,
});

describe("absoluteUrl", () => {
  it("joins site_url and path, passes absolute URLs through", () => {
    expect(absoluteUrl(SITE, "/post/x")).toBe("https://blog.example/post/x");
    expect(absoluteUrl(SITE, "https://cdn.example/a.png")).toBe("https://cdn.example/a.png");
    expect(absoluteUrl(SITE, "")).toBe("");
    expect(absoluteUrl(SITE, null)).toBe("");
    expect(absoluteUrl(SITE, "images/a.png")).toBe("https://blog.example/images/a.png");
  });
});

describe("percentEncode / xmlEscape", () => {
  it("encodes reserved characters", () => {
    expect(percentEncode("a b&c=d/é")).toBe("a%20b%26c%3Dd%2F%C3%A9");
    expect(percentEncode("it's (x)!*")).toBe("it%27s%20%28x%29%21%2A");
  });
  it("escapes xml specials", () => {
    expect(xmlEscape(`<a href="x">&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&apos;&lt;/a&gt;");
  });
});

describe("buildJsonLd", () => {
  const ld = buildJsonLd({
    siteUrl: SITE,
    canonicalUrl: "https://blog.example/post/hello",
    title: 'Evil </script><script>alert(1)</script>',
    description: "d",
    createdAt: "2026-05-20T14:30:00Z",
    updatedAt: "2026-05-21T10:00:00Z",
    author: "Admin",
    image: "https://blog.example/images/a.png",
  });
  it("is valid JSON of type BlogPosting with required fields", () => {
    const parsed = JSON.parse(ld.replace(/<\\\//g, "</"));
    expect(parsed["@type"]).toBe("BlogPosting");
    expect(parsed.datePublished).toBe("2026-05-20T14:30:00Z");
    expect(parsed.dateModified).toBe("2026-05-21T10:00:00Z");
    expect(parsed.mainEntityOfPage).toBe("https://blog.example/post/hello");
    expect(parsed.publisher.name).toBe("edge/cms");
    expect(parsed.image).toBe("https://blog.example/images/a.png");
    expect(parsed.author.name).toBe("Admin");
  });
  it("never contains a literal </ sequence", () => {
    expect(ld).not.toContain("</");
    expect(ld).toContain("\\u003c/script\\u003e");
  });
  it("omits image when none and falls back dateModified to createdAt", () => {
    const parsed = JSON.parse(
      buildJsonLd({
        siteUrl: SITE,
        canonicalUrl: "c",
        title: "t",
        description: "",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "",
        author: "",
        image: "",
      }),
    );
    expect(parsed.image).toBeUndefined();
    expect(parsed.dateModified).toBe("2026-01-01T00:00:00Z");
  });
});

describe("robots / sitemap / rss", () => {
  it("robots matches contract exactly", () => {
    expect(robotsTxt(SITE)).toBe(
      "User-agent: *\nDisallow: /admin\nDisallow: /api/\nSitemap: https://blog.example/sitemap.xml\n",
    );
  });

  it("sitemap has absolute locs, home, tag pages, lastmod from updated_at", () => {
    const xml = sitemapXml(SITE, [
      meta({ updated_at: "2026-06-01T00:00:00Z" }),
      meta({ slug: "two", created_at: "2026-02-03T00:00:00Z", tags: ["edge"] }),
    ]);
    expect(xml).toContain("<loc>https://blog.example/</loc>");
    expect(xml).toContain("<loc>https://blog.example/post/hello</loc>");
    expect(xml).toContain("<lastmod>2026-06-01</lastmod>");
    expect(xml).toContain("<lastmod>2026-02-03</lastmod>");
    expect(xml).toContain("<loc>https://blog.example/tag/fastly</loc>");
    expect(xml.match(/tag\/edge</g)).toHaveLength(1);
  });

  it("rss has atom self link, RFC-822 dates, absolute links and escaped text", () => {
    const xml = rssXml(SITE, [meta()]);
    expect(xml).toContain('xmlns:atom="http://www.w3.org/2005/Atom"');
    expect(xml).toContain('<atom:link href="https://blog.example/feed.xml" rel="self" type="application/rss+xml"/>');
    expect(xml).toContain("<link>https://blog.example/post/hello</link>");
    expect(xml).toContain('<guid isPermaLink="true">https://blog.example/post/hello</guid>');
    expect(xml).toContain("<pubDate>Wed, 20 May 2026 14:30:00 +0000</pubDate>");
    expect(xml).toContain("<lastBuildDate>Wed, 20 May 2026 14:30:00 +0000</lastBuildDate>");
    expect(xml).toContain("<title>Hello &amp; &lt;World&gt;</title>");
    expect(xml).toContain("&quot;excerpt&quot;");
  });

  it("rss caps at 20 items and handles an empty feed", () => {
    const many = Array.from({ length: 30 }, (_, i) => meta({ slug: `p${i}` }));
    expect(rssXml(SITE, many).match(/<item>/g)).toHaveLength(20);
    expect(rssXml(SITE, [])).toContain("<lastBuildDate>");
  });
});
