import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { correlate, Store, type NewEvent } from "@dena/core";
import {
  activeRevision, adoptUpdate, buildPacket, explainEpisode, generateSection, planUpdate, proposedRevision, rebuildEpisodes, saveUserEdit, Step, updateSection, updateStep,
  type GenerateResult, type Provider,
} from "../src/index.ts";

let home: string;
let store: Store;
let pid: string;
let ep: string;
const CC = "claude_code.transcript";
const at = (s: number) => new Date(Date.UTC(2026, 9, 1, 12, 0, s)).toISOString();
const ev = (sid: string, eventType: NewEvent["eventType"], s: number, payload: Record<string, unknown>, extra: Partial<NewEvent> = {}): NewEvent => ({
  sessionId: "s1", source: CC, sourceEventId: sid, eventType, occurredAt: at(s), actor: "ai_agent", summary: sid, payload, captureConfidence: "observed", ...extra,
});
const refOf = (kind: string, i = 0) => buildPacket(store, pid, ep).items.filter((x) => x.kind === kind)[i]!.ref;

/** Writes a first explanation from the packet, and answers targeted updates by revising every statement under review. */
class FakeProvider implements Provider {
  readonly name = "fake";
  calls: { user: string; schema: any }[] = [];
  async generate(_s: string, user: string, schema: any): Promise<GenerateResult> {
    this.calls.push({ user, schema });
    const tokens = { prompt: 1000, output: 300, cacheRead: 0 };
    if (schema.properties.updates) {
      const review = [...user.matchAll(/^\[(A\d+)\] \(([^,]+),/gm)].map((m) => m[1]!);
      const refs = [...user.matchAll(/^\[([ES]\d+)\]/gm)].map((m) => m[1]!);
      const fresh = refs[0]!;
      const step = !!schema.properties.updates.items.properties.section.enum;
      return { json: {
        title: "Kept title", summary: "A new summary.",
        updates: [
          ...review.map((id) => ({ section: step ? "whatHappened" : "Story", replaces: id, text: `Revised ${id}.`, kind: "observed", evidence: [fresh] })),
          { section: step ? "whatHappened" : "Story", replaces: "", text: "A new statement about the new evidence.", kind: "observed", evidence: [fresh] },
        ],
        remove: [], uncertainty: ["Still unknown."] }, model: "fake-1", costUsd: 0, durationMs: 1, tokens };
    }
    if (schema.properties.sections) { // a wiki page
      const s = [...user.matchAll(/^\[(S\d+)\]/gm)].map((m) => m[1]!);
      return { json: { title: "Overview", summary: "s", sections: [{ heading: "Story", claims: s.map((r) => ({ text: `About ${r}.`, kind: "observed", evidence: [r] })) }], uncertainty: [] },
        model: "fake-1", costUsd: 0, durationMs: 1, tokens };
    }
    return { json: {
      title: "Kept title", summary: "Old summary.",
      whatHappened: [
        { text: "The user asked for a parser.", kind: "observed", evidence: [refOf("prompt")] },
        { text: "The first test run failed.", kind: "observed", evidence: [refOf("test")] },
      ],
      whyItMattered: [], decisions: [],
      howItWorks: [{ text: "Parsers turn text into structure.", kind: "background", evidence: [] }],
      concepts: [], uncertainty: [] }, model: "fake-1", costUsd: 0, durationMs: 1, tokens };
  }
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "dena-tu-"));
  store = new Store(home);
  pid = store.createProject("p", "/p").id;
  store.ingest(pid, {
    sessions: [{ id: "s1", source: CC, startedAt: at(0), endedAt: at(100) }], artifacts: [], gaps: [],
    links: [{ source: CC, fromSourceEventId: "result:t1", toSourceEventId: "tool:t1", toSource: CC, linkType: "result_of", strength: "observed", basis: "t" }],
    events: [
      ev("u1", "prompt_submitted", 0, { text: "Add a CSV parser" }, { actor: "user" }),
      ev("tool:w1", "tool_invoked", 3, { tool: "Write", input: { file_path: "/p/src/csv.ts" } }),
      ev("file:w1", "file_created", 3, { file: "src/csv.ts", tool: "Write", linesAdded: 10 }),
      ev("tool:t1", "tool_invoked", 10, { tool: "Bash", input: { command: "npm test" } }),
      ev("result:t1", "test_result", 12, { tool: "Bash", status: "error", outcome: "failed", testsPassed: 2, testsFailed: 1 }),
    ],
  });
  correlate(store, pid);
  ep = rebuildEpisodes(store, pid)[0]!.id;
});
afterEach(() => {
  store.close();
  fs.rmSync(home, { recursive: true, force: true });
});

/** New evidence arrives in the same episode: the AI edits the file again and the tests pass. */
function addEvidence() {
  store.ingest(pid, {
    sessions: [], artifacts: [], gaps: [], links: [],
    events: [
      ev("tool:e2", "tool_invoked", 20, { tool: "Edit", input: { file_path: "/p/src/csv.ts", old_string: "a", new_string: "b" } }),
      ev("file:e2", "file_modified", 20, { file: "src/csv.ts", tool: "Edit", linesAdded: 2, linesRemoved: 1 }),
    ],
  });
  correlate(store, pid);
  rebuildEpisodes(store, pid);
}

describe("targeted updates of a step", () => {
  it("keeps statements whose evidence is unchanged and sends only what changed", async () => {
    const fake = new FakeProvider();
    await explainEpisode(store, pid, ep, fake);
    expect(planUpdate(store, pid, "step", ep)!.needsModel).toBe(false); // nothing new yet
    addEvidence();

    const plan = planUpdate(store, pid, "step", ep)!;
    expect(plan.kept.map((k) => k.claim.text)).toContain("The user asked for a parser.");
    expect(plan.kept.map((k) => k.claim.text)).toContain("Parsers turn text into structure."); // background cites nothing, so nothing changed under it
    expect(plan.fresh.length).toBeGreaterThan(0);
    expect(plan.sendRefs.length).toBeLessThan(plan.allRefs); // the unchanged prompt is not re-sent
    expect(plan.estimate).not.toBeNull();

    const before = activeRevision(store, pid, "step", ep)!;
    const r = await updateStep(store, pid, ep, fake);
    const call = fake.calls[fake.calls.length - 1]!;
    expect(call.user).toContain("[K1]");
    expect(call.user).not.toContain("Add a CSV parser"); // the prompt's evidence stayed home
    expect(r.calledModel).toBe(true);
    expect(r.diff.added.map((a) => a.text)).toContain("A new statement about the new evidence.");
    expect(r.diff.kept).toBeGreaterThanOrEqual(2);
    expect(r.diff.summary).toEqual({ before: "Old summary.", after: "A new summary." });

    // Nothing is applied until the owner says so.
    expect(activeRevision(store, pid, "step", ep)!.id).toBe(before.id);
    const proposal = proposedRevision(store, pid, "step", ep)!;
    expect(proposal.meta.targeted).toBe(true);
    expect(proposal.meta.diff.added.length).toBe(r.diff.added.length);

    adoptUpdate(store, pid, "step", ep, proposal.id);
    const now = Step.parse(activeRevision(store, pid, "step", ep)!.content);
    expect(now.whatHappened[0]!.text).toBe("The user asked for a parser.");
    expect(now.whatHappened.some((c) => c.text === "A new statement about the new evidence.")).toBe(true);
    // The adopted update is the cached reading of this evidence: explaining again costs nothing.
    const n = fake.calls.length;
    const again = await explainEpisode(store, pid, ep, fake);
    expect(again.cached).toBe(true);
    expect(fake.calls.length).toBe(n);
    expect(planUpdate(store, pid, "step", ep)!.needsModel).toBe(false);
  });

  it("re-reviews a statement when the evidence it cites changes, and never touches the owner's words", async () => {
    const fake = new FakeProvider();
    await explainEpisode(store, pid, ep, fake);
    const active = activeRevision(store, pid, "step", ep)!;
    const step = Step.parse(active.content);
    step.whatHappened[1] = { ...step.whatHappened[1]!, text: "The first run failed on quoted fields (I checked).", edited: true };
    saveUserEdit(store, pid, "step", ep, step, active.id);
    // A later re-read of the test output changes what that evidence item says.
    store.ingest(pid, { sessions: [], artifacts: [], gaps: [],
      links: [{ source: CC, fromSourceEventId: "result:t1b", toSourceEventId: "tool:t1", toSource: CC, linkType: "result_of", strength: "observed", basis: "t" }],
      events: [ev("result:t1b", "test_result", 13, { tool: "Bash", status: "ok", outcome: "passed", testsPassed: 3, testsFailed: 0 })] });
    correlate(store, pid);
    rebuildEpisodes(store, pid);
    const r = await updateStep(store, pid, ep, fake);
    const proposed = Step.parse(proposedRevision(store, pid, "step", ep)!.content);
    expect(proposed.whatHappened.some((c) => c.edited && c.text === "The first run failed on quoted fields (I checked).")).toBe(true);
    expect(r.diff.removed.map((x) => x.text)).not.toContain("The first run failed on quoted fields (I checked).");
    // Adopting keeps the version marked as holding the owner's edits.
    adoptUpdate(store, pid, "step", ep, proposedRevision(store, pid, "step", ep)!.id);
    expect(activeRevision(store, pid, "step", ep)!.meta.userEdited).toBe(true);
  });
});

describe("targeted updates of a wiki page", () => {
  it("keeps statements on unchanged sources and proposes the rest", async () => {
    const fake = new FakeProvider();
    store.ingest(pid, { sessions: [], artifacts: [], gaps: [], links: [], events: [
      { sessionId: null, source: "git", sourceEventId: "c1", eventType: "git_commit", occurredAt: at(30), actor: "unknown", summary: "c1", payload: { sha: "aaa1111", message: "Add parser", files: [{ path: "src/csv.ts" }] }, captureConfidence: "observed" },
    ] });
    await generateSection(store, pid, "overview", fake);
    store.ingest(pid, { sessions: [], artifacts: [], gaps: [], links: [], events: [
      { sessionId: null, source: "git", sourceEventId: "c2", eventType: "git_commit", occurredAt: at(60), actor: "unknown", summary: "c2", payload: { sha: "bbb2222", message: "Handle quotes", files: [{ path: "src/csv.ts" }] }, captureConfidence: "observed" },
    ] });
    const plan = planUpdate(store, pid, "wiki", "overview")!;
    expect(plan.needsModel).toBe(true);
    expect(plan.kept.some((k) => k.claim.text.startsWith("About"))).toBe(true); // the first commit's source is unchanged
    const r = await updateSection(store, pid, "overview", fake);
    expect(r.diff.kept).toBeGreaterThan(0);
    expect(r.diff.added.length).toBeGreaterThan(0);
    expect(proposedRevision(store, pid, "wiki", "overview")!.meta.diff).toBeTruthy();
    adoptUpdate(store, pid, "wiki", "overview", proposedRevision(store, pid, "wiki", "overview")!.id);
    const n = fake.calls.length;
    const again = await generateSection(store, pid, "overview", fake);
    expect(again.cached).toBe(true);
    expect(fake.calls.length).toBe(n);
  });
});
