export const MAX_CONTENT_BYTES = 512 * 1024;
export const MAX_FORM_BYTES = 1024 * 1024;
export const MAX_SIDEBAR_BYTES = 64 * 1024;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_TAGS = 20;

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;
const TAG_RE = /^[a-z0-9][a-z0-9-]{0,49}$/;
const FILENAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}\.(jpg|jpeg|png|webp|gif)$/;
const ICON_RE = /^[a-z0-9-]{1,32}$/;

export type ImageType = "image/jpeg" | "image/png" | "image/webp" | "image/gif";

const utf8 = new TextEncoder();

export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}

export function isValidTag(tag: string): boolean {
  return TAG_RE.test(tag);
}

export function isValidIcon(icon: string): boolean {
  return ICON_RE.test(icon);
}

export function validateTitle(title: string): boolean {
  const n = title.trim().length;
  return n >= 1 && n <= 200;
}

export function validateExcerpt(excerpt: string): boolean {
  return excerpt.length <= 500;
}

export function isValidStatus(status: string): status is "published" | "draft" {
  return status === "published" || status === "draft";
}

export function contentTooLarge(content: string): boolean {
  return utf8.encode(content).length > MAX_CONTENT_BYTES;
}

export function normalizeTags(input: string): string[] {
  const out: string[] = [];
  for (const raw of input.split(",")) {
    const tag = raw.trim().toLowerCase().replace(/\s+/g, "-");
    if (!TAG_RE.test(tag) || out.includes(tag)) continue;
    out.push(tag);
    if (out.length === MAX_TAGS) break;
  }
  return out;
}

export function isValidUploadFilename(name: string): boolean {
  return FILENAME_RE.test(name);
}

function startsWith(bytes: Uint8Array, sig: number[], offset = 0): boolean {
  if (bytes.length < offset + sig.length) return false;
  return sig.every((b, i) => bytes[offset + i] === b);
}

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

export function detectImageType(bytes: Uint8Array): ImageType | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"))) {
    return "image/gif";
  }
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) {
    return "image/webp";
  }
  return null;
}

export function extensionMatchesType(filename: string, type: ImageType): boolean {
  const ext = filename.slice(filename.lastIndexOf(".") + 1);
  switch (type) {
    case "image/jpeg":
      return ext === "jpg" || ext === "jpeg";
    case "image/png":
      return ext === "png";
    case "image/webp":
      return ext === "webp";
    case "image/gif":
      return ext === "gif";
  }
}

export function isSafeUrl(url: string): boolean {
  if (/[\u0000- \u007f]/.test(url)) return false;
  if (url.startsWith("//")) return false;
  if (url.startsWith("/")) return true;
  return /^https?:\/\/\S+$/i.test(url);
}
