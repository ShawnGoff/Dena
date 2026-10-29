import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { correlate, Store, type NewEvent, type NewLink } from "@dena/core";
import { buildActivityLog, DEFAULT_KINDS, renderActivityMarkdown } from "../src/index.ts";

let home: string;
let store: Store;
let pid: string;
const CC = "claude_code.transcript";
const at = (s: number) => new Date(Date.UTC(2026, 9, 1, 12, 0, s)).toISOString();
const ev = (source: string, sid: string, eventType: NewEvent["eventType"], s: number, payload: Record<string, unknown>, extra: Partial<NewEvent> = {}): NewEvent => ({
  sessionId: source.startsWith("claude_code") ? "s1" : null, source, sourceEventId: sid, eventType, occurredAt: at(s),
  actor: source === CC ? "ai_agent" : source === "claude_code.hooks" ? "automated_tool" : "unknown", summary: sid, payload, captureConfidence: "observed", ...extra,
});
const res = (from: string, to: string, toSource = CC): NewLink => ({ source: from.startsWith("hook:") ? "claude_code.hooks" : CC, fromSourceEventId: from, toSourceEventId: to, toSource, linkType: "result_of", strength: "observed", basis: "t" });

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "dena-act-"));
  store = new Store(home);
  pid = store.createProject("p", "/p").id;
  store.ingest(pid, {
    sessions: [{ id: "s1", source: CC, startedAt: at(0), endedAt: at(100) }], artifacts: [], gaps: [],
    events: [
      ev(CC, "u1", "prompt_submitted", 0, { text: "Add a parser" }, { actor: "user" }),
      ev(CC, "tool:r1", "tool_invoked", 1, { tool: "Read", input: { file_path: "/p/src/a.ts" } }),
      ev(CC, "tool:r2", "tool_invoked", 2, { tool: "Read", input: { file_path: "/p/src/b.ts" } }),
      ev(CC, "tool:h1", "tool_invoked", 3, { tool: "mcp__ccd_turn__update_plan", input: {} }),
      ev(CC, "tool:w1", "tool_invoked", 4, { tool: "Write", input: { file_path: "/p/src/csv.ts" } }),
      ev(CC, "file:w1", "file_created", 4, { file: "src/csv.ts", tool: "Write" }),
      ev(CC, "tool:t1", "tool_invoked", 10, { tool: "Bash", input: { command: "npm test && git commit -am x", description: "Run tests and commit" } }),
      ev(CC, "result:t1", "test_result", 12, { tool: "Bash", status: "ok", outcome: "passed", testsPassed: 3, testsFailed: 0 }),
      ev("claude_code.hooks", "hook:PostToolUse:t1", "tool_completed", 12, { durationMs: 2400 }),
      ev("git", "commit:abc", "git_commit", 11, { sha: "abc1234def", message: "Add parser", files: [{ path: "src/csv.ts" }] }),
      ev(CC, "tool:n1", "tool_invoked", 20, { tool: "Bash", input: { command: "node /x/dena-hook.mjs note decision <<'NOTE'\nKept it simple\nNOTE" } }),
      ev(CC, "note:n1", "agent_note", 20, { kind: "decision", text: "Kept it simple" }),
      ev(CC, "a1:text:0", "ai_response_received", 30, { text: "Done." }),
    ],
    links: [
      { source: CC, fromSourceEventId: "file:w1", toSourceEventId: "tool:w1", linkType: "modified_file", strength: "observed", basis: "t" },
      res("result:t1", "tool:t1"), res("hook:PostToolUse:t1", "tool:t1"),
    ],
  });
  correlate(store, pid); // links the commit to the command that ran `git commit`
});
afterEach(() => {
  store.close();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("activity log", () => {
  it("tells what the AI did in plain language, folding small actions and keeping the evidence", () => {
    const [s] = buildActivityLog(store, pid);
    const shown = s!.entries.filter((x) => DEFAULT_KINDS.includes(x.kind));
    expect(shown.map((x) => x.text)).toEqual([
      "You asked: “Add a parser”",
      "Read and searched the code (2 times)",
      "Created src/csv.ts",
      "Ran: Run tests and commit",
      "Noted (decision): Kept it simple",
    ]);
    const run = shown.find((x) => x.text === "Ran: Run tests and commit")!;
    expect(run).toMatchObject({ kind: "commit", status: "ok" });
    expect(run.detail).toBe("tests: 3 passed, 0 failed · committed abc1234 “Add parser” · 2.4 s");
    expect(run.eventIds.length).toBeGreaterThanOrEqual(4); // call, result, hook timing, commit
    expect(shown.find((x) => x.text.startsWith("Read"))!.detail).toBe("a.ts, b.ts");
    // Replies and bookkeeping exist but are hidden by default.
    expect(s!.entries.some((x) => x.kind === "housekeeping")).toBe(true);
    expect(s!.entries.some((x) => x.kind === "reply")).toBe(true);
    expect(s!.stats).toMatchObject({ prompts: 1, edits: 1, commits: 1, notes: 1 });
  });

  it("renders a session as Markdown that says no AI wrote it", () => {
    const md = renderActivityMarkdown("p", buildActivityLog(store, pid)[0]!);
    expect(md).toContain("no AI involved in writing this log");
    expect(md).toContain("**AI** — Ran: Run tests and commit *(tests: 3 passed");
    expect(md).not.toContain("Replied:");
  });
});
