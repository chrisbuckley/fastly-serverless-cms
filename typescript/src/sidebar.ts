import type { SidebarConfig, SidebarItem } from "./models.js";
import { isSafeUrl, isValidIcon, isValidSlug } from "./validation.js";

export type SidebarResult =
  | { ok: true; sidebar: SidebarConfig }
  | { ok: false; error: string };

const MAX_ITEMS = 50;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const validLabel = (v: unknown): v is string =>
  typeof v === "string" && v.length >= 1 && v.length <= 100;

function validateItem(raw: unknown): SidebarItem | string {
  if (!isRecord(raw)) return "each item must be an object";
  if (!validLabel(raw.label)) return "label must be 1-100 characters";

  if (raw.type === "category") {
    if (typeof raw.slug !== "string" || !isValidSlug(raw.slug)) {
      return "category slug is invalid";
    }
    if (
      !Array.isArray(raw.children) ||
      !raw.children.every((c) => typeof c === "string" && isValidSlug(c))
    ) {
      return "category children must be post slugs";
    }
    return {
      type: "category",
      label: raw.label,
      slug: raw.slug,
      children: raw.children as string[],
    };
  }

  if (raw.type === "link") {
    if (typeof raw.url !== "string" || !isSafeUrl(raw.url)) {
      return "link url must be http(s) or a site-relative path";
    }
    const item: SidebarItem = { type: "link", label: raw.label, url: raw.url };
    if (raw.icon !== undefined) {
      if (typeof raw.icon !== "string" || !isValidIcon(raw.icon)) {
        return "icon is invalid";
      }
      item.icon = raw.icon;
    }
    return item;
  }

  return "item type must be category or link";
}

export function validateSidebar(input: unknown): SidebarResult {
  if (!isRecord(input) || !Array.isArray(input.items)) {
    return { ok: false, error: "items array required" };
  }
  if (input.items.length > MAX_ITEMS) {
    return { ok: false, error: `at most ${MAX_ITEMS} items allowed` };
  }
  const items: SidebarItem[] = [];
  for (const raw of input.items) {
    const item = validateItem(raw);
    if (typeof item === "string") return { ok: false, error: item };
    items.push(item);
  }
  return { ok: true, sidebar: { items } };
}

export interface SidebarViewItem {
  type: string;
  label: string;
  slug?: string;
  children?: string[];
  children_csv?: string;
  url?: string;
  icon?: string;
  is_category: boolean;
  is_link: boolean;
}

export function sidebarViewItems(sidebar: SidebarConfig): SidebarViewItem[] {
  const items = isRecord(sidebar) && Array.isArray(sidebar.items) ? sidebar.items : [];
  const out: SidebarViewItem[] = [];
  for (const raw of items as unknown[]) {
    if (!isRecord(raw)) continue;
    const label = typeof raw.label === "string" ? raw.label : "";
    if (raw.type === "category") {
      const children = Array.isArray(raw.children)
        ? raw.children.filter((c): c is string => typeof c === "string")
        : [];
      out.push({
        type: "category",
        label,
        slug: typeof raw.slug === "string" ? raw.slug : "",
        children,
        children_csv: children.join(","),
        is_category: true,
        is_link: false,
      });
    } else if (raw.type === "link") {
      if (typeof raw.url !== "string" || !isSafeUrl(raw.url)) continue;
      out.push({
        type: "link",
        label,
        url: raw.url,
        icon: typeof raw.icon === "string" ? raw.icon : "",
        is_category: false,
        is_link: true,
      });
    }
  }
  return out;
}
