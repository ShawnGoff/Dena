import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store, type NewEvent } from "@dena/core";
import { buildBrief, generateSection, rebuildEpisodes, sectionKeys, validateSection, type GenerateResult, type Provider, type WikiSection } from "../src/index.ts";

let home: string;
let store: Store;
let pid: string;
const at = (m: number) => new Date(Date.UTC(2026, 9, 1, 10, m)).toISOString();
const ev = (sid: string, eventType: NewEvent["eventType"], m: number, payload: Record<string, unknown>, extra: Partial<NewEvent> = {}): NewEvent => ({
  sessionId: null, source: "t", sourceEventId: sid, eventType, occurredAt: at(m), actor: "unknown", summary: sid, payload, captureConfidence: "observed", ...extra,
});

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "dena-wiki-"));
  store = new Store(home);
  pid = store.createProject("csv", "/p").id;
  store.ingest(pid, { sessions: [], artifacts: [], links: [], gaps: [], events: [
    ev("p1", "prompt_submitted", 0, { text: "Build a CSV parser" }, { actor: "user", summary: "Build a CSV parser" }),
    ev("c1", "git_commit", 2, { sha: "aaa1111", message: "Add parser", files: [{ path: "src/parse/csv.ts", added: 40, removed: 0 }, { path: "src/parse/quote.ts", added: 10, removed: 0 }] }),
    ev("p2", "prompt_submitted", 100, { text: "Add a CLI" }, { actor: "user", summary: "Add a CLI" }),
    ev("c2", "git_commit", 102, { sha: "bbb2222", message: "Add CLI", files: [{ path: "src/cli/main.ts", added: 30, removed: 0 }, { path: "src/parse/csv.ts", added: 2, removed: 1 }] }),
  ] });
  rebuildEpisodes(store, pid);
});
afterEach(() => {
  store.close();
  fs.rmSync(home, { recursive: true, force: true });
});

const page = (claims: WikiSection["sections"][number]["claims"]): WikiSection => ({ title: "t", summary: "s", sections: [{ heading: "H", claims }], uncertainty: [] });

class Fake implements Provider {
  name = "fake";
  calls = 0;
  constructor(private readonly answers: WikiSection[]) {}
  async generate(): Promise<GenerateResult> {
    return { json: this.answers[Math.min(this.calls++, this.answers.length - 1)], model: "fake", costUsd: 0.001, durationMs: 1 };
  }
}

describe("wiki briefs", () => {
  it("offers overview, architecture and component pages, with sources that all reach events", () => {
    expect(sectionKeys(store, pid).map((s) => s.key)).toEqual(expect.arrayContaining(["overview", "architecture", "component:src/parse"]));
    const b = buildBrief(store, pid, "component:src/parse");
    expect(b.sources.length).toBeGreaterThan(0);
    expect(b.sources.every((s) => s.eventIds.length > 0)).toBe(true);
    expect(b.sources.some((s) => s.text.includes('"Add parser"'))).toBe(true);
  });
});

describe("wiki validation (two-step citations)", () => {
  it("rejects missing sources, uncited claims, and claims stronger than their sources", () => {
    const b = buildBrief(store, pid, "overview");
    b.sources.push({ ref: "S90", type: "claim", grade: "agent_stated", text: "The AI said it chose X", unitId: null, eventIds: [1] });
    b.sources.push({ ref: "S91", type: "claim", grade: "inferred", text: "a reading", unitId: null, eventIds: [] });
    const v = validateSection(page([
      { text: "Uses a database.", kind: "observed", evidence: ["S99"] },
      { text: "Was refactored twice.", kind: "inferred", evidence: [] },
      { text: "X was chosen for speed.", kind: "observed", evidence: ["S90"] },
      { text: "Something.", kind: "inferred", evidence: ["S91"] },
      { text: "CSV quoting is tricky.", kind: "background", evidence: [] },
    ]), b);
    const msgs = v.issues.map((i) => i.message).join("\n");
    expect(msgs).toContain("do not exist: S99");
    expect(msgs).toContain("inferred claim cites no sources");
    expect(msgs).toContain("observed claim rests only on agent_stated sources");
    expect(msgs).toContain("does not reach captured events");
    expect(v.counts.background).toBe(1);
  });
});

describe("generateSection", () => {
  it("writes a page, repairs once, caches by brief, and regenerates when the evidence changes", async () => {
    const good = page([{ text: "The parser was added first.", kind: "observed", evidence: ["S2"] }]);
    const bad = page([{ text: "It used a database.", kind: "observed", evidence: ["S77"] }]);
    const fake = new Fake([bad, good]);
    const s = await generateSection(store, pid, "overview", fake);
    expect(s).toMatchObject({ attempts: 2, cached: false });
    expect(s.validation.ok).toBe(true);
    expect((await generateSection(store, pid, "overview", fake)).cached).toBe(true);
    expect(fake.calls).toBe(2);

    store.ingest(pid, { sessions: [], artifacts: [], links: [], gaps: [], events: [
      ev("c3", "git_commit", 200, { sha: "ccc3333", message: "Docs", files: [{ path: "README.md", added: 5, removed: 0 }] })] });
    rebuildEpisodes(store, pid);
    expect((await generateSection(store, pid, "overview", new Fake([good]))).cached).toBe(false);
  });
});
