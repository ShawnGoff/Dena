import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "@dena/core";
import { buildBrief, generateSection, productCodeSources, renderBrief, renderWikiMarkdown, sectionKeys, validateSection, type GenerateResult, type Provider } from "../src/index.ts";

let home: string;
let root: string;
let store: Store;
let pid: string;
const at = (d: number) => new Date(Date.UTC(2026, 9, d, 12)).toISOString();

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "dena-prod-"));
  root = fs.mkdtempSync(path.join(os.tmpdir(), "dena-prod-root-"));
  fs.writeFileSync(path.join(root, "README.md"), "# Tally\nCounts words in files, fast.\n\n## Install\nRun `npm install -g tally` and then `tally --help` to see the commands.\n\n## Tiny\nok\n");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "tally", description: "Word counter", bin: { tally: "cli.js" }, scripts: { test: "vitest" } }));
  fs.writeFileSync(path.join(root, ".env"), "TOKEN=abc123secretvalue");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src/cli.ts"), `const USAGE = \`tally <command>\n  count <file>     count the words in a file\n  top <file> [-n]  the most common words\n  watch <dir>      recount when files change\n  help             show this list\`;\nconsole.log(USAGE);\n`);
  store = new Store(home);
  pid = store.createProject("tally", root).id;
  store.ingest(pid, {
    sessions: [{ id: "s1", source: "claude_code.transcript", startedAt: at(1), endedAt: at(2) }], artifacts: [], gaps: [], links: [],
    events: [
      { sessionId: "s1", source: "claude_code.transcript", sourceEventId: "u1", eventType: "prompt_submitted", occurredAt: at(1), actor: "user", summary: "p", payload: { text: "Build a command-line word counter with a top-words mode" }, captureConfidence: "observed" },
      { sessionId: "s1", source: "claude_code.transcript", sourceEventId: "u2", eventType: "prompt_submitted", occurredAt: at(2), actor: "user", summary: "p", payload: { text: "ok" }, captureConfidence: "observed" },
      { sessionId: "s1", source: "claude_code.transcript", sourceEventId: "u3", eventType: "prompt_submitted", occurredAt: at(2), actor: "user", summary: "p", payload: { text: "This session is being continued from a previous conversation that ran out of context." }, captureConfidence: "observed" },
      { sessionId: null, source: "git", sourceEventId: "c1", eventType: "git_commit", occurredAt: at(3), actor: "unknown", summary: "c", payload: { sha: "abc1234", message: "Add top command", files: [{ path: "src/cli.ts" }] }, captureConfidence: "observed" },
    ],
  });
});
afterEach(() => {
  store.close();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

describe("product guide", () => {
  it("is a wiki page, built from the project's current files and what the owner asked for", () => {
    expect(sectionKeys(store, pid).map((s) => s.key).slice(0, 3)).toEqual(["overview", "product", "architecture"]);
    const code = productCodeSources(store, pid);
    expect(code.map((c) => c.files![0])).toEqual(["README.md", "README.md", "package.json", "src/cli.ts"]); // the near-empty "Tiny" section is skipped
    expect(code[1]!.text).toContain('Section "Install"');
    expect(code[2]!.text).toContain("executables: tally");
    expect(code[3]!.text).toContain("top <file> [-n]");
    expect(code.every((c) => c.grade === "observed" && !c.eventIds.length)).toBe(true);
    expect(JSON.stringify(code)).not.toContain("abc123secretvalue"); // .env is never read

    const brief = buildBrief(store, pid, "product");
    expect(brief.sources.filter((s) => s.type === "fact").map((s) => s.text)).toEqual([
      'The owner asked on 2026-10-01: "Build a command-line word counter with a top-words mode"', // a bare "ok" or a resumed-session summary is not a request
      'Commit abc1234 on 2026-10-03: "Add top command" (1 files)',
    ]);
    expect(renderBrief(brief)).toContain("FILE (current text of src/cli.ts)");
  });

  it("accepts statements resting on files, and still rejects ones resting on nothing", () => {
    const brief = buildBrief(store, pid, "product");
    const file = brief.sources.find((s) => s.type === "code")!.ref;
    const ok = validateSection({ title: "t", summary: "s", sections: [{ heading: "Start", claims: [{ text: "Install it with npm.", kind: "observed", evidence: [file] }] }], uncertainty: [] }, brief);
    expect(ok.ok).toBe(true);
    expect(ok.groundedShare).toBe(1);
    const bad = validateSection({ title: "t", summary: "s", sections: [{ heading: "Start", claims: [{ text: "It has a GUI.", kind: "observed", evidence: ["S99"] }] }], uncertainty: [] }, brief);
    expect(bad.ok).toBe(false);
  });

  it("writes the page and names the file behind each file source", async () => {
    const fake: Provider = {
      name: "fake",
      async generate(_s, user): Promise<GenerateResult> {
        const ref = /^\[(S\d+)\] FILE \(current text of src\/cli\.ts\)/m.exec(user)![1]!;
        expect(user).toContain("for someone who will USE the project");
        return { json: { title: "Using Tally", summary: "s", sections: [{ heading: "Commands", claims: [{ text: "tally top lists the most common words.", kind: "observed", evidence: [ref] }] }], uncertainty: [] },
          model: "fake", costUsd: 0, durationMs: 1 };
      },
    };
    const page = await generateSection(store, pid, "product", fake);
    expect(page.validation.ok).toBe(true);
    expect(renderWikiMarkdown(page)).toContain("from the project's files: Command-line help text");
    expect(renderWikiMarkdown(page)).toContain("— file src/cli.ts");
  });
});
