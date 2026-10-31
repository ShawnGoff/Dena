import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { foldersUsedWithClaude, isWorkFolder } from "../src/claude-code/discover.ts";

let claudeHome: string;
const session = (dir: string, file: string, cwd: string, mtime: Date) => {
  const d = path.join(claudeHome, "projects", dir);
  fs.mkdirSync(d, { recursive: true });
  const f = path.join(d, file);
  fs.writeFileSync(f, [JSON.stringify({ type: "custom-title" }), JSON.stringify({ type: "user", cwd, message: { content: "hi" } })].join("\n"));
  fs.utimesSync(f, mtime, mtime);
};

beforeEach(() => {
  claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), "dena-claudehome-"));
});
afterEach(() => fs.rmSync(claudeHome, { recursive: true, force: true }));

describe("folders used with Claude Code", () => {
  it("finds where sessions ran, newest first, counting sessions", () => {
    session("-Users-me-app", "a.jsonl", "/Users/me/app", new Date("2026-10-01"));
    session("-Users-me-app", "b.jsonl", "/Users/me/app", new Date("2026-10-03"));
    session("-Users-me-site", "c.jsonl", "/Users/me/site", new Date("2026-10-02"));
    const f = foldersUsedWithClaude(claudeHome);
    expect(f.map((x) => [x.path, x.sessions])).toEqual([["/Users/me/app", 2], ["/Users/me/site", 1]]);
    expect(f[0]!.firstSeen.slice(0, 10)).toBe("2026-10-01");
  });
  it("does not treat temporary or app folders, or home itself, as projects", () => {
    for (const d of ["/private/tmp/x", "/tmp/y", "/Users/me/Library/Application Support/Claude/scratch", "/Users/me/.claude/z", os.homedir()]) expect(isWorkFolder(d), d).toBe(false);
    expect(isWorkFolder(path.join(os.homedir(), "code", "app"))).toBe(true);
  });
});
