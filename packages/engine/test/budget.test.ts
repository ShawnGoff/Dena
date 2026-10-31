import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store, type NewEvent } from "@dena/core";
import { explainMany, loadEpisodes, type GenerateResult, type Provider } from "../src/index.ts";

let home: string;
let store: Store;
let pid: string;
const at = (s: number) => new Date(Date.UTC(2026, 9, 1, 12, 0, s)).toISOString();

/** Answers batch calls with a minimal step per episode, reporting 1,000 tokens sent and 300 written per call. */
class FakeProvider implements Provider {
  readonly name = "fake";
  calls = 0;
  async generate(_s: string, user: string): Promise<GenerateResult> {
    this.calls++;
    const ids = [...user.matchAll(/<episode id="([^"]+)"/g)].map((m) => m[1]!);
    const step = { title: "t", summary: "s", goal: "", prerequisites: [], instructions: [], check: [], pitfalls: [], whatHappened: [], whyItMattered: [], howItWorks: [], decisions: [], concepts: [], uncertainty: [] };
    return { json: { steps: ids.map((episode) => ({ episode, ...step })) }, model: "fake", costUsd: 0, durationMs: 1, tokens: { prompt: 1_000, output: 300, cacheRead: 0 } };
  }
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "dena-budget-"));
  store = new Store(home);
  pid = store.createProject("p", "/p").id;
  // Twelve small pieces of work, far apart in time so each is its own episode.
  const events: NewEvent[] = [];
  for (let i = 0; i < 12; i++) {
    events.push({ sessionId: `s${i}`, source: "t", sourceEventId: `p${i}`, eventType: "prompt_submitted", occurredAt: at(i * 3_600), actor: "user", summary: `Task ${i}`, payload: { text: `Task ${i}` }, captureConfidence: "observed" });
    events.push({ sessionId: `s${i}`, source: "t", sourceEventId: `f${i}`, eventType: "file_modified", occurredAt: at(i * 3_600 + 5), actor: "unknown", summary: `f${i}`, payload: { file: `src/f${i}.ts` }, captureConfidence: "observed" });
  }
  store.ingest(pid, { sessions: Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, source: "t", startedAt: at(i * 3_600), endedAt: at(i * 3_600 + 10) })), artifacts: [], gaps: [], links: [], events });
});
afterEach(() => {
  store.close();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("a token budget per run", () => {
  it("stops before the call that would cross it, and the next run carries on", async () => {
    const ids = loadEpisodes(store, pid).map((e) => e.id);
    expect(ids.length).toBe(12);
    store.updateProjectSettings(pid, { maxTokensPerRun: 3_000 });
    const fake = new FakeProvider();
    const first = await explainMany(store, pid, ids, fake);
    expect(first.spentTokens).toBe(2_600); // two calls of 1,300; a third would cross 3,000
    expect(first.skippedForBudget.length).toBe(2);
    expect(first.explained.length).toBe(10);
    const second = await explainMany(store, pid, ids, fake);
    expect(second.skippedForBudget).toEqual([]);
    expect(second.explained.filter((x) => !x.cached).length).toBe(2); // only what was left
  });
});
