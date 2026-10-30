import { rfc822, nowISO8601 } from "../dates.js";
import { paginate } from "../pagination.js";
import { truncateIp } from "../privacy.js";

describe("rfc822", () => {
  it("formats ISO timestamps as RFC-822 with +0000", () => {
    expect(rfc822("2026-05-20T14:30:00Z")).toBe("Wed, 20 May 2026 14:30:00 +0000");
    expect(rfc822("2006-01-02T15:04:05Z")).toBe("Mon, 02 Jan 2006 15:04:05 +0000");
  });
  it("accepts date-only input and falls back to epoch-safe output on garbage", () => {
    expect(rfc822("2026-05-20")).toBe("Wed, 20 May 2026 00:00:00 +0000");
    expect(rfc822("nonsense")).toBe("Thu, 01 Jan 1970 00:00:00 +0000");
  });
});

describe("nowISO8601", () => {
  it("has no milliseconds", () => {
    expect(nowISO8601()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });
});

describe("paginate", () => {
  const items = Array.from({ length: 25 }, (_, i) => i + 1);
  it("returns first page by default", () => {
    const r = paginate(items, null, 10, "/");
    expect(r?.items).toEqual(items.slice(0, 10));
    expect(r?.pagination).toEqual({
      page: 1,
      total_pages: 3,
      prev_url: null,
      next_url: "/?page=2",
    });
  });
  it("middle and last pages", () => {
    const mid = paginate(items, "2", 10, "/tag/x");
    expect(mid?.items).toEqual(items.slice(10, 20));
    expect(mid?.pagination.prev_url).toBe("/tag/x?page=1");
    expect(mid?.pagination.next_url).toBe("/tag/x?page=3");
    const last = paginate(items, "3", 10, "/");
    expect(last?.items).toEqual([21, 22, 23, 24, 25]);
    expect(last?.pagination.next_url).toBeNull();
  });
  it("out of range or malformed page is null (404)", () => {
    expect(paginate(items, "4", 10, "/")).toBeNull();
    expect(paginate(items, "0", 10, "/")).toBeNull();
    expect(paginate(items, "-1", 10, "/")).toBeNull();
    expect(paginate(items, "abc", 10, "/")).toBeNull();
    expect(paginate(items, "1.5", 10, "/")).toBeNull();
  });
  it("empty list has one empty page", () => {
    const r = paginate([], null, 10, "/");
    expect(r?.items).toEqual([]);
    expect(r?.pagination.total_pages).toBe(1);
    expect(paginate([], "2", 10, "/")).toBeNull();
  });
  it("guards against non-positive page size", () => {
    expect(paginate(items, null, 0, "/")?.pagination.total_pages).toBe(3);
  });
});

describe("truncateIp", () => {
  it("truncates IPv4 to /24", () => {
    expect(truncateIp("203.0.113.77")).toBe("203.0.113.0");
  });
  it("truncates IPv6 to /48", () => {
    expect(truncateIp("2001:db8:abcd:12:3:4:5:6")).toBe("2001:db8:abcd::");
    expect(truncateIp("2001:db8::1")).toBe("2001:db8::");
    expect(truncateIp("::1")).toBe("::");
    expect(truncateIp("2001:DB8:ABCD:1::1")).toBe("2001:db8:abcd::");
  });
  it("handles ipv4-mapped, empty and junk input without leaking", () => {
    expect(truncateIp("::ffff:203.0.113.9")).toBe("203.0.113.0");
    expect(truncateIp("")).toBe("");
    expect(truncateIp("not-an-ip")).toBe("");
  });
});
