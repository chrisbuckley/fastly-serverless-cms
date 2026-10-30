import { marked } from "marked";

import { sanitizeHtml } from "./sanitize.js";

marked.setOptions({ gfm: true });

export function renderMarkdown(input: string): string {
  return marked.parse(input) as string;
}

export function renderPostHtml(markdown: string): string {
  return rewriteImages(sanitizeHtml(renderMarkdown(markdown)));
}

export function rewriteImages(html: string): string {
  const marker = '<img src="/images/';
  let out = "";
  let rest = html;

  while (true) {
    const imgStart = rest.indexOf(marker);
    if (imgStart === -1) break;

    out += rest.substring(0, imgStart);
    const afterMarker = rest.substring(imgStart + marker.length);

    const srcEnd = afterMarker.indexOf('"');
    if (srcEnd === -1) break;
    const srcPath = "/images/" + afterMarker.substring(0, srcEnd);

    const tagEnd = afterMarker.indexOf(">");
    if (tagEnd === -1) break;
    const tagInner = afterMarker.substring(0, tagEnd);

    let alt = "";
    const altStart = tagInner.indexOf('alt="');
    if (altStart !== -1) {
      const afterAlt = tagInner.substring(altStart + 5);
      const altEnd = afterAlt.indexOf('"');
      if (altEnd !== -1) {
        alt = afterAlt.substring(0, altEnd);
      }
    }

    out += responsivePicture(srcPath, alt);
    rest = afterMarker.substring(tagEnd + 1);
  }

  out += rest;
  return out;
}

function responsivePicture(src: string, alt: string): string {
  return (
    "<picture>" +
    `<source type="image/webp" ` +
    `srcset="${src}?width=480&format=webp 480w, ` +
    `${src}?width=800&format=webp 800w, ` +
    `${src}?width=1280&format=webp 1280w" ` +
    `sizes="(max-width: 640px) 100vw, 680px">` +
    `<img alt="${alt}" src="${src}?width=680" loading="lazy">` +
    "</picture>"
  );
}
