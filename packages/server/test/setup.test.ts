import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pluginInstalled, requiredDone, setupSteps } from "../src/setup.ts";

const facts = { claudeFound: true, projects: 1, recording: 1, liveCapture: false };

describe("first-run checklist", () => {
  it("is ready once Claude Code, a project and a recording are there, even without live capture", () => {
    const steps = setupSteps(facts);
    expect(requiredDone(steps)).toBe(true);
    expect(steps.find((s) => s.id === "capture")).toMatchObject({ required: false, done: false });
  });

  it("names the first missing required step", () => {
    expect(requiredDone(setupSteps({ ...facts, projects: 0, recording: 0 }))).toBe(false);
    const steps = setupSteps({ ...facts, claudeFound: false });
    expect(steps.find((s) => s.id === "claude")).toMatchObject({ done: false, required: true });
  });
});

describe("pluginInstalled", () => {
  it("reads Claude Code's enabled plugins for a dena plugin", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dena-setup-"));
    try {
      expect(pluginInstalled(dir)).toBe(false);
      fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ enabledPlugins: { "other@x": true } }));
      expect(pluginInstalled(dir)).toBe(false);
      fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ enabledPlugins: { "dena@dena": false } }));
      expect(pluginInstalled(dir)).toBe(false);
      fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ enabledPlugins: { "dena@dena": true } }));
      expect(pluginInstalled(dir)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
