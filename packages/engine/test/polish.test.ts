import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { correlate, likelyAuthors, authorSummary, Store, type NewEvent } from "@dena/core";
import { buildPacket, ClaudeCodeProvider, isStandingLimitationText, packetMatches, rebuildEpisodes, standingLimitations, StoppedError } from "../src/index.ts";

let home: string;
let store: Store;
let pid: string;
const CC = "claude_code.transcript";
const at = (s: number) => new Date(Date.UTC(2026, 9, 1, 12, 0, s)).toISOString();
const ev = (source: string, sid: string, eventType: NewEvent["eventType"], s: number, payload: Record<string, unknown>, extra: Partial<NewEvent> = {}): NewEvent => ({
  sessionId: source === CC ? "s1" : null, source, sourceEventId: sid, eventType, occurredAt: at(s), actor: source === CC ? "ai_agent" : "unknown",
  summary: sid, payload, captureConfidence: "observed", ...extra,
});

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "dena-pol-"));
  store = new Store(home);
  pid = store.createProject("p", "/p").id;
  store.ingest(pid, {
    sessions: [{ id: "s1", source: CC, startedAt: at(0), endedAt: at(400) }], artifacts: [], links: [],
    gaps: [{ sessionId: "s1", source: CC, fromTime: null, toTime: null, reason: "Changes made outside Claude Code (manual edits, other terminals) are not visible to this source" }],
    events: [
      ev(CC, "u1", "prompt_submitted", 0, { text: "rewrite b" }, { actor: "user" }),
      ev(CC, "tool:b1", "tool_invoked", 20, { tool: "Bash", input: { command: "python3 - <<'EOF'\nopen('src/b.ts','w')\nEOF" } }),
      ev("fs", "fs-b", "file_modified", 22, { file: "src/b.ts" }),
      ev("fs", "fs-c", "file_modified", 22, { file: "README.md" }),
      ev(CC, "result:b1", "command_executed", 23, { tool: "Bash", status: "ok" }),
      ev("fs", "fs-late", "file_modified", 300, { file: "notes.txt" }),
    ],
  });
  correlate(store, pid);
  rebuildEpisodes(store, pid);
});
afterEach(() => {
  store.close();
  fs.rmSync(home, { recursive: true, force: true });
});

const idOf = (sid: string) => store.timeline(pid).find((e) => e.sourceEventId === sid)!.id;

describe("likely author", () => {
  it("reads it from recorded connections, with honest confidence, and leaves the event's actor alone", () => {
    const m = likelyAuthors(store, pid);
    expect(m.get(idOf("fs-b"))).toMatchObject({ confidence: "likely" }); // the command names the file
    expect(m.get(idOf("fs-c"))).toMatchObject({ confidence: "possibly" }); // only overlapped in time
    expect(m.has(idOf("fs-late"))).toBe(false); // nothing connects it
    expect(store.timeline(pid).find((e) => e.sourceEventId === "fs-b")!.actor).toBe("unknown");
    expect(authorSummary(store, pid)).toEqual({ unknown: 3, likelyAi: 1, possiblyAi: 1, unclear: 1 });
  });
});

describe("standing limitations", () => {
  it("are left out of packets, stated once, and do not make earlier explanations outdated", () => {
    const ep = rebuildEpisodes(store, pid)[0]!.id;
    const p = buildPacket(store, pid, ep);
    expect(p.items.some((i) => i.kind === "gap")).toBe(false);
    expect(p.legacyHashes).toHaveLength(1); // the fingerprint this evidence had when the limitation was included
    expect(packetMatches(p, p.legacyHashes[0])).toBe(true);
    expect(packetMatches(p, "something-else")).toBe(false);
    expect(standingLimitations(store, pid)).toEqual(["Changes made outside Claude Code (manual edits, other terminals) are not visible to this source"]);
  });
  it("recognises the boilerplate in text written before", () => {
    expect(isStandingLimitationText("Changes made outside Claude Code would not have been captured (E2).")).toBe(true);
    expect(isStandingLimitationText("The test output was truncated, so the failing assertion is not shown.")).toBe(false);
  });
});

describe("stopping a generation", () => {
  it("ends the model process itself, quickly, and saves nothing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dena-fakeclaude-"));
    const bin = path.join(dir, "claude");
    fs.writeFileSync(bin, "#!/bin/sh\nsleep 10\necho '{}'\n", { mode: 0o755 }); // a "model" that would take 10 seconds
    const provider = new ClaudeCodeProvider(bin);
    const controller = new AbortController();
    const started = Date.now();
    const call = provider.generate("s", "u", {}, { signal: controller.signal });
    setTimeout(() => controller.abort(), 150);
    await expect(call).rejects.toBeInstanceOf(StoppedError);
    expect(Date.now() - started).toBeLessThan(3_000);
    // The whole process group is gone, including the `sleep` the script started.
    await new Promise((r) => setTimeout(r, 300));
    const { execSync } = await import("node:child_process");
    expect(execSync(`ps -axo command | grep -c "[s]leep 10" || true`, { encoding: "utf8" }).trim()).toBe("0");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
