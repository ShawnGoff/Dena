import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "@dena/core";
import { FsCapture } from "../src/fs/watcher.ts";
import { addPausedWindow, Recorder, withoutPaused } from "../src/recorder.ts";

let home: string;
let root: string;
let claudeHome: string;
let store: Store;
let pid: string;
const write = (f: string, s: string) => {
  fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
  fs.writeFileSync(path.join(root, f), s);
};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "dena-pause-"));
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dena-pause-root-")));
  claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), "dena-noclaude-")); // keep away from real transcripts
  store = new Store(home);
  pid = store.createProject("p", root).id;
  write("src/a.ts", "const a = 1;\n");
});
afterEach(() => {
  store.close();
  for (const d of [home, root, claudeHome]) fs.rmSync(d, { recursive: true, force: true });
});

const ev = (id: string, at: string) => ({ sessionId: null, source: "t", sourceEventId: id, eventType: "prompt_submitted" as const, occurredAt: at, actor: "user" as const, summary: id, payload: {}, captureConfidence: "observed" as const });

describe("pausing is private", () => {
  it("leaves out anything stamped inside a paused window, with its links and attachments", () => {
    addPausedWindow(store, pid, { from: "2026-10-01T10:00:00Z", to: "2026-10-01T11:00:00Z" });
    const batch = withoutPaused(store, pid, {
      events: [ev("before", "2026-10-01T09:59:00Z"), ev("during", "2026-10-01T10:30:00Z"), ev("after", "2026-10-01T11:01:00Z")],
      links: [{ fromSourceEventId: "during", toSourceEventId: "before" }, { fromSourceEventId: "after", toSourceEventId: "before" }],
      artifacts: [{ sourceEventId: "during" }, { sourceEventId: "after" }],
    });
    expect(batch.events.map((e) => e.sourceEventId)).toEqual(["before", "after"]);
    expect(batch.links).toEqual([{ fromSourceEventId: "after", toSourceEventId: "before" }]);
    expect(batch.artifacts).toEqual([{ sourceEventId: "after" }]);
  });

  it("after a pause, takes the folder as it is without recording what changed meanwhile", () => {
    const cap = new FsCapture(store, pid, root);
    cap.scan(); // baseline
    write("src/a.ts", "const secret = 2;\n");
    write("src/b.ts", "new\n");
    expect(cap.scan({ quiet: true }).baseline).toBe(true);
    expect(store.timeline(pid).filter((e) => e.source === "fs")).toHaveLength(0);
    write("src/a.ts", "const a = 3;\n"); // a change after resuming is recorded as usual
    expect(new FsCapture(store, pid, root).scan().changes).toBe(1);
  });
});

describe("catching up after a stop", () => {
  it("records what was recovered, and a pause left open by quitting stays private", async () => {
    const rec = new Recorder(store, pid, { claudeHome, pollMs: 60_000 });
    await rec.start();
    await rec.stop();
    write("src/a.ts", "const a = 2;\n"); // changed while Dena was off
    const again = new Recorder(store, pid, { claudeHome, pollMs: 60_000 });
    await again.start();
    const c = JSON.parse(store.getCursor(pid, "dena", "last_catch_up")!);
    expect(c).toMatchObject({ fileChanges: 1, commits: 0, conversations: 0 });
    // Quit while paused: the next start treats the open pause as private, not as time to catch up.
    store.setRecordingState(pid, "paused");
    store.setCursor(pid, "dena", "paused_at", new Date(Date.now() - 1_000).toISOString());
    await again.stop();
    write("src/a.ts", "const a = 3;\n");
    store.setCursor(pid, "dena", "paused_at", new Date(Date.now() - 500).toISOString());
    const third = new Recorder(store, pid, { claudeHome, pollMs: 60_000 });
    await third.start();
    expect(store.timeline(pid).filter((e) => e.source === "fs")).toHaveLength(1); // only the change from while it was off, not the paused one
    await third.stop();
  });
});
