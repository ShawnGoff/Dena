import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EVENTS } from "../../adapters/src/claude-code/install.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const source = path.join(root, "packages/hook/dena-hook.mjs");
const copy = path.join(root, "plugins/dena/hooks/dena-hook.mjs");
const hooksFile = path.join(root, "plugins/dena/hooks/hooks.json");

describe("Claude Code plugin", () => {
  it("ships the same hook script as the one the project installer uses", () => {
    expect(fs.readFileSync(copy, "utf8")).toBe(fs.readFileSync(source, "utf8"));
  });

  it("hooks the same events, with the same matchers, as the project installer", () => {
    const hooks = JSON.parse(fs.readFileSync(hooksFile, "utf8")).hooks as Record<string, { matcher?: string; hooks: { command: string }[] }[]>;
    expect(Object.keys(hooks).sort()).toEqual(EVENTS.map((e) => e.event).sort());
    for (const { event, matcher } of EVENTS) {
      const group = hooks[event]![0]!;
      expect(group.matcher).toBe(matcher);
      expect(group.hooks[0]!.command).toContain("${CLAUDE_PLUGIN_ROOT}/hooks/dena-hook.mjs");
    }
  });

  it("is listed in the marketplace file at its own folder", () => {
    const market = JSON.parse(fs.readFileSync(path.join(root, ".claude-plugin/marketplace.json"), "utf8"));
    const plugin = JSON.parse(fs.readFileSync(path.join(root, "plugins/dena/.claude-plugin/plugin.json"), "utf8"));
    expect(market.plugins[0].name).toBe(plugin.name);
    expect(fs.existsSync(path.join(root, market.plugins[0].source, ".claude-plugin/plugin.json"))).toBe(true);
  });
});
