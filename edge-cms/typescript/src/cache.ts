import { ConfigStore } from "fastly:config-store";
import { SecretStore } from "fastly:secret-store";

export function ttlFromConfig(key: string): number {
  const store = new ConfigStore("cache_config");
  const val = store.get(key);
  if (val === null) return 3600;
  const parsed = parseInt(val, 10);
  return isNaN(parsed) ? 3600 : parsed;
}

function cacheHeaders(ttlKey: string, keys: string[]): Headers {
  const ttl = ttlFromConfig(ttlKey);
  const headers = new Headers();
  headers.set("Surrogate-Control", `max-age=${ttl}`);
  headers.set("Cache-Control", `max-age=${ttl}, public`);
  if (keys.length > 0) {
    headers.set("Surrogate-Key", keys.join(" "));
  }
  return headers;
}

export function pageHeaders(keys: string[]): Headers {
  return cacheHeaders("page_ttl", keys);
}

export function assetHeaders(keys: string[]): Headers {
  return cacheHeaders("asset_ttl", keys);
}

export function imageHeaders(keys: string[]): Headers {
  return cacheHeaders("image_ttl", keys);
}

export function noCacheHeaders(): Headers {
  const headers = new Headers();
  headers.set("Cache-Control", "private, no-store");
  return headers;
}

export async function purgeKeys(keys: string[]): Promise<void> {
  try {
    const secrets = new SecretStore("secrets");

    const tokenEntry = await secrets.get("fastly_api_token");
    if (!tokenEntry) {
      console.error("purge error: missing secret: fastly_api_token");
      return;
    }
    const apiToken = tokenEntry.plaintext();

    const sidEntry = await secrets.get("purge_service_id");
    if (!sidEntry) {
      console.error("purge error: missing secret: purge_service_id");
      return;
    }
    const serviceId = sidEntry.plaintext();

    const url = `https://api.fastly.com/service/${serviceId}/purge`;

    await fetch(url, {
      method: "POST",
      headers: {
        "Fastly-Key": apiToken,
        "Surrogate-Key": keys.join(" "),
        "Fastly-Soft-Purge": "1",
      },
      backend: "fastly-api",
    });
  } catch (e) {
    console.error(`purge error: ${e}`);
  }
}
