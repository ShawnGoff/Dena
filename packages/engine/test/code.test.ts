import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "@dena/core";
import { codeOverview, codePage, explainFile, exportGuideHtml, exportGuideMarkdown, explainFolder, folderPlan, listCodeFiles, renderCodeMarkdown, splitSymbols, type Provider } from "../src/index.ts";

let home: string;
let root: string;
let store: Store;
let pid: string;

const SRC = `import { readFileSync } from "node:fs";
import { helper } from "./util";

const LIMIT = 3;

/** Parses one CSV line. */
export function parseLine(line: string): string[] {
  return line.split(",").map((x) => x.trim());
}

export const total = (xs: number[]) => {
  return xs.reduce((a, b) => a + b, 0);
};

export interface Row {
  id: number;
  cells: string[];
}

export class Reader {
  private rows: Row[] = [];
  constructor(private readonly file: string) {}
  load(): Row[] {
    const text = readFileSync(this.file, "utf8");
    this.rows = text.split("\\n").map((l, i) => ({ id: i, cells: parseLine(l) }));
    return this.rows;
  }
  count() {
    return this.rows.length;
  }
}
`;

/** Answers with an explanation for every symbol it was shown, and records what it was sent. */
class FakeProvider implements Provider {
  readonly name = "fake";
  calls: { user: string; keys: string[]; withFile: boolean }[] = [];
  skip = new Set<string>();
  async generate(_s: string, user: string, schema: any) {
    const keys = [...user.matchAll(/<symbol key=("[^"]*")/g)].map((m) => JSON.parse(m[1]!) as string);
    const withFile = !!schema.properties.file;
    this.calls.push({ user, keys, withFile });
    const symbols = keys.filter((k) => !this.skip.has(k)).map((key) => ({ key, summary: `About ${key}.`, how: ["step"], learn: [], watch: [] }));
    this.skip.clear();
    return {
      json: { symbols, ...(withFile ? { file: { purpose: "Reads CSV files.", fitsIn: ["Used by app.ts"], learn: [{ concept: "Classes", explanation: "x" }], readingOrder: ["Reader", "nope", "parseLine"] } } : {}) },
      model: "fake-1", costUsd: 0, durationMs: 1, tokens: { prompt: 1000, output: 200, cacheRead: 0 },
    };
  }
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "dena-code-"));
  root = fs.mkdtempSync(path.join(os.tmpdir(), "dena-code-root-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.mkdirSync(path.join(root, "node_modules"));
  fs.writeFileSync(path.join(root, "src/csv.ts"), SRC);
  fs.writeFileSync(path.join(root, "src/util.ts"), "export const helper = 1;\n");
  fs.writeFileSync(path.join(root, "src/app.ts"), `import { Reader } from "./csv";\nnew Reader("a").load();\n`);
  fs.writeFileSync(path.join(root, "node_modules/dep.js"), "x");
  fs.writeFileSync(path.join(root, ".env"), "SECRET=1");
  fs.writeFileSync(path.join(root, "README.md"), "# hi");
  store = new Store(home);
  pid = store.createProject("p", root).id;
});
afterEach(() => {
  store.close();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

describe("code explainers", () => {
  it("lists source files only, never dependencies or sensitive files", () => {
    expect(listCodeFiles(store, pid).map((f) => f.path)).toEqual(["src/app.ts", "src/csv.ts", "src/util.ts"]);
  });

  it("splits a file into symbols, with methods apart from their class", () => {
    const s = splitSymbols("src/csv.ts", SRC);
    expect(s.map((x) => `${x.key}:${x.kind}`)).toEqual([
      "(module setup):setup", "parseLine:function", "total:function", "Row:type", "Reader:class", "Reader.constructor:method", "Reader.load:method", "Reader.count:method",
    ]);
    expect(s.find((x) => x.key === "parseLine")!.text).toContain("Parses one CSV line"); // doc comment included
    expect(s.find((x) => x.key === "Reader")!.text).not.toContain("readFileSync(this.file"); // method bodies left out of the class outline
    expect(s[0]!.ranges).toEqual([[1, 4]]); // imports and the constant, joined across the blank line
  });

  it("explains everything once, then only what changed", async () => {
    const fake = new FakeProvider();
    const first = await explainFile(store, pid, "src/csv.ts", fake);
    expect(first.explained).toBe(8);
    expect(fake.calls[0]!.withFile).toBe(true);
    expect(fake.calls[0]!.user).toContain("Imported by: src/app.ts");
    let page = codePage(store, pid, "src/csv.ts");
    expect(page.symbols.every((s) => s.status === "current")).toBe(true);
    expect(page.fileDoc?.doc.readingOrder).toEqual(["Reader", "parseLine"]); // unknown keys dropped
    expect(page.pending.calls).toBe(0);

    // Nothing changed: no call at all.
    expect((await explainFile(store, pid, "src/csv.ts", fake)).calls).toBe(0);

    // Change one method's body: only that method is re-explained; the class outline is unchanged.
    fs.writeFileSync(path.join(root, "src/csv.ts"), SRC.replace("return this.rows.length;", "return this.rows.filter((r) => r.cells.length).length;"));
    page = codePage(store, pid, "src/csv.ts");
    expect(page.symbols.filter((s) => s.status !== "current").map((s) => `${s.key}:${s.status}`)).toEqual(["Reader.count:changed"]);
    expect(page.symbols.find((s) => s.key === "Reader.count")!.doc?.summary).toBe("About Reader.count."); // the old reading stays visible, marked changed
    expect(page.fileDoc?.current).toBe(false);
    const second = await explainFile(store, pid, "src/csv.ts", fake);
    expect(fake.calls.length).toBe(2);
    expect(fake.calls[1]!.keys).toEqual(["Reader.count"]);
    expect(fake.calls[1]!.user).toContain("- parseLine (function, lines 6–9): About parseLine."); // others go as one-line summaries, not code
    expect(fake.calls[1]!.user).not.toContain('x.split(",")');
    expect(second.explained).toBe(1);
    expect(codePage(store, pid, "src/csv.ts").symbols.every((s) => s.status === "current")).toBe(true);
  });

  it("reuses explanations when a file moves, and repairs only missing symbols", async () => {
    const fake = new FakeProvider();
    fake.skip.add("total");
    const r = await explainFile(store, pid, "src/csv.ts", fake);
    expect(fake.calls.length).toBe(2);
    expect(fake.calls[1]!.keys).toEqual(["total"]); // the repair asks for the missing one only
    expect(fake.calls[1]!.withFile).toBe(false); // the file page arrived the first time
    expect(r.explained).toBe(8);

    fs.renameSync(path.join(root, "src/csv.ts"), path.join(root, "src/table.ts"));
    const moved = await explainFile(store, pid, "src/table.ts", fake);
    expect(moved.reused).toBeGreaterThan(4);
    expect(fake.calls.length).toBe(3);
    expect(fake.calls[2]!.keys).toEqual([]); // every symbol reused; only the new path's file page is written
  });

  it("records calls for usage, shows the overview, and refuses files outside the list", async () => {
    await explainFile(store, pid, "src/csv.ts", new FakeProvider());
    const page = codePage(store, pid, "src/csv.ts");
    expect(page.usage).toEqual({ calls: 1, tokens: { prompt: 1000, output: 200, cacheRead: 0 } });
    const ov = codeOverview(store, pid);
    expect(ov.find((f) => f.path === "src/csv.ts")).toMatchObject({ current: 8, changed: 0, new: 0, fileDoc: "current" });
    expect(ov.find((f) => f.path === "src/util.ts")).toMatchObject({ current: 0, fileDoc: "none" });
    expect(() => codePage(store, pid, "../etc/passwd")).toThrow(/does not explain/);
    expect(() => codePage(store, pid, ".env")).toThrow(/does not explain/);
    expect(renderCodeMarkdown(page)).toContain("## What you can learn here");
  });

  it("tells how the AI built the file, and which functions each edit landed in", () => {
    const at = (s: number) => new Date(Date.UTC(2026, 9, 1, 12, 0, s)).toISOString();
    const CC = "claude_code.transcript";
    store.ingest(pid, {
      sessions: [{ id: "s1", source: CC, startedAt: at(0), endedAt: at(60) }], artifacts: [], gaps: [],
      events: [
        { sessionId: "s1", source: CC, sourceEventId: "u1", eventType: "prompt_submitted", occurredAt: at(0), actor: "user", summary: "p", payload: { text: "Add a CSV reader" }, captureConfidence: "observed" },
        { sessionId: "s1", source: CC, sourceEventId: "t1", eventType: "tool_invoked", occurredAt: at(5), actor: "ai_agent", summary: "w", payload: { tool: "Write", input: { file_path: path.join(root, "src/csv.ts"), content: SRC } }, captureConfidence: "observed" },
        { sessionId: "s1", source: CC, sourceEventId: "t2", eventType: "tool_invoked", occurredAt: at(9), actor: "ai_agent", summary: "e", payload: { tool: "Edit", input: { file_path: path.join(root, "src/csv.ts"), old_string: "a", new_string: '    this.rows = text.split("\\n").map((l, i) => ({ id: i, cells: parseLine(l) }));' } }, captureConfidence: "observed" },
        { sessionId: "s1", source: CC, sourceEventId: "t3", eventType: "tool_invoked", occurredAt: at(10), actor: "ai_agent", summary: "r", payload: { tool: "Edit", input: { file_path: path.join(root, "src/other.ts"), new_string: "x" } }, captureConfidence: "observed" },
        { sessionId: null, source: "git", sourceEventId: "c1", eventType: "git_commit", occurredAt: at(20), actor: "unknown", summary: "c", payload: { sha: "abc1234", message: "Add reader", files: [{ path: "src/csv.ts" }] }, captureConfidence: "observed" },
      ],
      links: [],
    });
    const h = codePage(store, pid, "src/csv.ts").history;
    expect(h.created?.who).toBe("ai");
    expect(h.aiEdits).toBe(2);
    expect(h.commits).toBe(1);
    expect(h.entries.map((e) => e.text)).toEqual(["You asked: “Add a CSV reader”", "Wrote the file", "Edited Reader.load", "Commit abc1234 “Add reader”"]);
    expect(codePage(store, pid, "src/csv.ts").symbols.find((s) => s.key === "Reader.load")!.aiEdits).toBe(1);
  });
});

describe("the guide export", () => {
  it("includes explained code files and counts the parts not explained yet", async () => {
    expect(exportGuideMarkdown(store, pid).counts.codeFiles).toBe(0);
    await explainFile(store, pid, "src/csv.ts", new FakeProvider());
    const { markdown, counts } = exportGuideMarkdown(store, pid);
    expect(counts.codeFiles).toBe(1);
    expect(markdown).toContain("- [Code](#code)");
    expect(markdown).toContain("### src/csv.ts");
    expect(markdown).not.toContain("### src/util.ts");
    expect(exportGuideHtml(store, pid).html).toContain('<h3 id="src-csv-ts">src/csv.ts</h3>');
  });
});

describe("explaining a whole folder", () => {
  it("states what it would send first, explains only what needs it, and then has nothing left", async () => {
    const before = folderPlan(store, pid, "src");
    expect(before.files).toBe(3);
    expect(before.pending.map((p) => p.path)).toEqual(["src/app.ts", "src/csv.ts", "src/util.ts"]);
    expect(before.estimate!.high).toBeGreaterThan(before.estimate!.low);
    expect(folderPlan(store, pid, "nope").files).toBe(0);

    const fake = new FakeProvider();
    await explainFile(store, pid, "src/csv.ts", fake); // already explained: skipped by the folder run
    const progress: string[] = [];
    const r = await explainFolder(store, pid, "src", fake, { onProgress: (p) => progress.push(`${p.done}/${p.total}${p.current ? ` ${p.current}` : ""}`) });
    expect(r.files).toBe(2);
    expect(progress).toEqual(["0/2 src/app.ts", "1/2 src/util.ts", "2/2"]);
    expect(folderPlan(store, pid, "src").pending).toEqual([]);
  });

  it("stops between files when asked, keeping what was done", async () => {
    const fake = new FakeProvider();
    const stop = new AbortController();
    await expect(explainFolder(store, pid, "src", fake, { signal: stop.signal, onProgress: (p) => { if (p.done === 1) stop.abort(); } })).rejects.toThrow();
    expect(folderPlan(store, pid, "src").pending.length).toBe(1); // files finished before the stop are kept; the rest wait
  });
});

describe("code estimates", () => {
  it("learn from past code calls once there are three", async () => {
    const fake = new FakeProvider();
    for (const f of ["src/csv.ts", "src/util.ts", "src/app.ts"]) await explainFile(store, pid, f, fake);
    fs.writeFileSync(path.join(root, "src/csv.ts"), SRC.replace("return this.rows.length;", "return 0;"));
    const est = codePage(store, pid, "src/csv.ts").pending.estimate!;
    expect(est.basis).toMatch(/^calibrated on 3 of your code explanations/);
    expect(est.high).toBe(Math.round(est.low * 1.5));
  });
});
