import { validateSidebar, sidebarViewItems } from "../sidebar.js";

describe("validateSidebar", () => {
  it("accepts categories and links and drops unknown fields", () => {
    const r = validateSidebar({
      items: [
        {
          type: "category",
          label: "Getting Started",
          slug: "getting-started",
          children: ["hello-world", "second"],
          evil: "x",
        },
        { type: "link", label: "GitHub", url: "https://github.com", icon: "github", onclick: "x" },
        { type: "link", label: "Home", url: "/" },
      ],
      extra: 1,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.sidebar).toEqual({
        items: [
          {
            type: "category",
            label: "Getting Started",
            slug: "getting-started",
            children: ["hello-world", "second"],
          },
          { type: "link", label: "GitHub", url: "https://github.com", icon: "github" },
          { type: "link", label: "Home", url: "/" },
        ],
      });
    }
  });

  it.each([
    ["not an object", "x"],
    ["null", null],
    ["missing items", {}],
    ["items not array", { items: {} }],
    ["unknown type", { items: [{ type: "script", label: "x" }] }],
    ["item not object", { items: ["x"] }],
    ["empty label", { items: [{ type: "link", label: "", url: "/" }] }],
    ["label too long", { items: [{ type: "link", label: "x".repeat(101), url: "/" }] }],
    ["javascript url", { items: [{ type: "link", label: "x", url: "javascript:alert(1)" }] }],
    ["protocol-relative url", { items: [{ type: "link", label: "x", url: "//evil.com" }] }],
    ["bad icon", { items: [{ type: "link", label: "x", url: "/", icon: "Bad Icon" }] }],
    ["non-string icon", { items: [{ type: "link", label: "x", url: "/", icon: 3 }] }],
    ["bad category slug", { items: [{ type: "category", label: "x", slug: "Bad", children: [] }] }],
    ["bad child slug", { items: [{ type: "category", label: "x", slug: "ok", children: ["Bad!"] }] }],
    ["children not array", { items: [{ type: "category", label: "x", slug: "ok", children: "a" }] }],
    ["label not string", { items: [{ type: "link", label: 5, url: "/" }] }],
  ])("rejects %s", (_name, input) => {
    expect(validateSidebar(input).ok).toBe(false);
  });

  it("rejects more than 50 items", () => {
    const items = Array.from({ length: 51 }, () => ({ type: "link", label: "x", url: "/" }));
    expect(validateSidebar({ items }).ok).toBe(false);
    expect(validateSidebar({ items: items.slice(0, 50) }).ok).toBe(true);
  });
});

describe("sidebarViewItems", () => {
  it("adds is_category/is_link/children_csv and omits unsafe links", () => {
    const items = sidebarViewItems({
      items: [
        { type: "category", label: "C", slug: "c", children: ["a", "b"] },
        { type: "link", label: "ok", url: "https://x.example", icon: "code" },
        { type: "link", label: "bad", url: "javascript:alert(1)" },
        { type: "link", label: "noicon", url: "/x" },
      ],
    });
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({
      type: "category",
      is_category: true,
      is_link: false,
      children: ["a", "b"],
      children_csv: "a,b",
    });
    expect(items[1]).toMatchObject({ is_link: true, is_category: false, icon: "code" });
    expect(items[2]).toMatchObject({ icon: "" });
  });

  it("tolerates malformed stored data", () => {
    expect(sidebarViewItems({ items: "nope" } as never)).toEqual([]);
    expect(sidebarViewItems(null as never)).toEqual([]);
    expect(
      sidebarViewItems({ items: [null, { type: "category", label: "c", slug: "s" }] } as never),
    ).toHaveLength(1);
  });
});
