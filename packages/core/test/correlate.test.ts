import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { correlate, Store, type NewEvent } from "../src/index.ts";

let home: string;
let store: Store;
let pid: string;
const at = (s: number) => new Date(Date.UTC(2026, 9, 1, 12, 0, s)).toISOString();
const ev = (source: string, sid: string, eventType: NewEvent["eventType"], s: number, payload: Record<string, unknown>): NewEvent => ({
  sessionId: null, source, sourceEventId: sid, eventType, occurredAt: at(s), actor: "unknown", summary: sid, payload, captureConfidence: "observed",
});
const idOf = (sid: string) => store.timeline(pid).find((e) => e.sourceEventId === sid)!.id;
const link = (from: string, type: string) => store.linksFor(idOf(from)).find((l) => l.direction === "out" && l.linkType === type);

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "dena-cor-"));
  store = new Store(home);
  pid = store.createProject("c", "/c").id;
  const cc = "claude_code.transcript";
  store.ingest(pid, {
    sessions: [], artifacts: [], links: [], gaps: [],
    events: [
      // Agent Edit result + watcher saw the same change
      ev(cc, "file:e1", "file_modified", 10, { file: "src/a.ts" }),
      ev("fs", "fs-a", "file_modified", 11, { file: "src/a.ts" }),
      // A Bash heredoc rewrote src/b.ts while running; another file changed during it without being named
      ev(cc, "tool:b1", "tool_invoked", 20, { tool: "Bash", input: { command: "python3 - <<'EOF'\nopen('src/b.ts','w')\nEOF" } }),
      ev("fs", "fs-b", "file_modified", 22, { file: "src/b.ts" }),
      ev("fs", "fs-c", "file_modified", 22, { file: "README.md" }),
      ev(cc, "result:b1", "command_executed", 23, { tool: "Bash", status: "ok" }),
      // A change long after any command: no command link
      ev("fs", "fs-late", "file_modified", 200, { file: "src/b.ts" }),
      // Agent commits
      ev(cc, "tool:g1", "tool_invoked", 300, { tool: "Bash", input: { command: 'git add -A && git commit -m "fix"' } }),
      ev("git", "commit:abc", "git_commit", 301, { files: [{ path: "src/a.ts" }, { path: "src/b.ts" }] }),
      ev(cc, "result:g1", "command_executed", 302, { tool: "Bash", status: "ok" }),
    ],
  });
});
afterEach(() => {
  store.close();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("correlate", () => {
  it("links sources with labeled, non-causal strengths and never touches actors", () => {
    const r = correlate(store, pid);
    expect(link("fs-a", "same_change")).toMatchObject({ strength: "inferred" });
    expect(link("fs-b", "changed_during")).toMatchObject({ strength: "inferred" }); // command names the file
    expect(link("fs-c", "changed_during")).toMatchObject({ strength: "weak" }); // overlap only
    expect(link("fs-late", "changed_during")).toBeUndefined();
    expect(link("tool:g1", "created_commit")).toMatchObject({ strength: "inferred" });
    expect(link("fs-late", "committed_in")).toMatchObject({ otherId: idOf("commit:abc") });
    expect(link("file:e1", "committed_in")).toBeDefined();
    expect(link("fs-c", "committed_in")).toBeUndefined(); // README not in the commit
    expect(r.createdCommit).toBe(1);
    expect(store.timeline(pid).every((e) => e.actor === "unknown")).toBe(true);
  });

  it("is idempotent", () => {
    correlate(store, pid);
    const before = store.stats(pid).links;
    correlate(store, pid);
    expect(store.stats(pid).links).toBe(before);
  });
});
