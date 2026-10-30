import {
  isValidSlug,
  validateTitle,
  validateExcerpt,
  isValidStatus,
  contentTooLarge,
  normalizeTags,
  isValidUploadFilename,
  detectImageType,
  extensionMatchesType,
  isSafeUrl,
  MAX_CONTENT_BYTES,
} from "../validation.js";

describe("isValidSlug", () => {
  it.each(["a", "hello-world", "a1", "0abc", "a-b-c", "a".repeat(100)])(
    "accepts %s",
    (s) => expect(isValidSlug(s)).toBe(true),
  );
  it.each([
    "",
    "-a",
    "a-",
    "A",
    "hello world",
    "a_b",
    "a/b",
    "a..b",
    "a".repeat(101),
    "../etc",
    "café",
    "a\n",
  ])("rejects %j", (s) => expect(isValidSlug(s)).toBe(false));
});

describe("title / excerpt / status", () => {
  it("title is trimmed and 1-200 chars", () => {
    expect(validateTitle("  hi  ")).toBe(true);
    expect(validateTitle("   ")).toBe(false);
    expect(validateTitle("")).toBe(false);
    expect(validateTitle("x".repeat(200))).toBe(true);
    expect(validateTitle("x".repeat(201))).toBe(false);
  });
  it("excerpt is at most 500 chars", () => {
    expect(validateExcerpt("")).toBe(true);
    expect(validateExcerpt("x".repeat(500))).toBe(true);
    expect(validateExcerpt("x".repeat(501))).toBe(false);
  });
  it("status is published or draft only", () => {
    expect(isValidStatus("published")).toBe(true);
    expect(isValidStatus("draft")).toBe(true);
    expect(isValidStatus("archived")).toBe(false);
    expect(isValidStatus("")).toBe(false);
  });
  it("content limit is measured in UTF-8 bytes", () => {
    expect(contentTooLarge("a".repeat(MAX_CONTENT_BYTES))).toBe(false);
    expect(contentTooLarge("a".repeat(MAX_CONTENT_BYTES + 1))).toBe(true);
    expect(contentTooLarge("€".repeat(MAX_CONTENT_BYTES / 3 + 1))).toBe(
      true,
    );
  });
});

describe("normalizeTags", () => {
  it("trims, lowercases, hyphenates spaces, dedupes", () => {
    expect(normalizeTags(" Edge Compute , fastly,FASTLY,edge-compute")).toEqual([
      "edge-compute",
      "fastly",
    ]);
  });
  it("silently drops invalid tags", () => {
    expect(normalizeTags("ok,<script>,-bad,a/b,,x".replace("x", "fine"))).toEqual(
      ["ok", "fine"],
    );
  });
  it("drops tags longer than 50 chars", () => {
    expect(normalizeTags("a".repeat(51))).toEqual([]);
    expect(normalizeTags("a".repeat(50))).toHaveLength(1);
  });
  it("caps at 20 tags", () => {
    const many = Array.from({ length: 30 }, (_, i) => `t${i}`).join(",");
    expect(normalizeTags(many)).toHaveLength(20);
  });
  it("handles empty input", () => {
    expect(normalizeTags("")).toEqual([]);
  });
});

describe("upload filenames", () => {
  it.each(["a.jpg", "my_photo-1.jpeg", "x.png", "y.webp", "z.gif"])(
    "accepts %s",
    (f) => expect(isValidUploadFilename(f)).toBe(true),
  );
  it.each([
    "A.jpg",
    ".jpg",
    "a.svg",
    "a.jpg.exe",
    "../a.jpg",
    "a/b.jpg",
    "a b.jpg",
    "-a.jpg",
    `${"a".repeat(65)}.jpg`,
    "a.JPG",
    "a.png\n",
  ])("rejects %j", (f) => expect(isValidUploadFilename(f)).toBe(false));
  it("allows 64-char stems", () => {
    expect(isValidUploadFilename(`${"a".repeat(64)}.png`)).toBe(true);
  });
});

describe("detectImageType", () => {
  const bytes = (...b: number[]) => new Uint8Array(b);
  it("detects jpeg", () => {
    expect(detectImageType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
  });
  it("detects png", () => {
    expect(
      detectImageType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0)),
    ).toBe("image/png");
  });
  it("detects gif87a and gif89a", () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(detectImageType(enc("GIF87a...."))).toBe("image/gif");
    expect(detectImageType(enc("GIF89a...."))).toBe("image/gif");
  });
  it("detects webp", () => {
    const b = new Uint8Array(16);
    b.set(new TextEncoder().encode("RIFF"), 0);
    b.set(new TextEncoder().encode("WEBP"), 8);
    expect(detectImageType(b)).toBe("image/webp");
  });
  it("rejects RIFF that is not WEBP, svg, text, and empty/short input", () => {
    const wav = new Uint8Array(16);
    wav.set(new TextEncoder().encode("RIFF"), 0);
    wav.set(new TextEncoder().encode("WAVE"), 8);
    expect(detectImageType(wav)).toBeNull();
    expect(detectImageType(new TextEncoder().encode("<svg></svg>"))).toBeNull();
    expect(detectImageType(new Uint8Array(0))).toBeNull();
    expect(detectImageType(bytes(0xff, 0xd8))).toBeNull();
  });
  it("matches extension to detected type", () => {
    expect(extensionMatchesType("a.jpg", "image/jpeg")).toBe(true);
    expect(extensionMatchesType("a.jpeg", "image/jpeg")).toBe(true);
    expect(extensionMatchesType("a.png", "image/png")).toBe(true);
    expect(extensionMatchesType("a.webp", "image/webp")).toBe(true);
    expect(extensionMatchesType("a.gif", "image/gif")).toBe(true);
    expect(extensionMatchesType("a.png", "image/jpeg")).toBe(false);
    expect(extensionMatchesType("a.gif", "image/png")).toBe(false);
  });
});

describe("isSafeUrl (rule U)", () => {
  it.each([
    "https://example.com",
    "http://example.com/x?y=1",
    "/relative",
    "/",
    "/a//b",
  ])("accepts %s", (u) => expect(isSafeUrl(u)).toBe(true));
  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html,x",
    "//evil.com",
    "ftp://x",
    "mailto:a@b.c",
    "relative/path",
    "",
    " https://x",
    "https://x\n",
    "vbscript:x",
  ])("rejects %j", (u) => expect(isSafeUrl(u)).toBe(false));
});
