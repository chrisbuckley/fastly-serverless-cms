import { csrfAllowed, requiresCsrfCheck } from "../csrf.js";

const SITE = "http://127.0.0.1:7676";
const h = (o: Record<string, string>) => new Headers(o);

describe("requiresCsrfCheck", () => {
  it("only applies to unsafe methods under /admin", () => {
    expect(requiresCsrfCheck("POST", "/admin/login")).toBe(true);
    expect(requiresCsrfCheck("PUT", "/admin/sidebar")).toBe(true);
    expect(requiresCsrfCheck("DELETE", "/admin/posts/x")).toBe(true);
    expect(requiresCsrfCheck("GET", "/admin")).toBe(false);
    expect(requiresCsrfCheck("HEAD", "/admin")).toBe(false);
    expect(requiresCsrfCheck("POST", "/other")).toBe(false);
    expect(requiresCsrfCheck("POST", "/administrator")).toBe(false);
  });
});

describe("csrfAllowed", () => {
  it("Sec-Fetch-Site same-origin and none allowed", () => {
    expect(csrfAllowed(h({ "sec-fetch-site": "same-origin" }), SITE)).toBe(true);
    expect(csrfAllowed(h({ "sec-fetch-site": "none" }), SITE)).toBe(true);
  });
  it("Sec-Fetch-Site same-site and cross-site rejected, even with good Origin", () => {
    expect(csrfAllowed(h({ "sec-fetch-site": "same-site" }), SITE)).toBe(false);
    expect(
      csrfAllowed(
        h({ "sec-fetch-site": "cross-site", origin: SITE }),
        SITE,
      ),
    ).toBe(false);
  });
  it("falls back to Origin matching site_url", () => {
    expect(csrfAllowed(h({ origin: SITE }), SITE)).toBe(true);
    expect(csrfAllowed(h({ origin: "http://127.0.0.1:7677" }), SITE)).toBe(false);
    expect(csrfAllowed(h({ origin: "https://127.0.0.1:7676" }), SITE)).toBe(false);
    expect(csrfAllowed(h({ origin: "http://evil.example" }), SITE)).toBe(false);
    expect(csrfAllowed(h({ origin: "null" }), SITE)).toBe(false);
    expect(csrfAllowed(h({ origin: "not a url" }), SITE)).toBe(false);
  });
  it("site_url with trailing slash or path still compares by origin", () => {
    expect(csrfAllowed(h({ origin: "https://x.example" }), "https://x.example/")).toBe(true);
  });
  it("rejects when neither header is present or site_url is invalid", () => {
    expect(csrfAllowed(h({}), SITE)).toBe(false);
    expect(csrfAllowed(h({ origin: SITE }), "garbage")).toBe(false);
  });
});
