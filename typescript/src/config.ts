import { ConfigStore } from "fastly:config-store";

const DEFAULT_PAGE_TTL = 86400;
const DEFAULT_ASSET_TTL = 31536000;
const DEFAULT_PAGE_SIZE = 10;

export function configValue(key: string): string | null {
  try {
    return new ConfigStore("cache_config").get(key);
  } catch {
    return null;
  }
}

function configInt(key: string, fallback: number): number {
  const raw = configValue(key);
  if (raw === null) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const pageTtl = (): number => configInt("page_ttl", DEFAULT_PAGE_TTL);
export const assetTtl = (): number => configInt("asset_ttl", DEFAULT_ASSET_TTL);
export const pageSize = (): number => configInt("page_size", DEFAULT_PAGE_SIZE);

export function siteUrl(req: Request): string {
  const configured = configValue("site_url");
  if (configured && /^https?:\/\//i.test(configured)) {
    return configured.replace(/\/+$/, "");
  }
  const host = req.headers.get("host") || new URL(req.url).host;
  return `https://${host}`;
}
