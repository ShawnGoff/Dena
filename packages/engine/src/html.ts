import type { Store } from "@dena/core";
import { exportGuideMarkdown, type ExportResult } from "./export.ts";

/**
 * The guide as one self-contained HTML page to share: no scripts, no external files, readable in
 * any browser, light or dark. It is rendered from the same Markdown export, so both always say the
 * same thing.
 *
 * Every piece of project text is escaped. The only markup that passes through is the small set the
 * Markdown export itself produces (headings, lists, emphasis, code, links within the page, anchors
 * and collapsible source lists), so nothing captured from a project can inject HTML into the page.
 */

export interface HtmlExport extends Omit<ExportResult, "markdown"> {
  html: string;
}

export function exportGuideHtml(store: Store, projectId: string, opts: { generatedAt?: string } = {}): HtmlExport {
  const { markdown, counts } = exportGuideMarkdown(store, projectId, opts);
  const project = store.getProject(projectId)!;
  return { html: htmlDocument(`${project.name}: how it got built`, markdownToHtml(markdown)), counts };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Inline Markdown: `code`, **bold**, *italic*, ~~struck~~, and links to anchors in this page. */
export function inline(text: string): string {
  return text
    .split(/(`[^`]+`)/)
    .map((part) => {
      if (/^`[^`]+`$/.test(part)) return `<code>${esc(part.slice(1, -1))}</code>`;
      return esc(part)
        .replace(/\[([^[\]]+)\]\((#[\w-]+)\)/g, (_m, t: string, href: string) => `<a href="${href}">${t}</a>`)
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
        .replace(/~~(.+?)~~/g, "<del>$1</del>")
        .replace(/(^|[\s(])\*(?!\s)(.+?)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");
    })
    .join("");
}

const ANCHOR = /^<a id="([\w-]+)"><\/a>/;

/** The Markdown subset the guide export produces, as HTML. */
export function markdownToHtml(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let list: "ul" | "ol" | null = null;
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`);
    para = [];
  };
  const closeList = () => {
    if (list) out.push(`</li></${list}>`);
    list = null;
  };
  const item = (kind: "ul" | "ol", body: string) => {
    flushPara();
    if (list !== kind) {
      closeList();
      out.push(`<${kind}${kind === "ol" ? ' class="steps"' : ""}><li>`);
      list = kind;
    } else out.push("</li><li>");
    const a = ANCHOR.exec(body);
    out.push(a ? `<span id="${a[1]}"></span>${inline(body.slice(a[0].length).trimStart())}` : inline(body));
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^(\s*)```/.exec(line);
    if (fence) {
      // A code block; indented ones belong to the list item above.
      const code: string[] = [];
      const indent = fence[1]!.length;
      for (i++; i < lines.length && !/^\s*```\s*$/.test(lines[i]!); i++) code.push(lines[i]!.slice(Math.min(indent, lines[i]!.search(/\S|$/))));
      if (!indent) {
        flushPara();
        closeList();
      }
      out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
      continue;
    }
    const h = /^(#{1,4}) (.*)$/.exec(line);
    if (h) {
      flushPara();
      closeList();
      const level = h[1]!.length;
      const text = h[2]!;
      out.push(`<h${level} id="${slug(text)}">${inline(text)}</h${level}>`);
      continue;
    }
    if (line === "<details><summary>Sources</summary>" || line === "<details><summary>Evidence</summary>") {
      flushPara();
      closeList();
      out.push(`<details><summary>${line.includes("Sources") ? "Sources" : "Evidence"}</summary>`);
      continue;
    }
    if (line === "</details>") {
      flushPara();
      closeList();
      out.push("</details>");
      continue;
    }
    const ul = /^- (.*)$/.exec(line);
    if (ul) {
      item("ul", ul[1]!);
      continue;
    }
    const ol = /^\d+\. (.*)$/.exec(line);
    if (ol) {
      item("ol", ol[1]!);
      continue;
    }
    if (line.startsWith("> ")) {
      flushPara();
      closeList();
      out.push(`<blockquote>${inline(line.slice(2))}</blockquote>`);
      continue;
    }
    if (!line.trim()) {
      flushPara();
      // A blank line inside a numbered list can sit between a step and its code block.
      if (list === "ol" && /^\s+```|^\d+\. /.test(lines[i + 1] ?? "")) continue;
      closeList();
      continue;
    }
    para.push(line.trim());
  }
  flushPara();
  closeList();
  return out.join("\n");
}

/** Anchor ids that match the Markdown export's own (lowercase, dashes). */
const slug = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");

function htmlDocument(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<title>${esc(title)}</title>
<style>
:root { --bg: #ffffff; --fg: #1d2129; --dim: #5d6573; --line: #e3e6eb; --soft: #f5f6f8; --accent: #4757d6; --code: #f2f3f6; }
@media (prefers-color-scheme: dark) { :root { --bg: #111318; --fg: #e6e8ec; --dim: #9aa2b1; --line: #2a2e37; --soft: #181b21; --accent: #8b9cff; --code: #1b1e25; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
main { max-width: 820px; margin: 0 auto; padding: 32px 16px 80px; }
h1 { font-size: 30px; line-height: 1.25; margin: 0 0 16px; }
h2 { font-size: 23px; margin: 44px 0 12px; padding-top: 16px; border-top: 1px solid var(--line); }
h3 { font-size: 18px; margin: 28px 0 8px; }
h4 { font-size: 15px; margin: 22px 0 6px; color: var(--dim); text-transform: uppercase; letter-spacing: .05em; }
p, li { overflow-wrap: anywhere; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
blockquote { margin: 16px 0; padding: 12px 16px; background: var(--soft); border-left: 3px solid var(--accent); border-radius: 6px; }
ul, ol { padding-left: 22px; }
li { margin: 6px 0; }
ol.steps { counter-reset: step; list-style: none; padding-left: 0; }
ol.steps > li { counter-increment: step; position: relative; padding-left: 36px; }
ol.steps > li::before { content: counter(step); position: absolute; left: 0; top: 1px; width: 24px; height: 24px; border-radius: 50%; background: var(--soft); border: 1px solid var(--line); font: 600 12px/24px ui-monospace, Menlo, monospace; text-align: center; }
code { font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--code); padding: 1px 5px; border-radius: 4px; }
pre { background: var(--code); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; overflow-x: auto; }
pre code { background: none; padding: 0; white-space: pre; }
details { margin: 10px 0; color: var(--dim); font-size: 14px; }
summary { cursor: pointer; }
del { color: var(--dim); }
strong { font-weight: 650; }
footer { margin-top: 48px; color: var(--dim); font-size: 13px; }
@media print { h2 { break-before: page; } details { display: none; } }
</style>
</head>
<body>
<main>
${body}
<footer>Made with Dena from captured project evidence. AI-written text can be wrong; each statement is labelled with how sure it is.</footer>
</main>
</body>
</html>
`;
}
