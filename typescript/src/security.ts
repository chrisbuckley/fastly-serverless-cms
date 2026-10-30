import { SecretStore } from "fastly:secret-store";
import { RateCounter, PenaltyBox } from "fastly:edge-rate-limiter";

import { constantTimeEqual } from "./auth.js";
import { expandIpv6 } from "./privacy.js";
import { logLine, describeError } from "./logging.js";

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; " +
  "font-src 'self'; connect-src 'self'; " +
  "frame-src https://www.youtube-nocookie.com https://www.youtube.com https://player.vimeo.com; " +
  "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'";

const SECURITY_HEADERS: Array<[string, string]> = [
  ["Content-Security-Policy", CSP],
  ["X-Content-Type-Options", "nosniff"],
  ["Referrer-Policy", "strict-origin-when-cross-origin"],
  ["X-Frame-Options", "DENY"],
  ["Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()"],
  ["Cross-Origin-Opener-Policy", "same-origin"],
];

export function isAdminPath(path: string): boolean {
  return path === "/admin" || path.startsWith("/admin/");
}

export function applySecurityHeaders(resp: Response, path: string): void {
  for (const [name, value] of SECURITY_HEADERS) resp.headers.set(name, value);
  if (isAdminPath(path)) resp.headers.set("X-Robots-Tag", "noindex, nofollow");
}

export function forbidden(): Response {
  return new Response("Forbidden\n", {
    status: 403,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "private, no-store",
    },
  });
}

export async function checkOriginAuth(req: Request): Promise<Response | null> {
  let expected: string | null = null;
  try {
    const entry = await new SecretStore("secrets").get("origin_auth_token");
    expected = entry ? entry.plaintext() : null;
  } catch (e) {
    logLine("error", `origin auth secret unavailable: ${describeError(e)}`);
  }
  if (!expected) return forbidden();

  const provided = req.headers.get("edge-cms-origin-auth");
  if (provided === null || !constantTimeEqual(provided, expected)) {
    return forbidden();
  }
  return null;
}

const LOGIN_LIMIT = 5;
const LOGIN_WINDOW_SECONDS = 60;
const LOGIN_PENALTY_MINUTES = 15;

// IPv6 clients control a whole /64, so key the limiter on the prefix.
export function rateLimitKey(ip: string): string {
  const mapped = ip.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (mapped) return mapped[1];
  if (!ip.includes(":")) return ip;
  const groups = expandIpv6(ip.toLowerCase());
  if (!groups) return ip;
  const prefix = groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, ""));
  return `${prefix.join(":")}::/64`;
}

export function loginRateLimited(ip: string): boolean {
  const key = rateLimitKey(ip) || "unknown";
  try {
    const counter = new RateCounter("login_attempts");
    const penalty = new PenaltyBox("login_penalty");

    if (penalty.has(key)) return true;
    counter.increment(key, 1);
    if (counter.lookupCount(key, LOGIN_WINDOW_SECONDS) > LOGIN_LIMIT) {
      penalty.add(key, LOGIN_PENALTY_MINUTES);
      return true;
    }
    return false;
  } catch (e) {
    logLine("warn", `login rate limiter unavailable: ${describeError(e)}`);
    return false;
  }
}

export function tooManyLogins(): Response {
  return new Response("Too many login attempts\n", {
    status: 429,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "private, no-store",
      "Retry-After": "900",
    },
  });
}
