import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { correlate, Store, type NewEvent } from "@dena/core";
import { exportGuideMarkdown, howBuiltLine, howBuiltPage, howBuiltStep, loadEpisodes, rebuildEpisodes, recordGenerated } from "../src/index.ts";

let home: string;
let store: Store;
let pid: string;
const CC = "claude_code.transcript";
const at = (s: number) => new Date(Date.UTC(2026, 9, 1, 12, 0, s)).toISOString();
const ev = (sid: string, eventType: NewEvent["eventType"], s: number, payload: Record<string, unknown>, extra: Partial<NewEvent> = {}): NewEvent => ({
  sessionId: "s1", source: CC, sourceEventId: sid, eventType, occurredAt: at(s), actor: "ai_agent", summary: sid, payload, captureConfidence: "observed", ...extra,
});

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "dena-hb-"));
  store = new Store(home);
  pid = store.createProject("p", "/p").id;
  store.ingest(pid, {
    sessions: [{ id: "s1", source: CC, startedAt: at(0), endedAt: at(60) }], artifacts: [], gaps: [],
    links: [{ source: CC, fromSourceEventId: "result:t1", toSourceEventId: "tool:t1", toSource: CC, linkType: "result_of", strength: "observed", basis: "t" }],
    events: [
      ev("u1", "prompt_submitted", 0, { text: "Add a CSV parser and a docs page" }, { actor: "user" }),
      ev("tool:w1", "tool_invoked", 3, { tool: "Write", input: { file_path: "/p/src/csv.ts" } }),
      ev("tool:w2", "tool_invoked", 4, { tool: "Write", input: { file_path: "/p/docs/guide.md" } }),
      ev("tool:t1", "tool_invoked", 10, { tool: "Bash", input: { command: "npm test", description: "Run the tests" } }),
      ev("result:t1", "test_result", 12, { tool: "Bash", status: "error", outcome: "failed", testsPassed: 2, testsFailed: 1 }),
      ev("n1", "agent_note", 14, { kind: "decision", text: "Kept src/csv.ts dependency-free on purpose." }),
      ev("n2", "agent_note", 15, { kind: "todo", text: "Write more docs later." }),
      { sessionId: null, source: "git", sourceEventId: "c1", eventType: "git_commit", occurredAt: at(20), actor: "unknown", summary: "c1", payload: { sha: "abc1234", message: "Add parser", files: [{ path: "src/csv.ts" }] }, captureConfidence: "observed" },
      { sessionId: null, source: "git", sourceEventId: "c2", eventType: "git_commit", occurredAt: at(21), actor: "unknown", summary: "c2", payload: { sha: "def5678", message: "Add docs", files: [{ path: "docs/guide.md" }] }, captureConfidence: "observed" },
    ],
  });
  correlate(store, pid);
  rebuildEpisodes(store, pid);
});
afterEach(() => {
  store.close();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("how the AI built this", () => {
  it("tells an episode's process in plain language, from events only", () => {
    const ep = rebuildEpisodes(store, pid)[0]!.id;
    const h = howBuiltStep(store, pid, ep);
    expect(h.scope).toBe("this step");
    expect(h.stats).toMatchObject({ sessions: 1, prompts: 1, aiEdits: 2, tests: 1, testFailures: 1, notes: 2 });
    expect(h.entries.map((e) => e.text)).toContain("Ran: Run the tests");
    expect(h.entries[0]!.text).toBe("You asked: “Add a CSV parser and a docs page”");
  });

  it("narrows a component page to its folder, and covers everything for project pages", () => {
    const src = howBuiltPage(store, pid, "component:src");
    expect(src.scope).toBe("files under src/");
    expect(src.stats).toMatchObject({ aiEdits: 1, commits: 1, notes: 1, prompts: 1, tests: 0 });
    expect(src.entries.map((e) => e.kind)).toEqual(["prompt", "note", "commit"]);
    const all = howBuiltPage(store, pid, "overview");
    expect(all.stats).toMatchObject({ aiEdits: 2, commits: 2, notes: 2, tests: 1, testFailures: 1, sessions: 1 });
    expect(howBuiltLine(all)).toBe("Across the whole project: 1 Claude Code session, 1 request from the owner, 2 AI edits, 1 test run (1 failed), 2 commits, 2 notes from the AI. Counted from captured events, not written by AI.");
  });

  it("puts both sections in the exported guide", () => {
    recordGenerated(store, pid, "wiki", "overview", { title: "Overview", summary: "s", sections: [{ heading: "H", claims: [] }], uncertainty: [],
      learn: [{ concept: "Dependency-free modules", explanation: "Code with no outside packages is easier to move." }] }, { sources: [] });
    const md = exportGuideMarkdown(store, pid).markdown;
    expect(md).toContain("### What you can learn here");
    expect(md).toContain("- **Dependency-free modules** — Code with no outside packages is easier to move.");
    expect(md).toContain("### How the AI built this");
  });
});

describe("episodes stay current", () => {
  it("are rebuilt when new events arrive, without anyone asking", () => {
    const before = loadEpisodes(store, pid).length;
    store.ingest(pid, { sessions: [], artifacts: [], gaps: [], links: [], events: [
      ev("u9", "prompt_submitted", 3_600, { text: "Now add a JSON exporter" }, { actor: "user", summary: "Now add a JSON exporter" }),
      ev("tool:w9", "tool_invoked", 3_605, { tool: "Write", input: { file_path: "/p/src/json.ts" } }),
    ] });
    const after = loadEpisodes(store, pid);
    expect(after.length).toBe(before + 1);
    expect(after[after.length - 1]!.title).toBe("Now add a JSON exporter");
  });
});
