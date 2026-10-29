import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { displaySummary, effectiveTest, Store, testOutcome, type NewEvent } from "../src/index.ts";

describe("testOutcome failure markers", () => {
  it("reads a failure from 'not ok' and node's ERR_TEST_FAILURE when the summary was cut off (cases from real Worklens runs)", () => {
    expect(testOutcome("npm test 2>&1 | head -40", "ok 1 - a\nnot ok 2 - b\n  ---\n  failureType: 'testCodeFailure'", false, false))
      .toMatchObject({ outcome: "failed", failed: 1 });
    expect(testOutcome("npm test | tail", "error: 'digest is not defined'\n  code: 'ERR_TEST_FAILURE'", false, false).outcome).toBe("failed");
    expect(testOutcome("npx vitest | tail", " FAIL  src/a.test.ts > parses", false, false).outcome).toBe("failed");
  });
  it("reads node's spec-reporter summary", () => {
    expect(testOutcome("node --test | cat", "ℹ tests 5\nℹ pass 5\nℹ fail 0", false, false)).toMatchObject({ outcome: "passed", passed: 5, failed: 0 });
  });
  it("never concludes passed from missing failure lines", () => {
    expect(testOutcome("npm test | grep ok", "ok 1 - a\nok 2 - b", false, false).outcome).toBe("unknown");
  });
});

let home: string;
let store: Store;
let pid: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "dena-lbl-"));
  store = new Store(home);
  pid = store.createProject("l", "/l").id;
});
afterEach(() => {
  store.close();
  fs.rmSync(home, { recursive: true, force: true });
});

const run = (sid: string, payload: Record<string, unknown>, summary: string): NewEvent => ({
  sessionId: null, source: "t", sourceEventId: sid, eventType: "test_result", occurredAt: "2026-10-01T10:00:00Z",
  actor: "ai_agent", summary, payload: { tool: "Bash", ...payload }, captureConfidence: "derived",
});

describe("derived labels", () => {
  it("never knows less than the capture did", () => {
    store.ingest(pid, { sessions: [], artifacts: [], links: [], gaps: [], events: [
      run("k1", { command: "npm test", status: "ok", outcome: "passed", testsPassed: 4, testsFailed: 0, outcomeBasis: "parsed from TAP summary" }, "x"),
      run("k2", { command: "npm test", status: "error", outcome: "failed", testsPassed: 2, testsFailed: 1, stdout: "FAIL thing" }, "y"),
    ] });
    const [a, b] = store.timeline(pid);
    expect(effectiveTest(a!)).toMatchObject({ outcome: "passed", passed: 4, relabelled: false }); // output not kept: keep the capture
    expect(effectiveTest(b!)).toMatchObject({ outcome: "failed", passed: 2, failed: 1 }); // agree: keep the captured counts
  });

  it("relabels a run recorded as unknown, without changing the stored event", () => {
    store.ingest(pid, { sessions: [], artifacts: [], links: [], gaps: [], events: [
      run("r1", { command: "npm test 2>&1 | head", status: "ok", outcome: "unknown", stdout: "not ok 3 - digest\n  code: 'ERR_TEST_FAILURE'" }, "Tests ran, outcome unknown"),
    ] });
    const [e] = store.timeline(pid);
    expect(e!.payload.outcome).toBe("unknown"); // captured record untouched
    expect(effectiveTest(e!)).toMatchObject({ outcome: "failed", relabelled: true });
    expect(displaySummary(e!)).toBe("Tests failed (? passed, 1 failed)");
  });

  it("uses the full output stored as an artifact when the inline excerpt was cut", () => {
    const long = "ok\n".repeat(1500) + "not ok 99 - late failure\n";
    store.ingest(pid, { sessions: [], links: [], gaps: [],
      events: [run("r2", { command: "npm test | tail -5", status: "ok", outcome: "unknown", stdout: long.slice(0, 2000) }, "Tests ran, outcome unknown")],
      artifacts: [{ sourceEventId: "r2", role: "output", artifactType: "command_output", content: long }] });
    expect(effectiveTest(store.timeline(pid)[0]!).outcome).toBe("failed");
  });

  it("labels new events incrementally and recomputes everything when the rules version changes", () => {
    store.ingest(pid, { sessions: [], artifacts: [], links: [], gaps: [], events: [run("a", { command: "npx vitest run", status: "ok", outcome: "passed", stdout: "Tests 3 passed" }, "x")] });
    expect(store.timeline(pid)[0]!.labels?.test.outcome).toBe("passed");
    store.ingest(pid, { sessions: [], artifacts: [], links: [], gaps: [], events: [run("b", { command: "npx vitest run", status: "error", outcome: "failed", stdout: "Tests 1 failed | 2 passed" }, "y")] });
    expect(store.timeline(pid).map((e) => e.labels?.test.outcome)).toEqual(["passed", "failed"]);
    store.setCursor(pid, "labels", "rules_version", "0"); // as if labelled by older rules
    expect(store.ensureLabels(pid)).toBe(2);
  });
});
