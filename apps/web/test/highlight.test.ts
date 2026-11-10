// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { mapWords, weights, wordAt, wordAtChar, wordsOf } from "../src/highlight";

describe("word marking", () => {
  it("finds each spoken word in the page text, across elements, and skips what the page does not say", () => {
    const el = document.createElement("p");
    el.innerHTML = "Install the <b>workspace</b> tools, then run it.";
    const spoken = "Dena infers that Install the workspace tools, then run it.";
    const r = mapWords(el, spoken);
    expect(r.map((x) => x?.toString() ?? null)).toEqual([null, null, null, "Install", "the", "workspace", "tools", "then", "run", "it"]);
  });
  it("does not match a short word inside a longer one", () => {
    const el = document.createElement("p");
    el.textContent = "other the end";
    expect(mapWords(el, "the end").map((x) => x?.toString())).toEqual(["the", "end"]);
  });
  it("estimates which word is being said from how far through the clip it is", () => {
    const w = weights("Short words, then a much longer sentence ending.");
    expect(wordAt(w, 0)).toBe(0);
    expect(wordAt(w, 0.999)).toBe(w.length - 1);
    expect(wordAt(w, 0.5)).toBeGreaterThan(2);
  });
  it("maps the browser's character positions to words", () => {
    const words = wordsOf("alpha beta gamma");
    expect([0, 4, 6, 11, 99].map((c) => wordAtChar(words, c))).toEqual([0, 0, 1, 2, 2]);
  });
});
