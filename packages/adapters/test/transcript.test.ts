import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Store } from "@dena/core";
import { encodeProjectDir, importTranscript, isTestCommand, testOutcome } from "../src/claude-code/transcript.ts";

describe("isTestCommand", () => {
  it("recognises real test runs", () => {
    for (const c of ["npx vitest run", "cd app && npm test", "CI=1 pnpm test:unit", "python -m pytest -q", "go test ./...", "node --test"])
      expect(isTestCommand(c), c).toBe(true);
  });
  it("ignores scripts that only mention tests (cases seen in real transcripts)", () => {
    for (const c of [
      "cd /p && cat >> tests/app.test.js <<'EOF'\ntest('x', () => {})\nEOF",
      "python3 - <<'EOF'\np='tests/worklens.test.js'\nprint('npm test')\nEOF",
      'echo "run npx vitest later"',
      "pkill -f electron; ls tests",
    ])
      expect(isTestCommand(c), c).toBe(false);
  });
});

describe("testOutcome", () => {
  it("prefers the runner's own summary", () => {
    expect(testOutcome("npm test | grep pass", "# pass 12\n# fail 0", false, false)).toMatchObject({ outcome: "passed", passed: 12, failed: 0 });
    expect(testOutcome("npx vitest run", " Tests  2 failed | 31 passed (33)", true, false)).toMatchObject({ outcome: "failed", failed: 2 });
  });
  it("uses exit status only for a lone test command", () => {
    expect(testOutcome("cd app && npx vitest run", "", true, false)).toMatchObject({ outcome: "failed", basis: "exit status of the test command" });
  });
  it("says unknown when the exit status belongs to another command", () => {
    expect(testOutcome('npm test 2>&1 | grep -E "^not ok"', "", false, false).outcome).toBe("unknown");
    expect(testOutcome("npx vite build && npm test; git diff --stat", "", false, false).outcome).toBe("unknown");
  });
});

/** Builds a synthetic transcript shaped like the records observed in real Claude Code JSONL files. */
function fixture(root: string): string {
  let n = 0;
  const S = "sess-1";
  const t = () => new Date(Date.UTC(2026, 9, 1, 10, 0, n++)).toISOString();
  const rec = (o: Record<string, unknown>) => ({ sessionId: S, cwd: root, gitBranch: "main", version: "2.1.300", timestamp: t(), ...o });
  const user = (uuid: string, parent: string | null, content: unknown, extra = {}) =>
    rec({ type: "user", uuid, parentUuid: parent, isSidechain: false, message: { role: "user", content }, ...extra });
  const asst = (uuid: string, parent: string, content: unknown[], extra = {}) =>
    rec({ type: "assistant", uuid, parentUuid: parent, isSidechain: false,
      message: { role: "assistant", model: "claude-opus-5-5", content }, ...extra });
  const result = (uuid: string, parent: string, id: string, text: string, isError: boolean, tur: unknown) =>
    user(uuid, parent, [{ type: "tool_result", tool_use_id: id, content: text, is_error: isError }], { toolUseResult: tur });

  const lines = [
    { type: "file-history-snapshot", messageId: "x", snapshot: {} },
    user("u1", null, "Add an add() function with tests. My key is sk-ant-api03-" + "z".repeat(40)),
    asst("a1", "u1", [
      { type: "thinking", thinking: "private reasoning" },
      { type: "text", text: "I'll create math.ts and a test." },
      { type: "tool_use", id: "t1", name: "Write", input: { file_path: `${root}/src/math.ts`, content: "export const add = (a, b) => a - b;\n" } },
    ]),
    result("u2", "a1", "t1", "File created", false, { type: "create", filePath: `${root}/src/math.ts`, content: "...", structuredPatch: [] }),
    asst("a2", "u2", [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "npx vitest run", description: "Run tests" } }]),
    result("u3", "a2", "t2", "FAIL expected 3 got -1", true, { stdout: "FAIL expected 3 got -1", stderr: "", interrupted: false }),
    asst("a3", "u3", [{ type: "tool_use", id: "t3", name: "Edit",
      input: { file_path: `${root}/src/math.ts`, old_string: "a - b", new_string: "a + b" } }]),
    result("u4", "a3", "t3", "Edited", false, { filePath: `${root}/src/math.ts`, oldString: "a - b", newString: "a + b", userModified: false,
      structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
        lines: ["-export const add = (a, b) => a - b;", "+export const add = (a, b) => a + b;"] }] }),
    asst("a4", "u4", [{ type: "tool_use", id: "t4", name: "Bash", input: { command: "npx vitest run" } }]),
    result("u5", "a4", "t4", "1 passed", false, { stdout: "1 passed", stderr: "", interrupted: false }),
    asst("a5", "u5", [{ type: "tool_use", id: "t5", name: "Edit",
      input: { file_path: `${root}/.env`, old_string: "A=1", new_string: "API_KEY=supersecretvalue" } }]),
    result("u6", "a5", "t5", "Edited", false, { filePath: `${root}/.env`,
      structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-A=1", "+API_KEY=supersecretvalue"] }] }),
    user("u7", "u6", "<local-command-stdout>Set model</local-command-stdout>"),
    user("u8", "u7", "Now explain it"),
    { ...asst("s1", "u8", [{ type: "text", text: "subagent reply" }]), isSidechain: true },
    asst("a6", "u8", [{ type: "tool_use", id: "t6", name: "Bash", input: { command: "sleep 100" } }]),
    rec({ type: "system", subtype: "compact_boundary", uuid: "sys1", parentUuid: "a6" }),
    rec({ type: "brand-new-record-type", uuid: "z1" }),
    "{not json",
  ];
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dena-fx-")), `${S}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
  return file;
}

const root = "/work/demo";
let file: string;
let result: Awaited<ReturnType<typeof importTranscript>>;

beforeAll(async () => {
  file = fixture(root);
  result = await importTranscript(file, root);
});
afterAll(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));

const bySid = (sid: string) => result.batch.events.find((e) => e.sourceEventId === sid)!;

describe("Claude Code transcript import", () => {
  it("encodes project dirs the way Claude Code does", () => {
    expect(encodeProjectDir("/Users/a/Claude/Projects/Rogue Radio Overlay")).toBe("-Users-a-Claude-Projects-Rogue-Radio-Overlay");
  });

  it("captures prompts as user actions and redacts secrets in them", () => {
    const p = bySid("u1");
    expect(p).toMatchObject({ eventType: "prompt_submitted", actor: "user" });
    expect(JSON.stringify(p.payload)).not.toContain("zzzzzzzz");
    expect(JSON.stringify(p.payload)).toContain("[REDACTED:anthropic_key]");
  });

  it("never stores thinking blocks", () => {
    expect(JSON.stringify(result.batch)).not.toContain("private reasoning");
    expect(result.report.thinkingBlocksSkipped).toBe(1);
  });

  it("records file changes from tool results as observed AI edits with diffs", () => {
    expect(bySid("file:t1")).toMatchObject({ eventType: "file_created", actor: "ai_agent", payload: { file: "src/math.ts" } });
    const mod = bySid("file:t3");
    expect(mod).toMatchObject({ eventType: "file_modified", captureConfidence: "observed", payload: { linesAdded: 1, linesRemoved: 1 } });
    const diff = result.batch.artifacts.find((a) => a.sourceEventId === "file:t3" && a.role === "diff");
    expect(diff?.content).toContain("+export const add = (a, b) => a + b;");
    expect(result.batch.links).toContainEqual(expect.objectContaining({ fromSourceEventId: "file:t3", toSourceEventId: "tool:t3", linkType: "modified_file", strength: "observed" }));
  });

  it("classifies test runs and derives the outcome from exit status", () => {
    expect(bySid("result:t2")).toMatchObject({ eventType: "test_result", captureConfidence: "derived", payload: { outcome: "failed" } });
    expect(bySid("result:t4")).toMatchObject({ eventType: "test_result", payload: { outcome: "passed" } });
  });

  it("links activity to the prompt that started it and results to their calls", () => {
    expect(result.batch.links).toContainEqual(expect.objectContaining({ fromSourceEventId: "result:t4", toSourceEventId: "u1", linkType: "in_response_to" }));
    expect(result.batch.links).toContainEqual(expect.objectContaining({ fromSourceEventId: "result:t2", toSourceEventId: "tool:t2", linkType: "result_of" }));
  });

  it("withholds contents of sensitive files but keeps that the change happened", () => {
    expect(bySid("file:t5")).toMatchObject({ eventType: "file_modified", payload: { file: ".env", contentWithheld: true } });
    expect(JSON.stringify(result.batch)).not.toContain("supersecretvalue");
    expect(result.report.sensitiveFilesWithheld).toBe(1);
  });

  it("separates harness messages and subagent messages from the human", () => {
    expect(bySid("u7")).toMatchObject({ eventType: "session_marker", actor: "automated_tool" });
    expect(bySid("u8")).toMatchObject({ eventType: "prompt_submitted", actor: "user" });
    expect(bySid("s1:text:0").payload).toMatchObject({ sidechain: true });
  });

  it("reports gaps and unknowns instead of guessing", () => {
    expect(result.report.unresolvedToolCalls).toBe(1);
    expect(result.batch.gaps.some((g) => g.reason.includes("tool:t6"))).toBe(true);
    expect(result.batch.gaps.some((g) => g.reason.includes("outside Claude Code"))).toBe(true);
    expect(result.report.ignoredRecordTypes).toMatchObject({ "brand-new-record-type": 1, "file-history-snapshot": 1 });
    expect(result.report.unparseable).toBe(1);
  });

  it("round-trips through the store idempotently", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "dena-int-"));
    const store = new Store(home);
    const p = store.createProject("demo", root);
    const first = store.ingest(p.id, result.batch);
    const second = store.ingest(p.id, result.batch);
    expect(first.eventsInserted).toBe(result.batch.events.length);
    expect(second.eventsInserted).toBe(0);
    expect(store.stats(p.id).links).toBe(first.linksInserted);
    store.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
});
