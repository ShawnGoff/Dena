import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { correlate, Store, type NewEvent, type NewLink } from "@dena/core";
import { buildPacket, compactDiff, isReadOnlyCommand, isVersionControlCommand, needsModel, rebuildEpisodes } from "../src/index.ts";

let home: string;
let store: Store;
let pid: string;
const CC = "claude_code.transcript";
const at = (s: number) => new Date(Date.UTC(2026, 9, 1, 12, 0, s)).toISOString();
const ev = (sid: string, eventType: NewEvent["eventType"], s: number, payload: Record<string, unknown>, extra: Partial<NewEvent> = {}): NewEvent => ({
  sessionId: "s1", source: CC, sourceEventId: sid, eventType, occurredAt: at(s), actor: "ai_agent", summary: sid, payload, captureConfidence: "observed", ...extra,
});
const result = (from: string, to: string): NewLink => ({ source: CC, fromSourceEventId: from, toSourceEventId: to, toSource: CC, linkType: "result_of", strength: "observed", basis: "t" });

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "dena-lean-"));
  store = new Store(home);
  pid = store.createProject("p", "/p").id;
});
afterEach(() => {
  store.close();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("telling commands apart", () => {
  it("knows which commands only looked around", () => {
    for (const c of ["git status", "cd /p && grep -n foo src/a.ts | head -5", "sed -n 1,40p src/a.ts", "ls -la && wc -l src/*.ts", "find . -name '*.ts'", "git log --oneline -3", "cat a.ts 2>/dev/null"])
      expect(isReadOnlyCommand(c), c).toBe(true);
    for (const c of ["npm test", "sed -i '' s/a/b/ x.ts", "echo hi > out.txt", "python3 - <<'EOF'\nopen('x','w')\nEOF", "rm -rf dist", "find . -name '*.tmp' -delete", "git commit -m x", "cat a | tee b"])
      expect(isReadOnlyCommand(c), c).toBe(false);
  });
  it("knows which commands only saved work in git, ignoring what a quoted message says", () => {
    expect(isVersionControlCommand('git add -A && git commit -q -m "M5: notes; and\nmore lines && fun"')).toBe(true);
    expect(isVersionControlCommand("git add -A && git commit -q -F - <<'EOF'\nMessage\n\nnpm test && rm -rf x\nEOF\ngit push -q origin main")).toBe(true);
    expect(isVersionControlCommand("git add -A && npm test && git commit -m x")).toBe(false);
  });
});

describe("compact diffs", () => {
  it("keep the changed lines and drop unchanged context and headers", () => {
    const d = ["diff --git a/src/a.ts b/src/a.ts", "index 1..2 100644", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1,7 +1,7 @@ export function f() {",
      " const keep = 1;", "-const a = 1;", "-const b = 2;", "-const c = 3;", "-const d = 4;", "-const e = 5;", "-const f = 6;", "+const sum = 21;", " return keep;"].join("\n");
    expect(compactDiff(d)).toBe(["file src/a.ts", "@@ export function f() {", "-const a = 1;", "-const b = 2;", "-… (4 more lines removed)", "+const sum = 21;"].join("\n"));
  });
});

describe("leaner evidence", () => {
  function ingest(extra: NewEvent[] = [], extraArtifacts: { sourceEventId: string; role: "diff"; artifactType: "diff"; content: string }[] = []) {
    store.ingest(pid, {
      sessions: [{ id: "s1", source: CC, startedAt: at(0), endedAt: at(100) }], gaps: [],
      artifacts: [
        { sourceEventId: "file:w1", role: "diff", artifactType: "diff", content: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@\n context\n-old\n+new\n context" },
        { sourceEventId: "commit:c1", role: "diff", artifactType: "diff", content: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new" },
        ...extraArtifacts,
      ],
      links: [result("result:g1", "tool:g1"), result("result:t1", "tool:t1"),
        { source: CC, fromSourceEventId: "file:w1", toSourceEventId: "tool:w1", toSource: CC, linkType: "modified_file", strength: "observed", basis: "t" }],
      events: [
        ev("u1", "prompt_submitted", 0, { text: "Change old to new" }, { actor: "user" }),
        ev("tool:g1", "tool_invoked", 1, { tool: "Bash", input: { command: "grep -rn old src", description: "Find the old value" } }),
        ev("result:g1", "command_executed", 2, { status: "ok", stdout: "src/a.ts:1:old\n".repeat(40) }),
        ev("tool:h1", "tool_invoked", 3, { tool: "mcp__ccd_turn__update_plan", input: {} }),
        ev("tool:w1", "tool_invoked", 4, { tool: "Edit", input: { file_path: "/p/src/a.ts" } }),
        ev("file:w1", "file_modified", 4, { file: "src/a.ts", tool: "Edit", linesAdded: 1, linesRemoved: 1 }),
        ev("tool:t1", "tool_invoked", 10, { tool: "Bash", input: { command: "npm test" } }),
        ev("result:t1", "test_result", 12, { tool: "Bash", status: "ok", outcome: "passed", testsPassed: 3, testsFailed: 0 }),
        { sessionId: null, source: "git", sourceEventId: "commit:c1", eventType: "git_commit", occurredAt: at(20), actor: "unknown", summary: "c", payload: { sha: "abc1234", message: "Change", files: [{ path: "src/a.ts", added: 1, removed: 1 }] }, captureConfidence: "observed" },
        ...extra,
      ],
    });
    correlate(store, pid);
    return rebuildEpisodes(store, pid)[0]!.id;
  }

  it("folds look-around commands, drops bookkeeping, compacts diffs, and does not repeat a commit's diff", () => {
    const pk = buildPacket(store, pid, ingest(), { depth: "concise" });
    const text = pk.items.map((i) => `${i.kind}: ${i.text}`).join("\n");
    expect(text).toContain("The AI also ran 1 command that only looked around (output not included): Find the old value");
    expect(text).not.toContain("src/a.ts:1:old"); // its output is not sent
    expect(text).not.toContain("update_plan");
    expect(pk.items.find((i) => i.kind === "file_change")!.text).toMatch(/changes:\n@@\n-old\n\+new$/);
    expect(pk.items.find((i) => i.kind === "commit")!.text).toContain("(diff not repeated: these changes are shown in the file changes)");
    expect(pk.items.find((i) => i.kind === "reads")!.eventIds.length).toBeGreaterThan(0); // still citable
    expect(pk.legacyHashes.length).toBe(1); // the fingerprint under the earlier rules, so older explanations stay current
  });

  it("explains work that only saved code in git from the facts, without a model", () => {
    store.ingest(pid, {
      sessions: [{ id: "s1", source: CC, startedAt: at(0), endedAt: at(100) }], gaps: [], artifacts: [], links: [result("result:c1", "tool:c1")],
      events: [
        ev("u1", "prompt_submitted", 0, { text: "Commit, merge, push" }, { actor: "user" }),
        ev("tool:c1", "tool_invoked", 1, { tool: "Bash", input: { command: 'git add -A && git commit -q -m "Done\n\nDetails"' } }),
        ev("result:c1", "command_executed", 2, { status: "ok" }),
        { sessionId: null, source: "git", sourceEventId: "commit:c9", eventType: "git_commit", occurredAt: at(3), actor: "unknown", summary: "c", payload: { sha: "def5678", message: "Done", files: [{ path: "src/a.ts", added: 1, removed: 1 }] }, captureConfidence: "observed" },
      ],
    });
    correlate(store, pid);
    const pk = buildPacket(store, pid, rebuildEpisodes(store, pid)[0]!.id, { depth: "concise" });
    expect(needsModel(pk)).toBe(false);
  });

  it("keeps the most useful evidence when the budget runs out: the request, results, and the latest changes", () => {
    const many: NewEvent[] = [];
    const artifacts = [];
    for (let i = 0; i < 30; i++) {
      many.push(ev(`file:x${i}`, "file_modified", 30 + i, { file: `src/f${i}.ts`, tool: "Edit", linesAdded: 1, linesRemoved: 0 }));
      artifacts.push({ sourceEventId: `file:x${i}`, role: "diff" as const, artifactType: "diff" as const, content: `--- a/src/f${i}.ts\n+++ b/src/f${i}.ts\n@@ -1 +1 @@\n${`+line ${i} `.repeat(80)}` });
    }
    const id = ingest(many, artifacts);
    const pk = buildPacket(store, pid, id, { depth: "concise" });
    expect(pk.chars).toBeLessThanOrEqual(12_500);
    expect(pk.items.some((i) => i.kind === "prompt")).toBe(true);
    expect(pk.items.some((i) => i.kind === "test")).toBe(true);
    const files = pk.items.filter((i) => i.kind === "file_change").map((i) => String(i.facts.file));
    expect(files).toContain("src/f29.ts"); // the latest change survives
    expect(files).not.toContain("src/f0.ts"); // the oldest is what gives way
    expect(pk.truncated).toBe(true);
  });
});
