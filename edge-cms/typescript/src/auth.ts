import bcrypt from "bcryptjs";

export async function createSessionToken(
  key: Uint8Array,
  ttlSeconds: number,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const expires = (now + ttlSeconds).toString();

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(expires),
  );

  return `${expires}.${btoa(String.fromCharCode(...new Uint8Array(sig)))}`;
}

export async function verifySessionToken(
  key: Uint8Array,
  token: string,
): Promise<"ok" | "invalid" | "expired"> {
  const dot = token.indexOf(".");
  if (dot === -1) return "invalid";

  const expiresStr = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);

  let sigBytes: Uint8Array;
  try {
    const raw = atob(sigB64);
    sigBytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) sigBytes[i] = raw.charCodeAt(i);
  } catch {
    return "invalid";
  }

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "HMAC",
    cryptoKey,
    sigBytes,
    new TextEncoder().encode(expiresStr),
  );
  if (!valid) return "invalid";

  const expires = parseInt(expiresStr, 10);
  if (isNaN(expires)) return "invalid";

  const now = Math.floor(Date.now() / 1000);
  if (now > expires) return "expired";

  return "ok";
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
  return `session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/admin; Max-Age=3600`;
}

export function clearSessionCookie(): string {
  return "session=; HttpOnly; Secure; SameSite=Strict; Path=/admin; Max-Age=0";
}
