import xssModule from "xss";

// xss is CommonJS with dynamically assigned exports, so named ESM imports are
// not statically detectable (Node/Jest); read them off the default export.
const { FilterXSS, friendlyAttrValue, escapeAttrValue } =
  xssModule as unknown as typeof import("xss");

const EMBED_HOSTS = new Set([
  "www.youtube-nocookie.com",
  "www.youtube.com",
  "player.vimeo.com",
]);

const ALLOWED_TAGS: Record<string, string[]> = {
  p: [],
  h1: [],
  h2: [],
  h3: [],
  h4: [],
  h5: [],
  h6: [],
  a: ["href", "title"],
  img: ["src", "alt", "title", "width", "height"],
  ul: [],
  ol: [],
  li: [],
  blockquote: [],
  pre: ["class"],
  code: ["class"],
  em: [],
  strong: [],
  del: [],
  s: [],
  table: [],
  thead: [],
  tbody: [],
  tr: [],
  th: ["align"],
  td: ["align"],
  hr: [],
  br: [],
  sup: [],
  sub: [],
  details: [],
  summary: [],
  figure: [],
  figcaption: [],
  span: ["class"],
  div: ["class"],
  input: [],
  iframe: ["src", "width", "height", "title", "allow", "allowfullscreen"],
};

const CLASS_TOKEN_RE = /^language-[a-z0-9+-]+$/;
const ALIGN_VALUES = new Set(["left", "right", "center"]);

function stripControl(value: string): string {
  return value.replace(/[\u0000- \u007f]/g, "");
}

function isAllowedHref(raw: string): boolean {
  const value = stripControl(friendlyAttrValue(raw));
  if (value === "") return false;
  const scheme = value.match(/^([a-z][a-z0-9+.-]*):/i);
  if (scheme) return ["http", "https", "mailto"].includes(scheme[1].toLowerCase());
  return true;
}

function isAllowedImgSrc(raw: string): boolean {
  const value = stripControl(friendlyAttrValue(raw));
  if (value === "") return false;
  const scheme = value.match(/^([a-z][a-z0-9+.-]*):/i);
  if (scheme) return ["http", "https"].includes(scheme[1].toLowerCase());
  return true;
}

function isAllowedEmbed(raw: string): boolean {
  try {
    const value = friendlyAttrValue(raw).trim();
    const u = new URL(value);
    return /^https:\/\//.test(value) && u.protocol === "https:" && EMBED_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

function attrFromTag(html: string, name: string): string | null {
  const re = new RegExp(`[\\s"']${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const m = html.match(re);
  return m ? (m[1] ?? m[2] ?? m[3] ?? "") : null;
}

function digitsOnly(value: string): boolean {
  return /^[0-9]{1,5}$/.test(value);
}

export function sanitizeHtml(html: string): string {
  let iframeDropped = false;
  let openIframes = 0;

  const filter = new FilterXSS({
    whiteList: ALLOWED_TAGS,
    stripIgnoreTag: true,
    stripIgnoreTagBody: ["script", "style"],
    css: false,
    onTag(tag, tagHtml, info) {
      if (tag === "iframe") {
        if (info.isClosing) {
          if (iframeDropped || openIframes === 0) return "";
          openIframes--;
          return "</iframe>";
        }
        const src = attrFromTag(tagHtml, "src");
        iframeDropped = src === null || !isAllowedEmbed(src);
        if (iframeDropped) return "";
        openIframes++;
        return undefined;
      }
      if (tag === "input") {
        if (info.isClosing) return "";
        const type = attrFromTag(tagHtml, "type");
        if (type === null || type.trim().toLowerCase() !== "checkbox") return "";
        const checked = /[\s"']checked(?=[\s=/>])/i.test(tagHtml);
        return `<input type="checkbox" disabled${checked ? " checked" : ""}>`;
      }
      return undefined;
    },
    onTagAttr(tag, name, value) {
      const quoted = (v: string): string => `${name}="${escapeAttrValue(v)}"`;
      switch (name) {
        case "href":
          if (!isAllowedHref(value)) return "";
          return /^https?:/i.test(stripControl(friendlyAttrValue(value)))
            ? `${quoted(stripControl(friendlyAttrValue(value)))} rel="noopener noreferrer"`
            : quoted(friendlyAttrValue(value).trim());
        case "src":
          if (tag === "iframe") {
            return isAllowedEmbed(value) ? quoted(friendlyAttrValue(value).trim()) : "";
          }
          return isAllowedImgSrc(value) ? quoted(friendlyAttrValue(value).trim()) : "";
        case "class": {
          const tokens = friendlyAttrValue(value)
            .split(/\s+/)
            .filter((t) => CLASS_TOKEN_RE.test(t));
          return tokens.length > 0 ? quoted(tokens.join(" ")) : "";
        }
        case "align": {
          const v = friendlyAttrValue(value).trim().toLowerCase();
          return ALIGN_VALUES.has(v) ? quoted(v) : "";
        }
        case "width":
        case "height": {
          const v = friendlyAttrValue(value).trim();
          return digitsOnly(v) ? quoted(v) : "";
        }
        case "allowfullscreen":
          return "allowfullscreen";
        case "alt":
        case "title":
        case "allow":
          return quoted(friendlyAttrValue(value));
        default:
          return "";
      }
    },
  });

  return filter.process(html) + "</iframe>".repeat(openIframes);
}
