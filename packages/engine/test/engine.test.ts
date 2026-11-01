import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { correlate, Store, type IngestBatch, type NewEvent } from "@dena/core";
import {
  enqueue, exportGuideMarkdown, findOutdated, listJobs, processDueJobs,
  activeRevision, addNote, adoptProposed, batchPrompt, isRetryable, systemPrompt, userPrompt, latestExplanations, proposedRevision, restoreRevision, revisions, RevisionConflict, saveUserEdit,
  buildEpisodes, buildPacket, componentOf, ensureMemory, estimate, failingTests, loadMemory, explainEpisode, explainMany, rebuildEpisodes, renderPacket, renderStep, validateStep,
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
    goal: "", prerequisites: [], instructions: [], check: [], pitfalls: [],
    whatHappened: [claim("The first test run failed: 2 passed, 1 failed.", "observed", [fail])],
    whyItMattered: [claim("CSV files often contain commas inside quoted values.", "background", [])],
    howItWorks: [claim("A quote-aware splitter tracks whether it is inside quotes before treating a comma as a separator. ".repeat(5), "background", [])],
    whatChanged: [claim("src/csv.ts switched from split(',') to splitQuoted.", "observed", [edit])],
    decisions: [claim("The agent said split(',') was the cause.", "agent_stated", [note])],
    verification: [claim("After the fix all 3 tests passed.", "observed", [pass])],
    concepts: [{ term: "RFC 4180", explanation: "The common CSV format description." }],
    uncertainty: [],
    generatedBy: "model",
  };
}

class FakeProvider implements Provider {
  name = "fake";
  calls: string[] = [];
  models: (string | undefined)[] = [];
  constructor(private readonly answers: (Step | ((user: string, schema: any) => unknown))[]) {}
  async generate(_s: string, user: string, schema: object, opts?: { model?: string }): Promise<GenerateResult> {
    this.calls.push(user);
    this.models.push(opts?.model);
    const a = this.answers[Math.min(this.calls.length - 1, this.answers.length - 1)]!;
    return { json: typeof a === "function" ? a(user, schema) : a, model: opts?.model ?? "fake-model", costUsd: 0.01, durationMs: 1 };
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
  it("folds tool calls into readable items with facts, leaving standing limitations out", () => {
    const [ep] = rebuildEpisodes(store, pid);
    const p = buildPacket(store, pid, ep!.id);
    const kinds = p.items.map((i) => i.kind);
    expect(kinds).toEqual(expect.arrayContaining(["prompt", "file_change", "test", "agent_note", "commit", "command"]));
    expect(kinds).not.toContain("gap"); // the fixture's only gap is a standing limitation, stated once in About this guide
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

  it("catches the project's milestone shorthand, but not Apple's M-series chips", () => {
    const step = goodStep();
    step.title = "Finish M1: quoted fields";
    step.howItWorks[0] = { ...step.howItWorks[0]!, text: `${step.howItWorks[0]!.text} This was planned for phase 2.` };
    step.whyItMattered.push({ text: "It runs fine on an M1 Mac and an M2 Pro.", kind: "background", evidence: [] });
    const msgs = validateStep(step, packet()).issues.filter((i) => i.message.includes("shorthand")).map((i) => `${i.section}: ${i.message.match(/"([^"]+)"/)![1]}`);
    expect(msgs).toEqual(["howItWorks: phase 2", "title: M1"]);
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
    // Too broken to fix locally (every story claim cites nothing real), so a repair call is made.
    const bad = goodStep();
    bad.whatHappened = [claim("Tests passed.", "observed", ["E99"]), claim("It shipped.", "observed", ["E98"]), claim("Then more.", "inferred", [])];
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
    // Every story claim cites evidence that does not exist: too much to fix locally, and the repair is just as bad.
    const bad = goodStep();
    bad.whatHappened = [claim("A database migration ran.", "observed", ["E99"]), claim("Then a cache was added.", "observed", ["E98"])];
    const x = await explainEpisode(store, pid, rebuildEpisodes(store, pid)[0]!.id, new FakeProvider([bad, bad]));
    expect(x.validation.ok).toBe(false);
    const md = renderStep(x);
    expect(md).toContain("It can be wrong");
    expect(md).toContain("⚠️ *failed a check");
    expect(md).toContain("### Checks");
    expect(md).toContain("**💬 Agent said**");
  });
});

describe("usage savings", () => {
  it("explains a no-change episode from facts, with no model call", async () => {
    const fake = new FakeProvider([goodStep()]);
    const qa = rebuildEpisodes(store, pid)[1]!; // "What does RFC 4180 say about quotes?"
    const x = await explainEpisode(store, pid, qa.id, fake);
    expect(fake.calls).toHaveLength(0);
    expect(x.step.generatedBy).toBe("facts");
    expect(x.step.whatHappened.map((c) => c.text).join(" ")).toContain("RFC 4180");
    expect(renderStep(x)).toContain("No model was used");
  });

  it("fills what changed and verification from facts, whatever the model says", async () => {
    const wrong = goodStep();
    wrong.verification = [claim("Everything passed first time.", "observed", [])];
    wrong.whatChanged = [claim("Rewrote the database layer.", "observed", [])];
    const x = await explainEpisode(store, pid, rebuildEpisodes(store, pid)[0]!.id, new FakeProvider([wrong]));
    expect(x.step.verification.map((c) => c.text)).toEqual(["Test run failed (2 passed, 1 failed).", "Test run passed (3 passed, 0 failed)."]);
    expect(x.step.whatChanged[0]!.text).toContain('Commit abc1234 "csv parser" changed 1 file: src/csv.ts');
    expect(JSON.stringify(x.step)).not.toContain("database layer");
  });

  it("uses the project's model setting, overridable per run", async () => {
    store.updateProjectSettings(pid, { model: "haiku" });
    const fake = new FakeProvider([goodStep()]);
    const ep = rebuildEpisodes(store, pid)[0]!.id;
    await explainEpisode(store, pid, ep, fake);
    await explainEpisode(store, pid, ep, fake, { model: "sonnet" });
    expect(fake.models).toEqual(["haiku", "sonnet"]);
    // each model's explanation is cached separately
    expect((await explainEpisode(store, pid, ep, fake, { model: "haiku" })).cached).toBe(true);
    expect(fake.calls).toHaveLength(2);
  });

  it("builds smaller packets at concise depth", () => {
    const ep = rebuildEpisodes(store, pid)[0]!.id;
    expect(buildPacket(store, pid, ep, { depth: "concise" }).chars).toBeLessThanOrEqual(buildPacket(store, pid, ep, { depth: "thorough" }).chars);
  });

  it("folds repeated same-outcome test runs but keeps their events citable", () => {
    const more: NewEvent[] = [];
    for (let i = 0; i < 4; i++) {
      more.push(ev(CC, `tool:r${i}`, "tool_invoked", 7 + i * 0.1, { tool: "Bash", input: { command: "npx vitest run" } }));
      more.push(ev(CC, `result:r${i}`, "test_result", 7 + i * 0.1, { tool: "Bash", status: "ok", outcome: "passed", testsPassed: 3, testsFailed: 0, outcomeBasis: "x" }));
    }
    store.ingest(pid, { sessions: [], artifacts: [], gaps: [], events: more,
      links: [0, 1, 2, 3].map((i) => ({ source: CC, fromSourceEventId: `result:r${i}`, toSourceEventId: `tool:r${i}`, linkType: "result_of" as const, strength: "observed" as const, basis: "t" })) });
    const p = buildPacket(store, pid, rebuildEpisodes(store, pid)[0]!.id);
    const tests = p.items.filter((i) => i.kind === "test");
    expect(tests.length).toBeLessThan(6);
    expect(tests.some((t) => /earlier runs? with the same outcome folded/.test(t.text))).toBe(true);
    expect(tests.flatMap((t) => t.eventIds).length).toBe(12); // 6 runs × (call + result), none lost
  });

  it("batches small episodes into one call, and caps spending", async () => {
    // Make several small episodes: each prompt edits a file, separated by idle time.
    const evs: NewEvent[] = [];
    for (let i = 0; i < 4; i++) {
      const m = 300 + i * 60;
      evs.push(ev(CC, `bp${i}`, "prompt_submitted", m, { text: `Tweak ${i}` }, { actor: "user", summary: `Tweak ${i}` }));
      evs.push(ev("fs", `bf${i}`, "file_modified", m + 1, { file: `src/f${i}.ts`, linesAdded: 1, linesRemoved: 0 }));
    }
    store.ingest(pid, { sessions: [], artifacts: [], links: [], gaps: [], events: evs });
    const eps = rebuildEpisodes(store, pid).filter((e) => e.title.startsWith("Tweak"));
    expect(eps).toHaveLength(4);
    const answer = (user: string) => ({ steps: [...user.matchAll(/<episode id="([^"]+)"/g)].map((m) => ({
      episode: m[1], title: "Small tweak", summary: "A one-line change.", whatHappened: [claim("A file changed.", "observed", ["E2"])],
      whyItMattered: [], howItWorks: [], decisions: [], concepts: [], uncertainty: [] })) });
    const fake = new FakeProvider([answer]);
    const est = estimate(store, pid, eps.map((e) => e.id));
    expect(est.modelCalls).toBe(1);
    const r = await explainMany(store, pid, eps.map((e) => e.id), fake);
    expect(fake.calls).toHaveLength(1);
    expect(r.explained.every((x) => x.batched && x.validation.ok)).toBe(true);

    const capped = await explainMany(store, pid, eps.map((e) => e.id), new FakeProvider([answer]), { force: true, maxUsd: 0 });
    expect(capped.calls).toBe(0);
    expect(capped.skippedForBudget).toHaveLength(4);
  });
});

describe("project memory", () => {
  it("groups files into components", () => {
    expect(componentOf("src/views/Guide.tsx")).toBe("src/views");
    expect(componentOf("src/App.tsx")).toBe("src");
    expect(componentOf("README.md")).toBe("(project root)");
  });

  it("reads failing test names from common runners", () => {
    expect(failingTests("ok 1 - a\nnot ok 2 - parses quoted fields\n# fail 1")).toEqual(["parses quoted fields"]);
    expect(failingTests(" FAIL  src/csv.test.ts > quotes\n Tests  1 failed")).toEqual(["src/csv.test.ts > quotes"]);
    expect(failingTests("FAILED tests/test_csv.py::test_quotes - assert")).toEqual(["tests/test_csv.py::test_quotes"]);
  });

  it("records a failure and its later fix, with the cause note and honest basis", () => {
    ensureMemory(store, pid);
    const [p] = loadMemory(store, pid, "problem");
    expect(p!.data).toMatchObject({ status: "fixed", failedRuns: 1, fixCounts: { passed: 3, failed: 0 } });
    expect((p!.data.causeNotes as any[])[0].text).toContain("split(',')");
    expect(String(p!.data.basis)).toContain("Inferred: that the changes in between fixed it");
    expect(p!.sources.map((s) => s.basis)).toEqual(expect.arrayContaining(["failing test run", "first later passing run"]));
  });

  it("links the commit made right after a fix when nothing was captured in between", () => {
    store.ingest(pid, { sessions: [], artifacts: [], links: [], gaps: [], events: [
      ev(CC, "u9", "prompt_submitted", 400, { text: "fix it" }, { actor: "user", summary: "fix it" }),
      ev(CC, "result:t9", "test_result", 401, { outcome: "failed", testsPassed: 0, testsFailed: 1, stdout: "not ok 1 - it works" }),
      ev(CC, "result:t10", "test_result", 402, { outcome: "passed", testsPassed: 1, testsFailed: 0 }),
      ev("git", "commit:fix", "git_commit", 403, { sha: "fff0000", message: "Fix it", files: [{ path: "src/it.ts", added: 1, removed: 1 }] }),
    ] });
    rebuildEpisodes(store, pid);
    ensureMemory(store, pid);
    const p = loadMemory(store, pid, "problem").find((m) => m.title === "Failing test: it works")!;
    expect(p.data.commitAfterFix).toMatchObject({ sha: "fff0000", files: ["src/it.ts"] });
    expect(String((p.data.commitAfterFix as any).basis)).toMatch(/^inferred/);
  });

  it("takes decisions, concepts and uncertainty from explanations, keeping claim kinds and evidence", async () => {
    const step = goodStep();
    step.uncertainty = ["The reason for the rename is not shown in E1."];
    await explainEpisode(store, pid, rebuildEpisodes(store, pid)[0]!.id, new FakeProvider([step]));
    ensureMemory(store, pid);
    const decision = loadMemory(store, pid, "decision").find((d) => d.data.claimKind === "agent_stated" && String(d.data.text).includes("split"))!;
    expect(decision.sources[0]!.eventId).toBeTypeOf("number");
    expect(loadMemory(store, pid, "concept").map((c) => c.title)).toContain("RFC 4180");
    const q = loadMemory(store, pid, "question").find((x) => String(x.data.text).includes("rename"))!;
    expect(Object.keys(q.data.refs as object)).toEqual(["E1"]);
  });

  it("only rebuilds when something changed", () => {
    expect(ensureMemory(store, pid)).toBe(true);
    expect(ensureMemory(store, pid)).toBe(false);
  });
});

describe("revisions and owner corrections", () => {
  const ep = () => rebuildEpisodes(store, pid)[0]!.id;

  it("records every generated version, and keeps the owner's edit when an AI update arrives", async () => {
    const id = ep();
    await explainEpisode(store, pid, id, new FakeProvider([goodStep()]));
    const first = activeRevision(store, pid, "step", id)!;
    expect(first).toMatchObject({ origin: "generated", status: "active" });

    const edited = structuredClone(first.content);
    edited.summary = "My own summary.";
    edited.whatHappened[0] = { ...edited.whatHappened[0], text: "Rewritten by me.", edited: true };
    saveUserEdit(store, pid, "step", id, edited, first.id, "clarified");
    expect(activeRevision(store, pid, "step", id)!.content.summary).toBe("My own summary.");

    await explainEpisode(store, pid, id, new FakeProvider([goodStep()]), { force: true });
    expect(activeRevision(store, pid, "step", id)!.content.summary).toBe("My own summary."); // not overwritten
    const proposal = proposedRevision(store, pid, "step", id)!;
    expect(proposal.origin).toBe("generated");

    adoptProposed(store, pid, "step", id, proposal.id);
    expect(activeRevision(store, pid, "step", id)!.content.summary).not.toBe("My own summary.");
    expect(revisions(store, pid, "step", id).some((r) => r.origin === "user")).toBe(true); // the edit stays in history
  });

  it("rejects an edit based on an outdated version, and restores any earlier version", async () => {
    const id = ep();
    await explainEpisode(store, pid, id, new FakeProvider([goodStep()]));
    const v1 = activeRevision(store, pid, "step", id)!;
    saveUserEdit(store, pid, "step", id, { ...v1.content, summary: "A" }, v1.id);
    expect(() => saveUserEdit(store, pid, "step", id, { ...v1.content, summary: "B" }, v1.id)).toThrow(RevisionConflict);
    restoreRevision(store, pid, "step", id, v1.id);
    const now = activeRevision(store, pid, "step", id)!;
    expect(now).toMatchObject({ origin: "restored" });
    expect(now.content.summary).toBe(v1.content.summary);
  });

  it("keeps a waiting AI update through the owner's edits, and treats a restored version as theirs", async () => {
    const id = ep();
    await explainEpisode(store, pid, id, new FakeProvider([goodStep()]));
    const v1 = activeRevision(store, pid, "step", id)!;
    saveUserEdit(store, pid, "step", id, { ...v1.content, summary: "Mine." }, v1.id);
    await explainEpisode(store, pid, id, new FakeProvider([goodStep()]), { force: true });
    const waiting = proposedRevision(store, pid, "step", id)!;
    const v2 = activeRevision(store, pid, "step", id)!;
    saveUserEdit(store, pid, "step", id, { ...v2.content, summary: "Mine, again." }, v2.id);
    expect(proposedRevision(store, pid, "step", id)?.id).toBe(waiting.id); // still waiting after another edit

    // An AI rewrite that finishes after a restore waits for review instead of replacing it.
    restoreRevision(store, pid, "step", id, v1.id);
    await explainEpisode(store, pid, id, new FakeProvider([goodStep()]), { force: true });
    expect(activeRevision(store, pid, "step", id)!.origin).toBe("restored");
    expect(proposedRevision(store, pid, "step", id)!.id).not.toBe(waiting.id); // the newer AI version replaced the older proposal
  });

  it("builds project memory from the version the owner sees, not an AI rewrite waiting for review", async () => {
    const id = ep();
    await explainEpisode(store, pid, id, new FakeProvider([goodStep()]));
    const v1 = activeRevision(store, pid, "step", id)!;
    saveUserEdit(store, pid, "step", id, { ...v1.content, summary: "The owner's summary." }, v1.id);
    await explainEpisode(store, pid, id, new FakeProvider([goodStep()]), { force: true }); // lands as a proposal
    expect(latestExplanations(store, pid).find((x) => x.unitId === id)!.step.summary).toBe("The owner's summary.");
    expect(ensureMemory(store, pid)).toBe(true);
    restoreRevision(store, pid, "step", id, v1.id);
    expect(ensureMemory(store, pid)).toBe(true); // a restore rebuilds memory
    expect(latestExplanations(store, pid).find((x) => x.unitId === id)!.step.summary).toBe(v1.content.summary);
  });

  it("does not retry failures that cannot fix themselves", () => {
    expect(isRetryable("Dena has not recorded anything for this page yet.")).toBe(false);
    expect(isRetryable("Episode ep_1 has no evidence to explain")).toBe(false);
    expect(isRetryable("socket hang up")).toBe(true);
  });

  it("feeds owner notes to the writer as non-evidence, and checks how they are cited", async () => {
    const id = ep();
    addNote(store, pid, "step", id, { kind: "context", text: "We used split(',') on purpose for the first prototype." });
    addNote(store, pid, "step", id, { kind: "incorrect", target: "The parser was rewritten twice.", text: "It was only rewritten once." });
    const p = buildPacket(store, pid, id);
    const notes = p.items.filter((i) => i.kind === "owner_note");
    expect(notes).toHaveLength(2);
    expect(notes[0]!.text).toContain("not a record of events");
    expect(notes[1]!.text).toContain('says this statement was incorrect: "The parser was rewritten twice."');

    const step = goodStep();
    step.decisions.push(claim("The prototype used split on purpose.", "owner_stated", [notes[0]!.ref]));
    step.whatHappened.push(claim("The prototype used split on purpose.", "observed", [notes[0]!.ref]));
    const v = validateStep(step, p);
    expect(v.issues.map((i) => i.message)).toContain("the owner's notes are not evidence of events; label this owner_stated");
    expect(v.issues.filter((i) => i.message.includes("owner_stated claim must cite"))).toHaveLength(0);
  });
});

describe("updates and export", () => {
  const ep = () => rebuildEpisodes(store, pid)[0]!.id;
  class Flaky implements Provider {
    name = "flaky";
    calls = 0;
    constructor(private readonly failures: string[]) {}
    async generate(_s: string, _u: string, schema: any): Promise<GenerateResult> {
      const f = this.failures[this.calls++];
      if (f) throw new Error(f);
      // The queue updates written steps in a targeted way; answer that shape when asked for it.
      const json = schema?.properties?.updates ? { title: goodStep().title, summary: goodStep().summary, updates: [], remove: [], uncertainty: [] } : goodStep();
      return { json, model: "fake", costUsd: 0.01, durationMs: 1 };
    }
  }

  it("finds only documents whose inputs changed", async () => {
    const id = ep();
    await explainEpisode(store, pid, id, new FakeProvider([goodStep()]));
    expect(findOutdated(store, pid)).toEqual([]);
    addNote(store, pid, "step", id, { kind: "context", text: "Prototype only." });
    expect(findOutdated(store, pid)).toMatchObject([{ type: "step", key: id, reason: "1 new note from you" }]);
  });

  it("retries a transient failure with backoff, then succeeds", async () => {
    const id = ep();
    await explainEpisode(store, pid, id, new FakeProvider([goodStep()]));
    addNote(store, pid, "step", id, { kind: "context", text: "x" });
    expect(enqueue(store, pid, [{ type: "step", key: id }, { type: "step", key: id }])).toBe(1); // no duplicates
    let clock = Date.now();
    const flaky = new Flaky(["Claude is unavailable right now: overloaded"]);
    const first = await processDueJobs(store, pid, flaky, { now: () => clock });
    expect(first).toMatchObject({ done: 0, retrying: 1 });
    expect(listJobs(store, pid)[0]).toMatchObject({ status: "queued", attempts: 1 });
    clock += 11_000;
    const second = await processDueJobs(store, pid, flaky, { now: () => clock });
    expect(second.done).toBe(1);
    expect(listJobs(store, pid)[0]).toMatchObject({ status: "done" });
    expect(listJobs(store, pid)[0]!.result).toMatch(/^update waiting for your review: 0 added, 0 changed, 0 removed, \d+ kept$/);
    expect(proposedRevision(store, pid, "step", id)!.meta.targeted).toBe(true);
    expect(findOutdated(store, pid)).toMatchObject([{ waiting: true }]); // reviewed by the owner, not queued again
  });

  it("does not retry sign-in problems, and keeps the owner's edits as a proposal", async () => {
    const id = ep();
    await explainEpisode(store, pid, id, new FakeProvider([goodStep()]));
    const v = activeRevision(store, pid, "step", id)!;
    saveUserEdit(store, pid, "step", id, { ...v.content, summary: "Mine" }, v.id);
    addNote(store, pid, "step", id, { kind: "context", text: "x" });
    enqueue(store, pid, [{ type: "step", key: id }]);
    const r = await processDueJobs(store, pid, new Flaky(["Claude Code is not signed in to your Claude account."]));
    expect(r).toMatchObject({ failed: 1, retrying: 0 });
    enqueue(store, pid, [{ type: "step", key: id }]);
    await processDueJobs(store, pid, new Flaky([]));
    expect(activeRevision(store, pid, "step", id)!.content.summary).toBe("Mine");
    expect(listJobs(store, pid)[0]!.result).toContain("waiting for your review");
    expect(proposedRevision(store, pid, "step", id)!.content.summary).toBe("Mine"); // the owner's summary carried into the proposal
  });

  it("exports the current versions, marking the owner's edits and corrections", async () => {
    const id = ep();
    await explainEpisode(store, pid, id, new FakeProvider([goodStep()]));
    const v = activeRevision(store, pid, "step", id)!;
    const content = structuredClone(v.content);
    content.whatHappened[0] = { ...content.whatHappened[0], flagged: "incorrect" };
    content.decisions[0] = { ...content.decisions[0], text: "We chose split(',') for the prototype.", edited: true };
    saveUserEdit(store, pid, "step", id, content, v.id);
    const { markdown, counts } = exportGuideMarkdown(store, pid, { generatedAt: "2026-10-29T00:00:00Z" });
    expect(counts.steps).toBe(1);
    expect(markdown).toContain("It can be wrong.");
    expect(markdown).toContain("*(marked incorrect by the owner)*");
    expect(markdown).toContain("We chose split(',') for the prototype. [");
    expect(markdown).toContain("*(edited by the owner)*");
    expect(markdown).toContain("## Problems and fixes");
    expect(markdown).toMatch(/\[E\d+\]\(#ep1-e\d+\)/);
  });
});

describe("fewer repair calls", () => {
  const ep = () => rebuildEpisodes(store, pid)[0]!.id;
  it("fixes small problems locally by weakening or removing, and lists each fix", async () => {
    const step = goodStep();
    step.howItWorks.push(claim("The parser streams input.", "observed", ["E99"]));
    step.decisions.push(claim("The AI preferred speed.", "agent_stated", [ref((t) => t.includes("2 passed, 1 failed"))]));
    const fake = new FakeProvider([step]);
    const x = await explainEpisode(store, pid, ep(), fake);
    expect(fake.calls).toHaveLength(1); // no repair call
    expect(x.validation.ok).toBe(true);
    expect(x.step.howItWorks.some((c) => c.text === "The parser streams input.")).toBe(false);
    expect(x.step.decisions.find((c) => c.text === "The AI preferred speed.")!.kind).toBe("inferred");
    expect(x.validation.autoFixes!.join(" ")).toContain("Relabelled");
    expect(x.validation.repairReasons!.length).toBeGreaterThan(0);
    expect(renderStep(x)).toContain("### Fixed automatically");
  });

  it("only offers the 'You said' label when the episode has owner notes", async () => {
    const schemas: any[] = [];
    const spy: Provider = { name: "spy", async generate(_s, _u, schema) { schemas.push(schema); return { json: goodStep(), model: "m", costUsd: 0, durationMs: 1 }; } };
    await explainEpisode(store, pid, ep(), spy);
    const kinds = (sc: any) => sc.properties.whatHappened.items.properties.kind.enum as string[];
    expect(kinds(schemas[0])).not.toContain("owner_stated");
    addNote(store, pid, "step", ep(), { kind: "context", text: "Demo only." });
    await explainEpisode(store, pid, ep(), spy, { force: true });
    expect(kinds(schemas[1])).toContain("owner_stated");
  });

  it("tells the model which references exist and what each label may cite", async () => {
    const fake = new FakeProvider([goodStep()]);
    await explainEpisode(store, pid, ep(), fake);
    expect(fake.calls[0]).toContain("<reference_guide>");
    expect(fake.calls[0]).toMatch(/"agent_stated" may cite only: E\d+/);
    expect(fake.calls[0]).toMatch(/Test runs: E\d+, E\d+/);
  });
});

describe("test-outcome check wording", () => {
  it("flags claims about results, not descriptions of a failing test (false positive seen in a real run)", () => {
    const p = buildPacket(store, pid, rebuildEpisodes(store, pid)[0]!.id);
    const pass = p.items.find((i) => i.kind === "test" && i.facts.outcome === "passed")!.ref;
    const fail = p.items.find((i) => i.kind === "test" && i.facts.outcome === "failed")!.ref;
    const issues = (text: string, ref: string) => {
      const s = goodStep();
      s.whatHappened = [claim(text, "observed", [ref])];
      return validateStep(s, p).issues.filter((i) => /says tests/.test(i.message)).length;
    };
    expect(issues("Update the failing test's expected wording to match the new prompt.", pass)).toBe(0);
    expect(issues("The fix addressed the failure in quoted fields.", pass)).toBe(0);
    expect(issues("The tests passed on the first run.", fail)).toBe(1);
    expect(issues("The suite failed after the change.", pass)).toBe(1);
    expect(issues("All 3 tests passed.", fail)).toBe(1);
  });
});

describe("step writing instructions", () => {
  it("ask for plain titles without the project's shorthand, and warn the first step about unrecorded earlier work", () => {
    const sys = systemPrompt("concise");
    expect(sys).toContain("about 4–10 words");
    expect(sys).toContain('milestone or phase names ("M1"');
    expect(userPrompt("p", "t", "E1", undefined, undefined, true)).toContain("first recorded step");
    expect(userPrompt("p", "t", "E1", "earlier")).not.toContain("first recorded step");
    const batch = batchPrompt("p", [{ id: "ep_a", title: "a", packetText: "E1", first: true }, { id: "ep_b", title: "b", packetText: "E1" }]);
    expect(batch).toContain("About episode ep_a: This is the first recorded step");
  });
});
