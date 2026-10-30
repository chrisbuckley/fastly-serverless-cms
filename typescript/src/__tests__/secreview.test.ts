import { rateLimitKey, loginRateLimited } from "../security.js";
import { buildJsonLd } from "../seo.js";
import { sanitizeHtml } from "../sanitize.js";
import { readBody } from "../http.js";
import { readIndex } from "../kv.js";
import { csrfAllowed } from "../csrf.js";
import { resetMocks, seedKv } from "../__mocks__/fastly.js";

describe("rateLimitKey", () => {
  it("leaves IPv4 unchanged", () => {
    expect(rateLimitKey("203.0.113.9")).toBe("203.0.113.9");
  });
  it("truncates IPv6 to /64", () => {
    expect(rateLimitKey("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::/64");
    expect(rateLimitKey("2001:db8:1:2:ffff:ffff:ffff:ffff")).toBe("2001:db8:1:2::/64");
  });
  it("handles compressed forms and case", () => {
    expect(rateLimitKey("::1")).toBe("0:0:0:0::/64");
    expect(rateLimitKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(rateLimitKey("2001:DB8:0001:0002::5")).toBe("2001:db8:1:2::/64");
  });
  it("maps IPv4-mapped IPv6 to IPv4", () => {
    expect(rateLimitKey("::ffff:1.2.3.4")).toBe("1.2.3.4");
  });
  it("returns unparseable input as-is", () => {
    expect(rateLimitKey("garbage")).toBe("garbage");
    expect(rateLimitKey("")).toBe("");
    expect(rateLimitKey("1:2:3")).toBe("1:2:3");
  });
  it("loginRateLimited tolerates unavailable limiter", () => {
    expect(loginRateLimited("2001:db8::1")).toBe(false);
  });
});

describe("buildJsonLd escaping", () => {
  const base = {
    siteUrl: "https://s.example",
    canonicalUrl: "https://s.example/p",
    description: "d",
    createdAt: "2026-05-20T14:30:00Z",
    updatedAt: "2026-05-20T14:30:00Z",
    author: "A",
    image: "",
  };
  it("escapes <, >, & so no comment/script breakout", () => {
    for (const title of ["<!--<script>", "</script>", "a & b > c"]) {
      const out = buildJsonLd({ ...base, title });
      expect(out).not.toMatch(/[<>&]/);
      expect(JSON.parse(out).headline).toBe(title);
    }
  });
});

describe("sanitize iframe", () => {
  it("closes an unclosed allowed iframe", () => {
    const out = sanitizeHtml('<iframe src="https://www.youtube.com/embed/x"><p>rest</p>');
    expect((out.match(/<iframe/g) || []).length).toBe(1);
    expect((out.match(/<\/iframe>/g) || []).length).toBe(1);
  });
  it("does not double close", () => {
    const out = sanitizeHtml('<iframe src="https://www.youtube.com/embed/x"></iframe>');
    expect((out.match(/<\/iframe>/g) || []).length).toBe(1);
  });
  it("drops uppercase-scheme iframes (parity with Rust/Go)", () => {
    expect(sanitizeHtml('<iframe src="HTTPS://www.youtube.com/embed/x"></iframe>')).toBe("");
  });
});

describe("readBody streaming", () => {
  const mk = (
    chunks: Uint8Array[],
    headers: Record<string, string> = {},
  ): { req: Request; cancelled: () => boolean } => {
    let i = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (i < chunks.length) c.enqueue(chunks[i++]);
        else c.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const req = { headers: new Headers(headers), body } as unknown as Request;
    return { req, cancelled: () => cancelled };
  };
  it("reads a small body", async () => {
    const { req } = mk([new Uint8Array([1, 2]), new Uint8Array([3])]);
    const r = await readBody(req, 10);
    expect(r).toEqual({ ok: true, bytes: new Uint8Array([1, 2, 3]) });
  });
  it("rejects and cancels once over limit", async () => {
    const { req, cancelled } = mk([new Uint8Array(6), new Uint8Array(6), new Uint8Array(6)]);
    expect(await readBody(req, 10)).toEqual({ ok: false });
    expect(cancelled()).toBe(true);
  });
  it("rejects on Content-Length without reading", async () => {
    const { req } = mk([new Uint8Array(1)], { "content-length": "99" });
    expect(await readBody(req, 10)).toEqual({ ok: false });
  });
  it("handles null body", async () => {
    const req = { headers: new Headers(), body: null } as unknown as Request;
    expect(await readBody(req, 10)).toEqual({ ok: true, bytes: new Uint8Array(0) });
  });
});

describe("readIndex", () => {
  beforeEach(resetMocks);
  it("returns empty only when absent", async () => {
    expect(await readIndex()).toEqual({ posts: [] });
  });
  it("throws on valid JSON without posts array", async () => {
    seedKv("_index", '{"foo":1}');
    await expect(readIndex()).rejects.toThrow();
  });
  it("returns a valid index", async () => {
    seedKv("_index", '{"posts":[]}');
    expect(await readIndex()).toEqual({ posts: [] });
  });
});

describe("csrf sec-fetch-site case", () => {
  it("lowercases value", () => {
    expect(csrfAllowed(new Headers({ "sec-fetch-site": "Same-Origin" }), "https://s.example")).toBe(true);
    expect(csrfAllowed(new Headers({ "sec-fetch-site": "Cross-Site" }), "https://s.example")).toBe(false);
  });
});
