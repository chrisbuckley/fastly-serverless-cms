import { renderPage } from "./templates.js";
import { noCacheHeaders } from "./cache.js";

export function notFound(): Response {
  return renderError(404, "404", "Page not found");
}

export function internalError(): Response {
  return renderError(500, "500", "Internal server error");
}

export function renderError(
  status: number,
  code: string,
  message: string,
): Response {
  const headers = noCacheHeaders();
  try {
    const html = renderPage("error", {
      error_code: code,
      error_message: message,
      page_title: `${code} Error`,
      meta_description: message,
      noindex: true,
      sidebar: { items: [] },
      all_tags: [],
    });
    headers.set("Content-Type", "text/html; charset=utf-8");
    return new Response(html, { status, headers });
  } catch {
    headers.set("Content-Type", "text/plain; charset=utf-8");
    return new Response(`${code} ${message}\n`, { status, headers });
  }
}
