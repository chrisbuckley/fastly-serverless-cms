import bcrypt from "bcryptjs";

export const SESSION_TTL_SECONDS = 3600;

export interface TokenCheck {
  status: "ok" | "invalid" | "expired";
  nonce?: string;
  expires?: number;
}

const NONCE_RE = /^[0-9a-f]{32}$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

const unixNow = (): number => Math.floor(Date.now() / 1000);

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function importHmacKey(
  key: Uint8Array,
  usage: "sign" | "verify",
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

export async function createSessionToken(
  key: Uint8Array,
  ttlSeconds: number,
  now: number = unixNow(),
): Promise<string> {
  const expires = now + ttlSeconds;
  const nonce = toHex(crypto.getRandomValues(new Uint8Array(16)));
  const payload = `v1.${expires}.${nonce}`;

  const cryptoKey = await importHmacKey(key, "sign");
  const sig = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(payload),
  );
  return `${payload}.${btoa(String.fromCharCode(...new Uint8Array(sig)))}`;
}

export async function verifySessionToken(
  key: Uint8Array,
  token: string,
  now: number = unixNow(),
): Promise<TokenCheck> {
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return { status: "invalid" };

  const [, expiresStr, nonce, sigB64] = parts;
  if (!/^[0-9]{1,12}$/.test(expiresStr)) return { status: "invalid" };
  if (!NONCE_RE.test(nonce) || !B64_RE.test(sigB64)) {
    return { status: "invalid" };
  }

  let sigBytes: Uint8Array;
  try {
    const raw = atob(sigB64);
    sigBytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) sigBytes[i] = raw.charCodeAt(i);
  } catch {
    return { status: "invalid" };
  }

  const cryptoKey = await importHmacKey(key, "verify");
  const valid = await crypto.subtle.verify(
    "HMAC",
    cryptoKey,
    sigBytes,
    new TextEncoder().encode(`v1.${expiresStr}.${nonce}`),
  );
  if (!valid) return { status: "invalid" };

  const expires = parseInt(expiresStr, 10);
  if (now > expires) return { status: "expired", nonce, expires };
  return { status: "ok", nonce, expires };
}

export function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) {
    diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  }
  return diff === 0;
}

export async function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function extractCookie(header: string, name: string): string | null {
  for (const pair of header.split(";")) {
    const trimmed = pair.trim();
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key === name) return value;
  }
  return null;
}

export function sessionCookie(token: string): string {
  return `session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/admin; Max-Age=${SESSION_TTL_SECONDS}`;
}

export function clearSessionCookie(): string {
  return "session=; HttpOnly; Secure; SameSite=Strict; Path=/admin; Max-Age=0";
}
