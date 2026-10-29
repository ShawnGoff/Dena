import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "@dena/core";
import { FsCapture } from "../src/fs/watcher.ts";

let home: string;
let root: string;
let store: Store;
let projectId: string;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const write = (f: string, s: string) => {
  fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
  fs.writeFileSync(path.join(root, f), s);
};
const fileEvents = () => store.timeline(projectId).filter((e) => e.source === "fs");

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "dena-fsh-"));
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dena-fsr-")));
  store = new Store(home);
  projectId = store.createProject("w", root).id;
  write("src/app.ts", "const a = 1;\n");
  write("node_modules/x/index.js", "junk\n");
});
afterEach(() => {
  store.close();
  for (const d of [home, root]) fs.rmSync(d, { recursive: true, force: true });
});

describe("FsCapture", () => {
  it("takes a silent baseline on first scan", () => {
    const cap = new FsCapture(store, projectId, root);
    expect(cap.scan()).toEqual({ baseline: true, changes: 0 });
    expect(fileEvents()).toHaveLength(0);
    expect(store.fsState(projectId).has("src/app.ts")).toBe(true);
    expect(store.fsState(projectId).has("node_modules/x/index.js")).toBe(false);
  });

  it("detects changes made while not recording and labels them", () => {
    new FsCapture(store, projectId, root).scan();
    write("src/app.ts", "const a = 2;\n");
    write("src/new.ts", "export {};\n");
    fs.rmSync(path.join(root, "src/app.ts"));
    write("src/app.ts", "const a = 3;\nconst b = 4;\n");
    fs.utimesSync(path.join(root, "src/app.ts"), new Date(), new Date(Date.now() + 5000));
    const r = new FsCapture(store, projectId, root).scan();
    expect(r.changes).toBe(2);
    const ev = fileEvents();
    const mod = ev.find((e) => e.eventType === "file_modified")!;
    expect(mod).toMatchObject({ actor: "unknown", captureConfidence: "partial", payload: { detectedBy: "startup_scan", linesAdded: 2, linesRemoved: 1 } });
    expect(mod.summary).toContain("while not recording");
    const diff = store.artifactsFor(mod.id).find((a) => a.role === "diff")!;
    expect(store.blobs.get(diff.contentHash)!.toString()).toContain("+const b = 4;");
    expect(ev.find((e) => e.eventType === "file_created")?.payload).toMatchObject({ file: "src/new.ts" });
  });

  it("watches live changes, collapses rapid saves, skips excluded dirs", async () => {
    const cap = new FsCapture(store, projectId, root, { debounceMs: 150 });
    cap.scan();
    cap.start();
    await sleep(100);
    for (let i = 0; i < 5; i++) {
      write("src/app.ts", `const a = ${10 + i};\n`);
      await sleep(20);
    }
    write("node_modules/x/index.js", "more junk\n");
    await sleep(600);
    cap.stop();
    const ev = fileEvents();
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ eventType: "file_modified", actor: "unknown", captureConfidence: "observed", payload: { file: "src/app.ts", detectedBy: "watcher" } });
  });

  it("ignores saves that do not change content", async () => {
    const cap = new FsCapture(store, projectId, root, { debounceMs: 100 });
    cap.scan();
    cap.start();
    await sleep(100);
    write("src/app.ts", "const a = 1;\n");
    await sleep(400);
    cap.stop();
    expect(fileEvents()).toHaveLength(0);
  });

  it("records sensitive file changes without their contents, and honours user excludes", async () => {
    store.updateProjectSettings(projectId, { exclude: ["generated/"] });
    write(".env", "API_KEY=abcdef123456\n");
    const cap = new FsCapture(store, projectId, root, { debounceMs: 100 });
    cap.scan();
    cap.start();
    await sleep(100);
    write(".env", "API_KEY=zzzzzz999999\n");
    write("generated/out.js", "x\n");
    await sleep(400);
    cap.stop();
    const ev = fileEvents();
    expect(ev.map((e) => e.payload.file)).toEqual([".env"]);
    expect(ev[0]!.payload).toMatchObject({ contentWithheld: true });
    expect(store.artifactsFor(ev[0]!.id)).toHaveLength(0);
    const blobs = fs.readdirSync(path.join(home, "blobs"), { recursive: true }).map(String);
    for (const b of blobs.filter((b) => b.length > 10))
      expect(fs.readFileSync(path.join(home, "blobs", b)).toString()).not.toContain("zzzzzz999999");
  });

  it("respects .gitignore in git repos", async () => {
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["-C", root, "init", "-q"]);
    write(".gitignore", "*.log\n");
    const cap = new FsCapture(store, projectId, root, { debounceMs: 100 });
    cap.scan();
    cap.start();
    await sleep(100);
    write("debug.log", "noise\n");
    write("src/app.ts", "const a = 99;\n");
    await sleep(400);
    cap.stop();
    expect(fileEvents().map((e) => e.payload.file)).toEqual(["src/app.ts"]);
  });
});
