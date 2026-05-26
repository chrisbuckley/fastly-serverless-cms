import { renderPage } from "./templates.js";

export function notFound(): Response {
  return renderError(404, "404", "Page not found");
}

export function internalError(): Response {
  return renderError(500, "500", "Internal server error");
}

function renderError(
  status: number,
  code: string,
  message: string,
): Response {
  try {
    const html = renderPage("error", {
      error_code: code,
      error_message: message,
      page_title: `${code} Error`,
      sidebar: { items: [] },
      pop_city: "Edge",
      pop_code: "CDN",
    });
    return new Response(html, {
      status,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  } catch {
    return new Response(`${code} ${message}\n`, {
      status,
      headers: { "Content-Type": "text/plain" },
    });
  }
}
