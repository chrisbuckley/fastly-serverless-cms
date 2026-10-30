import { sanitizeHtml } from "../sanitize.js";
import { renderMarkdown, rewriteImages, renderPostHtml } from "../markdown.js";

describe("sanitizeHtml (contract section 11)", () => {
  it("removes <script> including its body", () => {
    const out = sanitizeHtml("<p>hi</p><script>alert(1)</script>");
    expect(out).toBe("<p>hi</p>");
  });

  it("removes onerror and other event handlers", () => {
    const out = sanitizeHtml('<img src="/images/a/b.png" onerror="alert(1)" alt="x">');
    expect(out).not.toMatch(/onerror/i);
    expect(out).toContain('src="/images/a/b.png"');
    expect(out).toContain('alt="x"');
  });

  it("strips javascript:, data: and vbscript: URLs", () => {
    expect(sanitizeHtml('<a href="javascript:alert(1)">x</a>')).toBe("<a>x</a>");
    expect(sanitizeHtml('<a href="  JaVa&#x09;Script:alert(1)">x</a>')).not.toMatch(/script:/i);
    expect(sanitizeHtml('<a href="data:text/html;base64,AAAA">x</a>')).toBe("<a>x</a>");
    expect(sanitizeHtml('<a href="vbscript:x">x</a>')).toBe("<a>x</a>");
    expect(sanitizeHtml('<img src="data:image/png;base64,AAAA">')).not.toMatch(/data:/);
  });

  it("keeps http, https, mailto and relative URLs; adds rel to absolute links", () => {
    expect(sanitizeHtml('<a href="https://a.example/x">x</a>')).toBe(
      '<a href="https://a.example/x" rel="noopener noreferrer">x</a>',
    );
    expect(sanitizeHtml('<a href="http://a.example">x</a>')).toContain('rel="noopener noreferrer"');
    expect(sanitizeHtml('<a href="mailto:a@b.c">x</a>')).toBe('<a href="mailto:a@b.c">x</a>');
    expect(sanitizeHtml('<a href="/post/x" title="t">x</a>')).toBe('<a href="/post/x" title="t">x</a>');
    expect(sanitizeHtml('<a href="#frag">x</a>')).toBe('<a href="#frag">x</a>');
  });

  it("keeps YouTube and Vimeo iframes on https", () => {
    const yt =
      '<iframe src="https://www.youtube-nocookie.com/embed/abc" width="560" height="315" title="v" allowfullscreen></iframe>';
    const out = sanitizeHtml(yt);
    expect(out).toContain("<iframe");
    expect(out).toContain('src="https://www.youtube-nocookie.com/embed/abc"');
    expect(out).toContain("</iframe>");
    expect(sanitizeHtml('<iframe src="https://www.youtube.com/embed/x"></iframe>')).toContain("<iframe");
    expect(sanitizeHtml('<iframe src="https://player.vimeo.com/video/1"></iframe>')).toContain("<iframe");
  });

  it("removes other iframes entirely", () => {
    for (const src of [
      "https://evil.example/x",
      "http://www.youtube.com/embed/x",
      "https://www.youtube.com.evil.example/embed/x",
      "https://evil.example/https://www.youtube.com/",
      "javascript:alert(1)",
      "//www.youtube.com/embed/x",
    ]) {
      const out = sanitizeHtml(`<p>a</p><iframe src="${src}"></iframe><p>b</p>`);
      expect(out).toBe("<p>a</p><p>b</p>");
    }
    expect(sanitizeHtml("<iframe></iframe>")).toBe("");
  });

  it("drops iframe event handlers and unknown attributes", () => {
    const out = sanitizeHtml(
      '<iframe src="https://www.youtube.com/embed/x" onload="x()" srcdoc="<b>" style="x"></iframe>',
    );
    expect(out).not.toMatch(/onload|srcdoc|style/);
  });

  it("keeps tables with alignment", () => {
    const out = sanitizeHtml(
      '<table><thead><tr><th align="left">a</th></tr></thead><tbody><tr><td align="center">1</td></tr></tbody></table>',
    );
    expect(out).toContain("<table>");
    expect(out).toContain('<th align="left">');
    expect(out).toContain('<td align="center">');
    expect(sanitizeHtml('<td align="javascript:x">1</td>')).toBe("<td>1</td>");
  });

  it("keeps only language-* classes", () => {
    expect(sanitizeHtml('<pre><code class="language-rust">fn</code></pre>')).toBe(
      '<pre><code class="language-rust">fn</code></pre>',
    );
    expect(sanitizeHtml('<code class="language-c++">x</code>')).toContain('class="language-c++"');
    expect(sanitizeHtml('<code class="evil">x</code>')).toBe("<code>x</code>");
    expect(sanitizeHtml('<span class="language-js evil">x</span>')).toBe('<span class="language-js">x</span>');
    expect(sanitizeHtml('<div class="x" id="y">z</div>')).toBe("<div>z</div>");
  });

  it("forces task-list checkboxes to be disabled and drops other inputs", () => {
    expect(sanitizeHtml('<input type="checkbox" checked>')).toBe('<input type="checkbox" disabled checked>');
    expect(sanitizeHtml('<input checked="" disabled="" type="checkbox">')).toBe(
      '<input type="checkbox" disabled checked>',
    );
    expect(sanitizeHtml('<input type="checkbox">')).toBe('<input type="checkbox" disabled>');
    expect(sanitizeHtml('<input type="text" value="x">')).toBe("");
    expect(sanitizeHtml('<input onclick="x()" type="checkbox">')).not.toMatch(/onclick/);
  });

  it("drops style attributes, forms, objects, styles and comments", () => {
    expect(sanitizeHtml('<p style="color:red">x</p>')).toBe("<p>x</p>");
    expect(sanitizeHtml("<style>p{}</style><p>x</p>")).toBe("<p>x</p>");
    expect(sanitizeHtml("<!-- c --><p>x</p>")).toBe("<p>x</p>");
    expect(sanitizeHtml('<form action="/x"><button>go</button></form>')).not.toMatch(/<form|<button/);
    expect(sanitizeHtml('<object data="x"></object><embed src="x">')).toBe("");
  });

  it("keeps img attributes and removes unknown ones", () => {
    const out = sanitizeHtml('<img src="https://x.example/a.png" alt="a" title="t" width="10" height="20" srcset="x" loading="eager">');
    expect(out).toContain('width="10"');
    expect(out).toContain('height="20"');
    expect(out).not.toMatch(/srcset|loading/);
    expect(sanitizeHtml('<img src="/a.png" width="10px">')).not.toContain("width");
  });

  it("keeps details/summary/figure and other allowed structure", () => {
    const html =
      "<details><summary>s</summary><p>x</p></details><figure><img src=\"/a.png\" alt=\"\"><figcaption>c</figcaption></figure><hr><br><sup>1</sup><sub>2</sub><del>d</del><s>s</s>";
    const out = sanitizeHtml(html);
    for (const tag of ["details", "summary", "figure", "figcaption", "hr", "sup", "sub", "del", "s"]) {
      expect(out).toContain(`<${tag}`);
    }
  });

  it("neutralises attribute-breaking payloads", () => {
    const out = sanitizeHtml('<a href="/x&quot; onmouseover=&quot;alert(1)">x</a>');
    expect(out).not.toMatch(/onmouseover=["']?alert/);
    expect(out).not.toMatch(/" onmouseover/);
  });

  it("returns empty string for empty input", () => {
    expect(sanitizeHtml("")).toBe("");
  });
});

describe("markdown pipeline", () => {
  it("renders GFM tables, strikethrough and task lists", () => {
    const html = renderPostHtml("| a | b |\n|---|---|\n| 1 | 2 |\n\n~~gone~~\n\n- [x] done\n- [ ] todo\n");
    expect(html).toContain("<table>");
    expect(html).toContain("<del>gone</del>");
    expect(html).toContain('type="checkbox" disabled checked');
    expect(html).toContain('<input type="checkbox" disabled>');
  });

  it("sanitises raw HTML embedded in markdown", () => {
    const html = renderPostHtml("hello\n\n<script>alert(1)</script>\n\n[x](javascript:alert(1))\n");
    expect(html).not.toMatch(/<script|javascript:/i);
  });

  it("keeps fenced code language classes", () => {
    expect(renderPostHtml("```rust\nfn main() {}\n```\n")).toContain('class="language-rust"');
  });

  it("rewrites local images to responsive pictures after sanitising", () => {
    const html = renderPostHtml("![Alt text](/images/post/pic.png)");
    expect(html).toContain("<picture>");
    expect(html).toContain('srcset="/images/post/pic.png?width=480&format=webp 480w');
    expect(html).toContain('alt="Alt text"');
  });

  it("renderMarkdown alone does not sanitise; rewriteImages handles missing alt and malformed input", () => {
    expect(renderMarkdown("**b**")).toContain("<strong>b</strong>");
    expect(rewriteImages('<img src="/images/a/b.png">')).toContain('alt=""');
    expect(rewriteImages('<img src="/images/a/b.png')).toBe('<img src="/images/a/b.png');
    expect(rewriteImages("<p>none</p>")).toBe("<p>none</p>");
  });
});
