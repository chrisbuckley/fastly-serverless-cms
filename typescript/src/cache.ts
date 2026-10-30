import { SecretStore } from "fastly:secret-store";

import { assetTtl, pageTtl } from "./config.js";
import { clip, logLine, describeError } from "./logging.js";

function surrogate(ttl: number, keys: string[]): Headers {
  const headers = new Headers();
  headers.set(
    "Surrogate-Control",
    `max-age=${ttl}, stale-while-revalidate=60, stale-if-error=86400`,
  );
  if (keys.length > 0) headers.set("Surrogate-Key", keys.join(" "));
  return headers;
}

export function pageHeaders(keys: string[]): Headers {
  const headers = surrogate(pageTtl(), keys);
  headers.set("Cache-Control", `max-age=${pageTtl()}, public`);
  return headers;
}

export function feedHeaders(keys: string[]): Headers {
  const headers = surrogate(pageTtl(), keys);
  headers.set("Cache-Control", "public, max-age=300");
  return headers;
}

export function assetHeaders(keys: string[]): Headers {
  const ttl = assetTtl();
  const headers = new Headers();
  headers.set("Surrogate-Control", `max-age=${ttl}`);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  if (keys.length > 0) headers.set("Surrogate-Key", keys.join(" "));
  return headers;
}

export function noCacheHeaders(): Headers {
  const headers = new Headers();
  headers.set("Cache-Control", "private, no-store");
  return headers;
}

export async function purgeKeys(keys: string[]): Promise<boolean> {
  try {
    const secrets = new SecretStore("secrets");

    const tokenEntry = await secrets.get("fastly_api_token");
    const sidEntry = await secrets.get("purge_service_id");
    if (!tokenEntry || !sidEntry) {
      logLine("error", "purge skipped: missing purge secrets");
      return false;
    }

    const resp = await fetch(
      `https://api.fastly.com/service/${sidEntry.plaintext()}/purge`,
      {
        method: "POST",
        headers: {
          "Fastly-Key": tokenEntry.plaintext(),
          "Surrogate-Key": keys.join(" "),
          "Fastly-Soft-Purge": "1",
        },
        backend: "fastly-api",
      },
    );

    if (!resp.ok) {
      const body = clip(await resp.text());
      logLine("error", `purge failed: status=${resp.status} body=${body}`);
      return false;
    }
    return true;
  } catch (e) {
    logLine("error", `purge error: ${describeError(e)}`);
    return false;
  }
}
