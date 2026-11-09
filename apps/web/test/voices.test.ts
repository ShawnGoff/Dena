import { describe, expect, it } from "vitest";
import { chooseVoices } from "../src/voices";

const v = (name: string, localService = true, lang = "en-US") => ({ voiceURI: name, name, lang, localService });

describe("chooseVoices", () => {
  it("hides novelty and robotic legacy voices and non-English ones", () => {
    const { list } = chooseVoices([v("Samantha"), v("Zarvox"), v("Bad News"), v("Fred"), v("Amelie", true, "fr-FR"), v("Daniel", true, "en-GB")]);
    expect(list.map((c) => c.voice.name)).toEqual(["Samantha", "Daniel"]);
  });
  it("ranks premium voices first and online voices last, and only picks a local premium voice as best", () => {
    const r = chooseVoices([v("Google US English", false), v("Samantha"), v("Ava (Premium)"), v("Zoe (Enhanced)")]);
    expect(r.list.map((c) => c.voice.name)).toEqual(["Ava (Premium)", "Zoe (Enhanced)", "Samantha", "Google US English"]);
    expect(r.best?.name).toBe("Ava (Premium)");
    expect(r.hasPremium).toBe(true);
  });
  it("labels online voices as sending text out, and never prefers them", () => {
    const r = chooseVoices([v("Google UK English Female (Natural)", false), v("Samantha")]);
    expect(r.list.find((c) => c.online)?.label).toMatch(/online/);
    expect(r.best).toBeUndefined();
    expect(r.hasPremium).toBe(false);
  });
});
