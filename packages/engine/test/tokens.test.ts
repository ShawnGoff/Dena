import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "@dena/core";
import { calibrate, DEFAULT_CHARS_PER_TOKEN, estimateTokens, formatTokens, tokensFromUsage } from "../src/index.ts";

let home: string;
let store: Store;
let pid: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "dena-tok-"));
  store = new Store(home);
  pid = store.createProject("t", "/t").id;
});
afterEach(() => {
  store.close();
  fs.rmSync(home, { recursive: true, force: true });
});

/** Records a fake explanation call whose prompt tokens follow overhead + chars / ratio exactly. */
function record(i: number, chars: number, calls: number, overhead: number, ratio: number, model = "haiku") {
  store.db.prepare(`INSERT INTO explanation (project_id, unit_id, packet_hash, prompt_version, requested_model, model, depth, generated_by, attempts, batched,
      input_chars, output_chars, content_json, validation_json, evidence_json, cost_usd, created_at, prompt_tokens, output_tokens, cache_read_tokens)
    VALUES (?, ?, ?, 2, ?, 'claude-haiku-5-5', 'thorough', 'model', ?, 0, ?, 0, '{}', '{}', '{}', 0, '2026-10-01', ?, ?, 0)`)
    .run(pid, `u${i}`, `h${i}`, model, calls, chars, Math.round(calls * overhead + chars / ratio), 2000 * calls);
}

describe("reading usage", () => {
  it("counts cache reads and writes as tokens sent (input_tokens alone undercounts)", () => {
    // The shape Claude Code 2.1.309 returned for a tiny call.
    expect(tokensFromUsage({ input_tokens: 2, cache_creation_input_tokens: 778, cache_read_input_tokens: 0, output_tokens: 4 }))
      .toEqual({ prompt: 780, output: 4, cacheRead: 0, thinking: 0 });
    expect(tokensFromUsage({ input_tokens: 10, cache_read_input_tokens: 5000, output_tokens: 900, output_tokens_details: { thinking_tokens: 300 } }))
      .toEqual({ prompt: 5010, output: 900, cacheRead: 5000, thinking: 300 });
    expect(tokensFromUsage(undefined)).toBeNull();
  });
  it("formats compactly", () => {
    expect([formatTokens(780), formatTokens(4321), formatTokens(14_200)]).toEqual(["780", "4.3k", "14k"]);
  });
});

describe("calibration", () => {
  it("uses labelled defaults until there is enough history", () => {
    const c = calibrate(store, "haiku");
    expect(c).toMatchObject({ calibrated: false, charsPerToken: DEFAULT_CHARS_PER_TOKEN });
    expect(c.basis).toContain("0 of 3 recorded calls");
  });

  it("recovers the per-call overhead and characters per token from real calls", () => {
    [[12_000, 1], [30_000, 1], [18_000, 2], [45_000, 1], [8_000, 1]].forEach(([chars, calls], i) => record(i, chars!, calls!, 1_500, 2.8));
    const c = calibrate(store, "haiku");
    expect(c.calibrated).toBe(true);
    expect(c.overheadTokens).toBeGreaterThan(1_400);
    expect(c.overheadTokens).toBeLessThan(1_600);
    expect(c.charsPerToken).toBeCloseTo(2.8, 1);
    expect(c.callsPerDoc).toBe(1.2); // one of the five documents needed a repair call
    const e = estimateTokens(store, "haiku", 20_000, 1, "thorough");
    expect(e.promptTokens).toBeGreaterThan(10_200);
    expect(e.promptTokens).toBeLessThan(10_600); // 1.2 × (1500 + 20000/2.8) ≈ 10371
    expect(e.outputTokens).toBe(2_400);
    expect(e.basis).toContain("20% repair calls");
  });

  it("keeps models separate", () => {
    [[12_000, 1], [30_000, 1], [45_000, 1]].forEach(([chars, calls], i) => record(i, chars!, calls!, 1_500, 2.8, "opus"));
    expect(calibrate(store, "haiku").calibrated).toBe(false);
    expect(calibrate(store, "opus").calibrated).toBe(true);
  });
});
