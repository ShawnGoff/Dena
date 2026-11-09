import { describe, expect, it } from "vitest";
import { chunk, narrateCode, narrateStep, narrateWiki, speakable } from "../src/narrate";
import type { Step } from "../src/api";

const claim = (text: string, kind: any = "observed", extra: object = {}) => ({ text, kind, evidence: ["E1"], ...extra });
const step = (over: Partial<Step> = {}): Step => ({
  title: "Add a login page", summary: "We add a page.", whatHappened: [], whyItMattered: [], howItWorks: [], whatChanged: [], decisions: [], verification: [],
  concepts: [], uncertainty: [], generatedBy: "model", ...over,
});

describe("speakable", () => {
  it("drops citation markers, markdown and links but keeps words like S3", () => {
    expect(speakable("Use `npm test` [E3] and **run** it, see https://x.dev/a (an S3 bucket)")).toBe("Use npm test and run it, see a link (an S3 bucket)");
  });
  it("replaces fenced code with a spoken cue", () => {
    expect(speakable("Run:\n```sh\nnpm i\n```\nDone.")).toContain("code example on screen");
  });
});

describe("chunk", () => {
  it("keeps short text whole and splits long text at sentence ends under the limit", () => {
    expect(chunk("Short one.")).toEqual(["Short one."]);
    const long = Array.from({ length: 12 }, (_, i) => `This is sentence number ${i} of a long paragraph.`).join(" ");
    const parts = chunk(long);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 220)).toBe(true);
    expect(parts.join(" ")).toBe(long);
  });
  it("breaks a sentence with no punctuation at a space", () => {
    const parts = chunk("word ".repeat(150));
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 220)).toBe(true);
  });
  it("returns nothing for empty text", () => expect(chunk("  [S1] ")).toEqual([]));
});

describe("narrateStep", () => {
  it("introduces inferred and agent-said statements but not observed ones", () => {
    const t = narrateStep(step({ whatHappened: [claim("The file was created."), claim("It probably caches.", "inferred"), claim("Tests pass.", "agent_stated")] })).map((s) => s.text);
    expect(t).toContain("The file was created.");
    expect(t).toContain("Dena infers that it probably caches.");
    expect(t).toContain("The AI said that tests pass.");
  });
  it("leads instruction-style steps with the goal and numbered steps, and flags code on screen", () => {
    const segs = narrateStep(step({ goal: "a login page", instructions: [claim("Create the file.", "observed", { code: "touch a.ts" }), claim("Add a route.")], pitfalls: [claim("Forgot the route.")] }));
    const t = segs.map((s) => s.text);
    expect(t).toContain("What you'll build: a login page");
    expect(t).toContain("Step 1. Create the file. The code for this is on screen.");
    expect(t).toContain("Step 2. Add a route.");
    expect(segs.find((s) => s.text.startsWith("If it goes wrong"))?.anchor).toBe("pitfalls");
    expect(t.some((x) => x.startsWith("What happened"))).toBe(false);
  });
  it("says a statement marked incorrect is incorrect", () => {
    const t = narrateStep(step({ whatHappened: [claim("Bad claim.", "observed", { flagged: "incorrect" })] })).map((s) => s.text);
    expect(t.some((x) => x.startsWith("This statement was marked incorrect: Bad claim."))).toBe(true);
  });
});

describe("narrateWiki and narrateCode", () => {
  it("numbers tutorial statements and anchors sections by position", () => {
    const segs = narrateWiki({ title: "T", summary: "S.", sections: [{ heading: "One", claims: [claim("Do a.")] }, { heading: "Two", claims: [claim("Do b.")] }], uncertainty: [], learn: [{ concept: "Hashing", explanation: "Maps data." }] }, true);
    expect(segs.find((s) => s.text === "Step 1. Do a.")?.anchor).toBe("section:0");
    expect(segs.find((s) => s.text === "Step 1. Do b.")?.anchor).toBe("section:1");
    expect(segs.at(-1)).toEqual({ text: "Hashing. Maps data.", anchor: "learn" });
  });
  it("reads explained parts in order and skips parts changed since they were explained", () => {
    const doc = (s: string) => ({ summary: s, how: ["First."], learn: [], watch: ["Careful."] });
    const segs = narrateCode({ path: "src/a/tokens.ts", fileDoc: { purpose: "Counts tokens.", fitsIn: [], learn: [], readingOrder: [] },
      symbols: [{ key: "count", status: "current", doc: doc("Counts.") }, { key: "old", status: "changed", doc: doc("Stale.") }, { key: "new", status: "new", doc: null }] });
    const t = segs.map((s) => s.text);
    expect(t[0]).toBe("tokens.ts.");
    expect(t).toContain("count. Counts.");
    expect(t).toContain("Watch out: Careful.");
    expect(t.join(" ")).not.toContain("Stale");
    expect(segs.find((s) => s.text === "1. First.")?.anchor).toBe("sym:count");
  });
});
