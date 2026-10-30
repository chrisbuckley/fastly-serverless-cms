import {
  createSessionToken,
  verifySessionToken,
  constantTimeEqual,
  extractCookie,
  sessionCookie,
  clearSessionCookie,
} from "../auth.js";

const key = new TextEncoder().encode("unit-test-hmac-key");
const otherKey = new TextEncoder().encode("another-key");

describe("session tokens", () => {
  it("has format v1.<expires>.<32 hex nonce>.<b64 sig>", async () => {
    const token = await createSessionToken(key, 3600, 1_000_000);
    const parts = token.split(".");
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("v1");
    expect(parts[1]).toBe("1003600");
    expect(parts[2]).toMatch(/^[0-9a-f]{32}$/);
    expect(parts[3]).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it("nonces differ per token", async () => {
    const a = await createSessionToken(key, 60);
    const b = await createSessionToken(key, 60);
    expect(a).not.toBe(b);
  });

  it("verifies a fresh token and returns nonce + expiry", async () => {
    const token = await createSessionToken(key, 3600, 1_000_000);
    const res = await verifySessionToken(key, token, 1_000_100);
    expect(res.status).toBe("ok");
    expect(res.expires).toBe(1_003_600);
    expect(res.nonce).toBe(token.split(".")[2]);
  });

  it("reports expired tokens", async () => {
    const token = await createSessionToken(key, 10, 1_000_000);
    expect((await verifySessionToken(key, token, 1_000_011)).status).toBe(
      "expired",
    );
    expect((await verifySessionToken(key, token, 1_000_010)).status).toBe("ok");
  });

  it("rejects wrong key and tampered fields", async () => {
    const token = await createSessionToken(key, 3600, 1_000_000);
    expect((await verifySessionToken(otherKey, token, 1_000_001)).status).toBe(
      "invalid",
    );
    const p = token.split(".");
    const tamperedExpiry = [p[0], "9999999999", p[2], p[3]].join(".");
    expect(
      (await verifySessionToken(key, tamperedExpiry, 1_000_001)).status,
    ).toBe("invalid");
    const tamperedNonce = [p[0], p[1], "0".repeat(32), p[3]].join(".");
    expect(
      (await verifySessionToken(key, tamperedNonce, 1_000_001)).status,
    ).toBe("invalid");
  });

  it("rejects legacy 2-part tokens and garbage", async () => {
    expect((await verifySessionToken(key, "123.abcd")).status).toBe("invalid");
    expect((await verifySessionToken(key, "")).status).toBe("invalid");
    expect((await verifySessionToken(key, "v1.x.y.z")).status).toBe("invalid");
    expect((await verifySessionToken(key, "v2.1.2.3")).status).toBe("invalid");
    expect(
      (await verifySessionToken(key, `v1.1.${"0".repeat(32)}.@@@`)).status,
    ).toBe("invalid");
    expect(
      (await verifySessionToken(key, `v1.abc.${"0".repeat(32)}.AAAA`)).status,
    ).toBe("invalid");
  });
});

describe("constantTimeEqual", () => {
  it("compares strings", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
  });
});

describe("cookies", () => {
  it("extracts a named cookie", () => {
    expect(extractCookie("a=1; session=tok.en; b=2", "session")).toBe("tok.en");
    expect(extractCookie("a=1", "session")).toBeNull();
    expect(extractCookie("", "session")).toBeNull();
    expect(extractCookie("novalue; session=x", "session")).toBe("x");
  });
  it("sets and clears the session cookie with required attributes", () => {
    expect(sessionCookie("t")).toBe(
      "session=t; HttpOnly; Secure; SameSite=Strict; Path=/admin; Max-Age=3600",
    );
    expect(clearSessionCookie()).toContain("Max-Age=0");
  });
});
