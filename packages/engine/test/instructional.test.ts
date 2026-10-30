import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { correlate, Store, type NewEvent } from "@dena/core";
import {
  activeRevision, buildBrief, buildPacket, explainEpisode, exportGuideMarkdown, rebuildEpisodes, Step, tutorialPlan, writeTutorial,
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
const refOf = (kind: string) => buildPacket(store, pid, ep).items.find((x) => x.kind === kind)!.ref;

/** Writes a step as instructions; its second instruction's code is not in the evidence. */
class FakeProvider implements Provider {
  readonly name = "fake";
  calls: { user: string; schema: any }[] = [];
  async generate(_s: string, user: string, schema: any): Promise<GenerateResult> {
    this.calls.push({ user, schema });
    if (schema.properties.sections) { // the tutorial page
      const s = /^\[(S\d+)\] CLAIM.*instruction 1/m.exec(user)![1]!;
      return { json: { title: "Build p yourself", summary: "s", sections: [{ heading: "Add the parser", claims: [{ text: "Create src/csv.ts with a parse function.", kind: "observed", evidence: [s], code: "export function parse(line) {" }] }],
        uncertainty: [], learn: [] }, model: "fake", costUsd: 0, durationMs: 1 };
    }
    return { json: {
      title: "Add a CSV parser", summary: "The AI wrote a parser and tested it.", goal: "A parse function for CSV lines, with a passing test.",
      prerequisites: [],
      instructions: [
        { text: "Create src/csv.ts with a parse function that splits a line on commas.", kind: "observed", evidence: [refOf("file_change")], code: "export function parse(line) {" },
        { text: "Run the tests.", kind: "observed", evidence: [refOf("test")], code: "npm run made-up-command --everything" },
      ],
      check: [{ text: "The test run reports 3 passed, 0 failed.", kind: "observed", evidence: [refOf("test")] }],
      pitfalls: [], whatHappened: [{ text: "The AI wrote the parser.", kind: "observed", evidence: [refOf("file_change")] }],
      whyItMattered: [], howItWorks: [], decisions: [], concepts: [], uncertainty: [] }, model: "fake", costUsd: 0, durationMs: 1, tokens: { prompt: 1000, output: 300, cacheRead: 0 } };
  }
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "dena-ins-"));
  store = new Store(home);
  pid = store.createProject("p", "/p").id;
  store.ingest(pid, {
    sessions: [{ id: "s1", source: CC, startedAt: at(0), endedAt: at(60) }], artifacts: [{ sourceEventId: "file:w1", role: "diff", artifactType: "diff", content: "+export function parse(line) {\n+  return line.split(',');\n+}" }], gaps: [],
    links: [
      { source: CC, fromSourceEventId: "result:t1", toSourceEventId: "tool:t1", toSource: CC, linkType: "result_of", strength: "observed", basis: "t" },
      { source: CC, fromSourceEventId: "file:w1", toSourceEventId: "tool:w1", toSource: CC, linkType: "modified_file", strength: "observed", basis: "t" },
    ],
    events: [
      ev("u1", "prompt_submitted", 0, { text: "Add a CSV parser" }, { actor: "user" }),
      ev("tool:w1", "tool_invoked", 3, { tool: "Write", input: { file_path: "/p/src/csv.ts" } }),
      ev("file:w1", "file_created", 3, { file: "src/csv.ts", tool: "Write", linesAdded: 3 }),
      ev("tool:t1", "tool_invoked", 10, { tool: "Bash", input: { command: "npm test" } }),
      ev("result:t1", "test_result", 12, { tool: "Bash", status: "ok", outcome: "passed", testsPassed: 3, testsFailed: 0 }),
    ],
  });
  correlate(store, pid);
  ep = rebuildEpisodes(store, pid)[0]!.id;
});
afterEach(() => {
  store.close();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("steps written as instructions", () => {
  it("asks for instructions, keeps their code, and flags code that is not in the evidence", async () => {
    const fake = new FakeProvider();
    const x = await explainEpisode(store, pid, ep, fake);
    expect(fake.calls[0]!.schema.properties.instructions.items.required).toContain("code");
    expect(x.step.instructions.map((c) => c.code)).toEqual(["export function parse(line) {", "npm run made-up-command --everything"]);
    const codeWarnings = x.validation.issues.filter((i) => i.message.includes("not in the captured evidence"));
    expect(codeWarnings.map((i) => i.claim)).toEqual(["Run the tests."]); // the first one's code is in the diff
    expect(codeWarnings[0]!.severity).toBe("warning");
    const md = exportGuideMarkdown(store, pid).markdown;
    expect(md).toContain("**What you'll build:** A parse function");
    expect(md).toContain("1. **✓ Observed** — Create src/csv.ts");
    expect(md).toContain("#### How the AI did it");
  });

  it("still reads steps written before instructions existed", () => {
    const old = Step.parse({ title: "t", summary: "s", whatHappened: [], whyItMattered: [], howItWorks: [], decisions: [], concepts: [], uncertainty: [], whatChanged: [], verification: [] });
    expect(old.instructions).toEqual([]);
    expect(old.goal).toBe("");
  });
});

describe("the whole-project tutorial", () => {
  it("states its cost first, then is written from the steps' instructions", async () => {
    let plan = tutorialPlan(store, pid);
    expect(plan).toMatchObject({ steps: 1, explained: 0, written: false });
    expect(plan.missing).toEqual([ep]);
    expect(plan.explainEstimate!.tokensHigh).toBeGreaterThan(0);

    const fake = new FakeProvider();
    const r = await writeTutorial(store, pid, fake, { explainRest: true });
    expect(r.explainedNow).toBe(1); // explained first, then written
    const tut = fake.calls[fake.calls.length - 1]!;
    expect(tut.user).toContain('instruction 1: Create src/csv.ts with a parse function');
    expect(tut.user).toContain("Code: export function parse(line) {");
    expect(tut.schema.properties.sections.items.properties.claims.items.required).toContain("code");
    expect(r.page.section.sections[0]!.claims[0]!.code).toBe("export function parse(line) {");
    plan = tutorialPlan(store, pid);
    expect(plan).toMatchObject({ explained: 1, asInstructions: 1, written: true, missing: [] });
    expect(buildBrief(store, pid, "tutorial").sources.some((s) => s.text.includes("goal: A parse function"))).toBe(true);
    expect(activeRevision(store, pid, "wiki", "tutorial")).not.toBeNull();
  });
});
