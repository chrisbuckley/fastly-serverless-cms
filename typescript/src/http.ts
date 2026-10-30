import { noCacheHeaders } from "./cache.js";

export type BodyResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false };

export async function readBody(req: Request, maxBytes: number): Promise<BodyResult> {
  const declared = req.headers.get("content-length");
  if (declared !== null) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > maxBytes) return { ok: false };
  }
  const bytes = new Uint8Array(await req.arrayBuffer());
  return bytes.length > maxBytes ? { ok: false } : { ok: true, bytes };
}

export function wantsJson(req: Request): boolean {
  const type = req.headers.get("content-type") || "";
  if (type.toLowerCase().includes("application/json")) return true;
  const accept = req.headers.get("accept") || "";
  return accept.includes("application/json") && !accept.includes("text/html");
}

export function htmlResponse(html: string, status = 200, headers?: Headers): Response {
  const h = headers ?? noCacheHeaders();
  h.set("Content-Type", "text/html; charset=utf-8");
  return new Response(html, { status, headers: h });
}

export function jsonResponse(body: unknown, status = 200): Response {
  const headers = noCacheHeaders();
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { status, headers });
}

export function redirect(location: string, extra: Array<[string, string]> = []): Response {
  const headers = noCacheHeaders();
  headers.set("Location", location);
  for (const [k, v] of extra) headers.append(k, v);
  return new Response(null, { status: 302, headers });
}

export function plainError(status: number, message: string): Response {
  const headers = noCacheHeaders();
  headers.set("Content-Type", "text/plain; charset=utf-8");
  return new Response(`${message}\n`, { status, headers });
}
