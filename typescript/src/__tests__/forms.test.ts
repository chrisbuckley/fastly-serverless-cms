import { safeDecode, parseFormBody, parseQuery } from "../forms.js";

describe("safeDecode", () => {
  it("decodes percent escapes and plus", () => {
    expect(safeDecode("a%20b+c%2Fd")).toBe("a b c/d");
    expect(safeDecode("%E2%82%AC")).toBe("€");
  });
  it("never throws on malformed escapes; returns raw", () => {
    expect(() => safeDecode("100%")).not.toThrow();
    expect(safeDecode("100%")).toBe("100%");
    expect(safeDecode("%zz")).toBe("%zz");
    expect(safeDecode("%E2%82")).toBe("%E2%82");
    expect(safeDecode("%C0%AF")).toBe("%C0%AF");
  });
});

describe("parseFormBody", () => {
  it("parses simple pairs", () => {
    expect(parseFormBody("a=1&b=two+words&c=%26")).toEqual({
      a: "1",
      b: "two words",
      c: "&",
    });
  });
  it("tolerates malformed percent sequences in keys and values", () => {
    expect(parseFormBody("title=50%&content=%zz%41")).toEqual({
      title: "50%",
      content: "%zzA",
    });
    expect(parseFormBody("%=1")).toEqual({ "%": "1" });
  });
  it("skips empty and key-less segments, keeps '=' inside values", () => {
    expect(parseFormBody("&&novalue&k=a=b")).toEqual({ k: "a=b" });
    expect(parseFormBody("")).toEqual({});
  });
  it("is safe against prototype pollution keys", () => {
    const out = parseFormBody("__proto__=x&constructor=y");
    expect(Object.getPrototypeOf(out)).toBeNull();
    expect(({} as Record<string, unknown>)["x"]).toBeUndefined();
    expect(out["constructor"]).toBe("y");
  });
  it("last value wins", () => {
    expect(parseFormBody("a=1&a=2")).toEqual({ a: "2" });
  });
});

describe("parseQuery", () => {
  it("parses a query string with a leading ?", () => {
    expect(parseQuery("?page=2&x=%")).toEqual({ page: "2", x: "%" });
  });
});
