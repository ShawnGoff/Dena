import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { importGit, isGitRepo, parseNumstat } from "../src/git/git.ts";

let repo: string;
const sh = (...args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "Dev", GIT_AUTHOR_EMAIL: "d@x", GIT_COMMITTER_NAME: "Dev", GIT_COMMITTER_EMAIL: "d@x" },
  });
const write = (f: string, s: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
  fs.writeFileSync(path.join(repo, f), s);
};

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "dena-git-"));
  sh("init", "-q", "-b", "main");
  write("src/a.ts", "export const a = 1;\n");
  write("package-lock.json", "{}\n");
  sh("add", "-A");
  sh("commit", "-q", "-m", "first");
  sh("switch", "-q", "-c", "feature");
  write("src/a.ts", "export const a = 2;\nconst token = \"sk-ant-api03-" + "q".repeat(40) + "\";\n");
  write(".env", "SECRET=abc12345678\n");
  sh("add", "-A");
  sh("commit", "-q", "-m", "change a\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>");
  sh("mv", "src/a.ts", "src/b.ts");
  sh("commit", "-q", "-m", "rename");
  sh("switch", "-q", "main");
});
afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

describe("parseNumstat", () => {
  it("handles plain, binary and rename lines", () => {
    expect(parseNumstat("3\t1\tsrc/x.ts")).toEqual({ path: "src/x.ts", added: 3, removed: 1 });
    expect(parseNumstat("-\t-\timg.png")).toEqual({ path: "img.png", added: null, removed: null });
    expect(parseNumstat("0\t0\tsrc/{a.ts => b.ts}")).toMatchObject({ path: "src/b.ts", previousPath: "src/a.ts" });
    expect(parseNumstat("1\t0\told.md => new.md")).toMatchObject({ path: "new.md", previousPath: "old.md" });
  });
});

describe("importGit", () => {
  it("returns nothing for a non-repo", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dena-nogit-"));
    expect(isGitRepo(dir)).toBe(false);
    expect(importGit(dir).batch.events).toHaveLength(0);
  });

  it("imports commits from all branches with files, diffs and honest attribution", () => {
    const { batch, report } = importGit(repo);
    const commits = batch.events.filter((e) => e.eventType === "git_commit");
    expect(commits).toHaveLength(3);
    expect(report.commits).toBe(3);
    for (const c of commits) expect(c.actor).toBe("unknown");

    const change = commits.find((c) => c.summary.includes("change a"))!;
    expect(change.payload).toMatchObject({ aiCoAuthorTrailer: true });
    const files = change.payload.files as { path: string; contentWithheld?: boolean }[];
    expect(files.find((f) => f.path === ".env")?.contentWithheld).toBe(true);

    const diff = batch.artifacts.find((a) => a.sourceEventId === change.sourceEventId)!.content;
    expect(diff).toContain("+export const a = 2;");
    expect(diff).not.toContain("abc12345678"); // .env excluded from the patch
    expect(diff).not.toContain("qqqqqqqq"); // secret in code redacted
    expect(report.filesWithheld).toBe(1);

    const rename = commits.find((c) => c.summary.includes("rename"))!;
    expect((rename.payload.files as any[])[0]).toMatchObject({ path: "src/b.ts", previousPath: "src/a.ts" });

    const first = commits.find((c) => c.summary.includes("first"))!;
    const firstDiff = batch.artifacts.find((a) => a.sourceEventId === first.sourceEventId)!.content;
    expect(firstDiff).not.toContain("package-lock.json"); // lockfile noise left out of the patch
  });

  it("records branch switches from the reflog", () => {
    const switches = importGit(repo).batch.events.filter((e) => e.eventType === "branch_changed");
    expect(switches.map((s) => s.summary)).toEqual(expect.arrayContaining(["Switched branch main → feature", "Switched branch feature → main"]));
  });

  it("is stable across re-imports", () => {
    const a = importGit(repo).batch.events.map((e) => e.sourceEventId).sort();
    const b = importGit(repo).batch.events.map((e) => e.sourceEventId).sort();
    expect(a).toEqual(b);
  });
});
