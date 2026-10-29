import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { correlate, Store, type IngestBatch, type NewEvent } from "@dena/core";
import {
  buildEpisodes, buildPacket, explainEpisode, rebuildEpisodes, renderPacket, renderStep, validateStep,
  type GenerateResult, type Provider, type Step,
} from "../src/index.ts";

let home: string;
let store: Store;
let pid: string;
const CC = "claude_code.transcript";
const at = (m: number) => new Date(Date.UTC(2026, 9, 1, 10, m)).toISOString();
const ev = (source: string, sid: string, eventType: NewEvent["eventType"], m: number, payload: Record<string, unknown>, extra: Partial<NewEvent> = {}): NewEvent => ({
  sessionId: source === CC ? "s1" : null, source, sourceEventId: sid, eventType, occurredAt: at(m),
  actor: source === CC ? "ai_agent" : "unknown", summary: String(payload.summary ?? sid), payload, captureConfidence: "observed", ...extra,
});

/** Two episodes: build a parser (fails a test, gets fixed, commits), then a question with no changes plus a later tweak. */
function seed() {
  const batch: IngestBatch = {
    sessions: [{ id: "s1", source: CC, startedAt: at(0), endedAt: at(200) }],
    events: [
      ev(CC, "u1", "prompt_submitted", 0, { text: "Add a CSV parser with tests" }, { actor: "user", summary: "Add a CSV parser with tests" }),
      ev(CC, "tool:w1", "tool_invoked", 1, { tool: "Write", input: { file_path: "/p/src/csv.ts" } }),
      ev(CC, "result:w1", "tool_completed", 1, { tool: "Write", status: "ok" }),
      ev(CC, "file:w1", "file_created", 1, { file: "src/csv.ts", tool: "Write", linesAdded: 12, linesRemoved: 0 }),
      ev(CC, "tool:t1", "tool_invoked", 2, { tool: "Bash", input: { command: "npx vitest run" } }),
      ev(CC, "result:t1", "test_result", 2, { tool: "Bash", status: "error", outcome: "failed", testsPassed: 2, testsFailed: 1, outcomeBasis: "parsed from runner summary line", stdout: "FAIL quoted fields" }),
      ev(CC, "note:n1", "agent_note", 3, { kind: "cause", text: "Quoted commas were split because the parser used split(',')." }),
      ev(CC, "tool:e1", "tool_invoked", 4, { tool: "Edit", input: { file_path: "/p/src/csv.ts" } }),
      ev(CC, "result:e1", "tool_completed", 4, { tool: "Edit", status: "ok" }),
      ev(CC, "file:e1", "file_modified", 4, { file: "src/csv.ts", tool: "Edit", linesAdded: 9, linesRemoved: 1 }),
      ev(CC, "tool:t2", "tool_invoked", 5, { tool: "Bash", input: { command: "npx vitest run" } }),
      ev(CC, "result:t2", "test_result", 5, { tool: "Bash", status: "ok", outcome: "passed", testsPassed: 3, testsFailed: 0, outcomeBasis: "parsed from runner summary line" }),
      ev(CC, "tool:g1", "tool_invoked", 6, { tool: "Bash", input: { command: 'git commit -am "csv parser"' } }),
      ev("git", "commit:abc", "git_commit", 6, { sha: "abc1234", message: "csv parser", files: [{ path: "src/csv.ts", added: 20, removed: 0 }] }),
      ev(CC, "result:g1", "command_executed", 6, { tool: "Bash", status: "ok" }),
      ev(CC, "u2", "prompt_submitted", 10, { text: "What does RFC 4180 say about quotes?" }, { actor: "user", summary: "What does RFC 4180 say about quotes?" }),
      ev(CC, "a2:text:0", "ai_response_received", 10, { text: "Fields with commas are wrapped in double quotes." }),
      ev(CC, "u3", "prompt_submitted", 120, { text: "Rename parse to parseCsv" }, { actor: "user", summary: "Rename parse to parseCsv" }),
      ev("fs", "fs:1", "file_modified", 121, { file: "src/csv.ts", linesAdded: 1, linesRemoved: 1, detectedBy: "watcher" }),
    ],
    artifacts: [
      { sourceEventId: "file:e1", role: "diff", artifactType: "diff", content: "--- a/src/csv.ts\n+++ b/src/csv.ts\n-  return line.split(',');\n+  return splitQuoted(line);\n" },
      { sourceEventId: "commit:abc", role: "diff", artifactType: "diff", content: "diff --git a/src/csv.ts b/src/csv.ts\n+export function parse() {}\n" },
    ],
    links: [
      { source: CC, fromSourceEventId: "result:w1", toSourceEventId: "tool:w1", linkType: "result_of", strength: "observed", basis: "t" },
      { source: CC, fromSourceEventId: "file:w1", toSourceEventId: "tool:w1", linkType: "modified_file", strength: "observed", basis: "t" },
      { source: CC, fromSourceEventId: "result:t1", toSourceEventId: "tool:t1", linkType: "result_of", strength: "observed", basis: "t" },
      { source: CC, fromSourceEventId: "result:e1", toSourceEventId: "tool:e1", linkType: "result_of", strength: "observed", basis: "t" },
      { source: CC, fromSourceEventId: "file:e1", toSourceEventId: "tool:e1", linkType: "modified_file", strength: "observed", basis: "t" },
      { source: CC, fromSourceEventId: "result:t2", toSourceEventId: "tool:t2", linkType: "result_of", strength: "observed", basis: "t" },
      { source: CC, fromSourceEventId: "result:g1", toSourceEventId: "tool:g1", linkType: "result_of", strength: "observed", basis: "t" },
    ],
    gaps: [{ sessionId: "s1", source: CC, fromTime: null, toTime: null, reason: "Changes made outside Claude Code are not visible to this source" }],
  };
  store.ingest(pid, batch);
  correlate(store, pid);
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "dena-eng-"));
  store = new Store(home);
  pid = store.createProject("csv", "/p").id;
  seed();
});
afterEach(() => {
  store.close();
  fs.rmSync(home, { recursive: true, force: true });
});

const claim = (text: string, kind: Step["whatHappened"][number]["kind"], evidence: string[]) => ({ text, kind, evidence });
const ref = (pred: (text: string) => boolean) => {
  const [ep] = rebuildEpisodes(store, pid);
  return buildPacket(store, pid, ep!.id).items.find((i) => pred(i.text))!.ref;
};

function goodStep(): Step {
  const fail = ref((t) => t.includes("2 passed, 1 failed"));
  const pass = ref((t) => t.includes("3 passed, 0 failed"));
  const note = ref((t) => t.startsWith("AGENT NOTE"));
  const edit = ref((t) => t.includes("FILE MODIFIED src/csv.ts"));
  return {
    title: "Building a CSV parser that handles quoted fields",
    summary: "The AI wrote a parser, a test exposed a quoting bug, and a fix made all tests pass.",
    whatHappened: [claim("The first test run failed: 2 passed, 1 failed.", "observed", [fail])],
    whyItMattered: [claim("CSV files often contain commas inside quoted values.", "background", [])],
    howItWorks: [claim("A quote-aware splitter tracks whether it is inside quotes before treating a comma as a separator. ".repeat(5), "background", [])],
    whatChanged: [claim("src/csv.ts switched from split(',') to splitQuoted.", "observed", [edit])],
    decisions: [claim("The agent said split(',') was the cause.", "agent_stated", [note])],
    verification: [claim("After the fix all 3 tests passed.", "observed", [pass])],
    concepts: [{ term: "RFC 4180", explanation: "The common CSV format description." }],
    uncertainty: [],
  };
}

class FakeProvider implements Provider {
  name = "fake";
  calls: string[] = [];
  constructor(private readonly answers: Step[]) {}
  async generate(_s: string, user: string): Promise<GenerateResult> {
    this.calls.push(user);
    return { json: this.answers[Math.min(this.calls.length - 1, this.answers.length - 1)], model: "fake-model", costUsd: 0.01, durationMs: 1 };
  }
}

describe("episodes", () => {
  it("closes an episode at a commit, keeps discussion with its work, and breaks on idle time", () => {
    const eps = buildEpisodes(store.timeline(pid));
    expect(eps).toHaveLength(3);
    expect(eps[0]!.stats).toMatchObject({ prompts: 1, commits: 1, tests: 2, testFailures: 1, notes: 1 });
    expect(eps[1]!.title).toBe("What does RFC 4180 say about quotes?"); // after the commit
    expect(eps[2]!.title).toBe("Rename parse to parseCsv"); // after a 110-minute pause
    expect(eps[2]!.stats.fileChanges).toBe(1); // watcher change attached to the active prompt
  });
  it("is deterministic and keeps ids stable across rebuilds", () => {
    expect(rebuildEpisodes(store, pid).map((e) => e.id)).toEqual(rebuildEpisodes(store, pid).map((e) => e.id));
  });
});

describe("evidence packet", () => {
  it("folds tool calls into readable items with facts, and includes gaps", () => {
    const [ep] = rebuildEpisodes(store, pid);
    const p = buildPacket(store, pid, ep!.id);
    const kinds = p.items.map((i) => i.kind);
    expect(kinds).toEqual(expect.arrayContaining(["prompt", "file_change", "test", "agent_note", "commit", "command", "gap"]));
    expect(p.items.find((i) => i.kind === "test" && i.facts.outcome === "failed")).toBeDefined();
    expect(p.items.filter((i) => i.kind === "file_change")).toHaveLength(2); // Write + Edit, not their raw tool events
    expect(renderPacket(p)).toContain("+  return splitQuoted(line);");
    expect(p.items.find((i) => i.kind === "commit")!.text).toContain("made by an AI command — inferred");
  });
  it("says when a file change has an unknown author", () => {
    const eps = rebuildEpisodes(store, pid);
    expect(renderPacket(buildPacket(store, pid, eps[2]!.id))).toContain("who made it is unknown");
  });
});

describe("validator", () => {
  const packet = () => buildPacket(store, pid, rebuildEpisodes(store, pid)[0]!.id);

  it("accepts a well-cited step", () => {
    const v = validateStep(goodStep(), packet());
    expect(v.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(v.citedShare).toBe(1);
  });

  it("catches invented evidence, uncited claims, wrong test outcomes, unsupported files and misused agent_stated", () => {
    const s = goodStep();
    const fail = ref((t) => t.includes("2 passed, 1 failed"));
    s.whatHappened.push(claim("Something happened.", "observed", ["E99"]));
    s.whatHappened.push(claim("The parser was rewritten twice.", "inferred", []));
    s.verification = [claim("All tests passed on the first run.", "observed", [fail])];
    s.whatChanged.push(claim("Also changed src/server.ts.", "observed", [fail]));
    s.decisions.push(claim("The AI preferred speed.", "agent_stated", [fail]));
    const msgs = validateStep(s, packet()).issues.map((i) => i.message).join("\n");
    expect(msgs).toContain("does not exist: E99");
    expect(msgs).toContain("inferred claim cites no evidence");
    expect(msgs).toContain("says tests passed, but the cited test runs were: failed");
    expect(msgs).toContain("names src/server.ts");
    expect(msgs).toContain("must cite an AGENT NOTE or AI RESPONSE");
  });

  it("warns when the mechanism is not explained", () => {
    const s = goodStep();
    s.howItWorks = [claim("It parses CSV.", "background", [])];
    expect(validateStep(s, packet()).issues.some((i) => i.section === "howItWorks" && i.severity === "warning")).toBe(true);
  });
});

describe("explainEpisode", () => {
  it("repairs once, caches by evidence, and regenerates when evidence changes", async () => {
    const bad = goodStep();
    bad.verification = [claim("Tests passed.", "observed", ["E99"])];
    const fake = new FakeProvider([bad, goodStep()]);
    const ep = rebuildEpisodes(store, pid)[0]!;

    const x = await explainEpisode(store, pid, ep.id, fake);
    expect(x.attempts).toBe(2);
    expect(x.validation.ok).toBe(true);
    expect(fake.calls[1]).toContain("does not exist: E99");
    expect(fake.calls[0]).toContain("<evidence>");

    const again = await explainEpisode(store, pid, ep.id, fake);
    expect(again.cached).toBe(true);
    expect(fake.calls).toHaveLength(2);

    store.ingest(pid, { sessions: [], artifacts: [], links: [], gaps: [],
      events: [ev(CC, "note:n2", "agent_note", 5, { kind: "decision", text: "Kept zero dependencies." })] });
    rebuildEpisodes(store, pid);
    const fresh = await explainEpisode(store, pid, ep.id, fake);
    expect(fresh.cached).toBe(false);
  });

  it("keeps remaining problems visible instead of hiding them", async () => {
    const bad = goodStep();
    bad.whatHappened.push(claim("A database migration ran.", "observed", ["E99"]));
    const x = await explainEpisode(store, pid, rebuildEpisodes(store, pid)[0]!.id, new FakeProvider([bad, bad]));
    expect(x.validation.ok).toBe(false);
    const md = renderStep(x);
    expect(md).toContain("It can be wrong");
    expect(md).toContain("⚠️ *failed a check");
    expect(md).toContain("### Checks");
    expect(md).toContain("**💬 Agent said**");
  });
});
