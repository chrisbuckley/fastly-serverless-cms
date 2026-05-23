export function hexEncode(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const input =
    typeof data === "string" ? new TextEncoder().encode(data) : data;
  const hash = await crypto.subtle.digest("SHA-256", input);
  return hexEncode(new Uint8Array(hash));
}

export async function hmacSha256Raw(
  key: Uint8Array,
  data: string,
): Promise<Uint8Array> {
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
    new TextEncoder().encode(data),
  );
  return new Uint8Array(sig);
}

export async function deriveSigningKey(
  secretKey: string,
  date: string,
  region: string,
  service: string,
): Promise<Uint8Array> {
  const kDate = await hmacSha256Raw(
    new TextEncoder().encode(`AWS4${secretKey}`),
    date,
  );
  const kRegion = await hmacSha256Raw(kDate, region);
  const kService = await hmacSha256Raw(kRegion, service);
  return hmacSha256Raw(kService, "aws4_request");
}

export async function sign(
  signingKey: Uint8Array,
  stringToSign: string,
): Promise<string> {
  const raw = await hmacSha256Raw(signingKey, stringToSign);
  return hexEncode(raw);
}

export function utcDatetime(): [string, string] {
  const now = new Date();
  const y = now.getUTCFullYear();
  const mo = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const h = String(now.getUTCHours()).padStart(2, "0");
  const m = String(now.getUTCMinutes()).padStart(2, "0");
  const s = String(now.getUTCSeconds()).padStart(2, "0");
  const datetime = `${y}${mo}${d}T${h}${m}${s}Z`;
  const date = datetime.slice(0, 8);
  return [datetime, date];
}
