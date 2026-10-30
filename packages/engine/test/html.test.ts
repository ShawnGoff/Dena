import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "@dena/core";
import { exportGuideHtml, inline, markdownToHtml, recordGenerated } from "../src/index.ts";

let home: string;
let store: Store;
let pid: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "dena-html-"));
  store = new Store(home);
  pid = store.createProject("demo", "/demo").id;
});
afterEach(() => {
  store.close();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("HTML export", () => {
  it("renders the export's Markdown: headings, labelled lists, numbered steps with code, anchors and sources", () => {
    const html = markdownToHtml([
      "## Walkthrough", "",
      "1. **✓ Observed** — Create `src/a.ts`. [[E1](#ep1-e1)]", "", "   ```", "   export const a = 1;", "   ```", "",
      "2. **~ Inferred** — Run the tests.", "",
      "<details><summary>Evidence</summary>", "",
      '- <a id="ep1-e1"></a>**E1** file_change — events #12', "", "</details>",
    ].join("\n"));
    expect(html).toContain('<h2 id="walkthrough">Walkthrough</h2>');
    expect(html).toContain('<ol class="steps"><li>');
    expect(html).toContain("<strong>✓ Observed</strong> — Create <code>src/a.ts</code>. [<a href=\"#ep1-e1\">E1</a>]");
    expect(html).toContain("<pre><code>export const a = 1;</code></pre>\n</li><li>\n<strong>~ Inferred</strong>"); // the code stays inside step 1, and step 2 continues the same list
    expect(html).toContain('<details><summary>Evidence</summary>');
    expect(html).toContain('<span id="ep1-e1"></span><strong>E1</strong> file_change');
  });

  it("escapes everything that came from the project", () => {
    expect(inline('Use <script>alert(1)</script> and a [link](https://evil.example) and **bold**')).toBe(
      "Use &lt;script&gt;alert(1)&lt;/script&gt; and a [link](https://evil.example) and <strong>bold</strong>");
    expect(markdownToHtml("```\n</code><img src=x onerror=alert(1)>\n```")).toBe("<pre><code>&lt;/code&gt;&lt;img src=x onerror=alert(1)&gt;</code></pre>");
    expect(markdownToHtml('<details><summary>Other</summary>')).not.toContain("<details>"); // only the export's own markup passes through
  });

  it("is one self-contained page, with the AI notice, and no scripts or outside requests", () => {
    recordGenerated(store, pid, "wiki", "overview", { title: "Overview <b>x</b>", summary: "What it is.", sections: [{ heading: "Story", claims: [{ text: "It was built <fast>.", kind: "observed", evidence: [] }] }],
      uncertainty: [], learn: [{ concept: "Escaping", explanation: "Never trust text." }] }, { sources: [] });
    const { html, counts } = exportGuideHtml(store, pid, { generatedAt: "2026-10-30T00:00:00Z" });
    expect(counts.wikiPages).toBe(1);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("Content-Security-Policy");
    expect(html).not.toMatch(/<script|https?:\/\/(?!evil)/i);
    expect(html).toContain("It can be wrong.");
    expect(html).toContain("Overview &lt;b&gt;x&lt;/b&gt;");
    expect(html).toContain("It was built &lt;fast&gt;.");
    expect(html).toContain("<strong>Escaping</strong> — Never trust text.");
  });
});
