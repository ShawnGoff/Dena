import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cdTargets, importTranscript } from "../src/claude-code/transcript.ts";

/** A session launched in /p/overlay that wanders into /p/worklens and back. */
function wanderingSession(): string {
  let n = 0;
  const t = () => new Date(Date.UTC(2026, 9, 1, 9, 0, n++)).toISOString();
  const base = { sessionId: "S", cwd: "/p/overlay", isSidechain: false };
  const prompt = (uuid: string, text: string, parent: string | null) =>
    ({ ...base, type: "user", uuid, parentUuid: parent, timestamp: t(), message: { role: "user", content: text } });
  const bash = (uuid: string, parent: string, id: string, command: string) =>
    ({ ...base, type: "assistant", uuid, parentUuid: parent, timestamp: t(),
      message: { role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } });
  const edit = (uuid: string, parent: string, id: string, file: string) =>
    ({ ...base, type: "assistant", uuid, parentUuid: parent, timestamp: t(),
      message: { role: "assistant", content: [{ type: "tool_use", id, name: "Edit", input: { file_path: file, old_string: "a", new_string: "b" } }] } });
  const said = (uuid: string, parent: string, text: string) =>
    ({ ...base, type: "assistant", uuid, parentUuid: parent, timestamp: t(), message: { role: "assistant", content: [{ type: "text", text }] } });

  const lines = [
    // Harness noise before any prompt, with no cwd: no evidence either way, so it must not be kept
    // (and must not make the next unrelated group look like it belongs here).
    { sessionId: "S", type: "user", uuid: "h0", parentUuid: null, timestamp: t(), message: { role: "user", content: "<local-command-stdout>x</local-command-stdout>" } },
    prompt("p1", "Talk about the overlay", null), said("a1", "p1", "Sure"),                        // no paths: launched here -> keep
    prompt("p2", "Fix the worklens tests", "a1"), bash("a2", "p2", "t2", "cd /p/worklens && npm test"), // cd elsewhere -> drop
    prompt("p3", "Why did that fail?", "a2"), said("a3", "p3", "Because..."),                      // no paths: follows p2 -> drop
    prompt("p4", "Back to the overlay CSS", "a3"), edit("a4", "p4", "t4", "/p/overlay/src/app.css"), // file inside -> keep
    prompt("p5", "And a worklens readme tweak", "a4"),
    bash("a5", "p5", "t5", 'cd "/p/overlay" && cat ../worklens/README.md'),                       // cd inside wins -> keep
  ];
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dena-attr-")), "S.jsonl");
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n"));
  return f;
}

describe("cdTargets", () => {
  it("finds cd targets in chained commands", () => {
    expect(cdTargets('cd "/a b/c" && ls; cd /d || cd ~/x')).toEqual(["/a b/c", "/d", path.join(os.homedir(), "x")]);
    expect(cdTargets("echo cd /nope")).toEqual([]);
  });
});

describe("project attribution", () => {
  it("keeps only the prompt groups whose evidence points at the project", async () => {
    const { batch, report } = await importTranscript(wanderingSession(), "/p/overlay");
    const prompts = batch.events.filter((e) => e.eventType === "prompt_submitted").map((e) => e.sourceEventId);
    expect(prompts).toEqual(["p1", "p4", "p5"]);
    expect(report.excludedGroups).toBe(3);
    expect(batch.events.some((e) => e.sourceEventId === "tool:t2")).toBe(false);
    // Links never point at excluded events.
    const ids = new Set(batch.events.map((e) => e.sourceEventId));
    for (const l of batch.links) expect(ids.has(l.toSourceEventId) && ids.has(l.fromSourceEventId)).toBe(true);
  });

  it("finds a project's work inside another project's transcripts", async () => {
    const { batch } = await importTranscript(wanderingSession(), "/p/worklens");
    const prompts = batch.events.filter((e) => e.eventType === "prompt_submitted").map((e) => e.sourceEventId);
    expect(prompts).toEqual(["p2", "p3"]);
    expect(batch.events.some((e) => e.sourceEventId === "h0")).toBe(false);
  });

  it("can be turned off", async () => {
    const { batch } = await importTranscript(wanderingSession(), "/p/overlay", { attribution: "all" });
    expect(batch.events.filter((e) => e.eventType === "prompt_submitted")).toHaveLength(5);
  });
});
