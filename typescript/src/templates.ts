import Handlebars from "handlebars";
import { env } from "fastly:env";

import layoutHbs from "../../shared/templates/layout.hbs";
import homeHbs from "../../shared/templates/home.hbs";
import postHbs from "../../shared/templates/post.hbs";
import tagHbs from "../../shared/templates/tag.hbs";
import errorHbs from "../../shared/templates/error.hbs";
import loginHbs from "../../shared/templates/login.hbs";
import adminDashboardHbs from "../../shared/templates/admin-dashboard.hbs";
import adminEditorHbs from "../../shared/templates/admin-editor.hbs";
import adminSidebarHbs from "../../shared/templates/admin-sidebar.hbs";
import sidebarPartialHbs from "../../shared/templates/_sidebar.hbs";

import { getContext } from "./context.js";

export const DEFAULT_DESCRIPTION =
  "A CMS running entirely on Fastly's edge platform";

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

Handlebars.registerHelper("format_date", (dateStr: unknown) => {
  if (typeof dateStr !== "string" || dateStr.length < 10) {
    return typeof dateStr === "string" ? dateStr : "";
  }
  const parts = dateStr.substring(0, 10).split("-");
  if (parts.length !== 3) {
    return dateStr;
  }
  const monthIdx = parseInt(parts[1], 10) - 1;
  const month = MONTH_NAMES[monthIdx] ?? "???";
  const day = parseInt(parts[2], 10);
  return `${month} ${day}, ${parts[0]}`;
});

Handlebars.registerHelper("reading_time", (content: unknown) => {
  if (typeof content !== "string") return "1";
  const words = content.split(/\s+/).filter((w) => w.length > 0).length;
  return String(Math.max(Math.floor(words / 200), 1));
});

Handlebars.registerHelper("eq", (a: unknown, b: unknown) => a === b);

Handlebars.registerPartial("_sidebar", sidebarPartialHbs);

const TEMPLATES: Record<string, string> = {
  layout: layoutHbs,
  home: homeHbs,
  post: postHbs,
  tag: tagHbs,
  error: errorHbs,
  login: loginHbs,
  "admin-dashboard": adminDashboardHbs,
  "admin-editor": adminEditorHbs,
  "admin-sidebar": adminSidebarHbs,
};

const compiled: Record<string, HandlebarsTemplateDelegate> = {};

function getTemplate(name: string): HandlebarsTemplateDelegate {
  if (!compiled[name]) {
    const source = TEMPLATES[name];
    if (!source) {
      throw new Error(`Unknown template: ${name}`);
    }
    compiled[name] = Handlebars.compile(source);
  }
  return compiled[name];
}

export function assetVersion(): string {
  return env("FASTLY_SERVICE_VERSION") || "dev";
}

function baseVars(): Record<string, unknown> {
  const ctx = getContext();
  return {
    site_url: ctx.siteUrl,
    page_title: "edge/cms",
    meta_description: DEFAULT_DESCRIPTION,
    canonical_url: `${ctx.siteUrl}${ctx.path}`,
    og_type: "website",
    og_image: "",
    noindex: false,
    asset_version: assetVersion(),
    is_admin: false,
  };
}

export function render(template: string, data: Record<string, unknown>): string {
  return getTemplate(template)({ ...baseVars(), ...data });
}

export function renderPage(
  template: string,
  data: Record<string, unknown>,
): string {
  const vars = { ...baseVars(), ...data };
  const body = getTemplate(template)(vars);
  return getTemplate("layout")({ ...vars, body });
}
