export function requiresCsrfCheck(method: string, path: string): boolean {
  if (method === "GET" || method === "HEAD") return false;
  return path === "/admin" || path.startsWith("/admin/");
}

function originOf(value: string): string | null {
  try {
    const u = new URL(value);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

export function csrfAllowed(headers: Headers, siteUrl: string): boolean {
  const fetchSite = headers.get("sec-fetch-site")?.toLowerCase() ?? null;
  if (fetchSite !== null) {
    return fetchSite === "same-origin" || fetchSite === "none";
  }

  const origin = headers.get("origin");
  if (origin === null) return false;

  const expected = originOf(siteUrl);
  const actual = originOf(origin);
  return expected !== null && actual !== null && expected === actual;
}
