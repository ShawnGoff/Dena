import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HOOK_SCRIPT } from "./hooks.ts";

/**
 * Installs Dena's hook into Claude Code settings. Changing someone's tool configuration is an
 * outward-facing action, so: the plan is shown first, nothing is written without explicit
 * confirmation, the original file is backed up, unrelated settings are preserved exactly, and
 * uninstall removes only what Dena added (recognised by the hook script's path).
 *
 *   project scope: <root>/.claude/settings.local.json — sessions launched in that folder
 *   user scope:    ~/.claude/settings.json            — every session; the hook still captures
 *                                                       nothing unless a Dena project is recording
 */

export type Scope = "project" | "user";
const MARK = "dena-hook.mjs";
const EVENTS: { event: string; matcher?: string; sync?: boolean }[] = [
  { event: "SessionStart", sync: true }, // its output teaches the agent the notes channel
  { event: "UserPromptSubmit" },
  { event: "PostToolUse", matcher: "*" },
  { event: "PostToolUseFailure", matcher: "*" },
  { event: "SubagentStop" },
  { event: "SessionEnd" },
];

const q = (p: string) => (/[\s"'$`\\]/.test(p) ? `"${p.replace(/(["\\$`])/g, "\\$1")}"` : p);

export function settingsFile(scope: Scope, root?: string, claudeHome = path.join(os.homedir(), ".claude")): string {
  if (scope === "user") return path.join(claudeHome, "settings.json");
  if (!root) throw new Error("project scope needs a project root");
  return path.join(root, ".claude", "settings.local.json");
}

export function hookCommand(home: string): string {
  return `node ${q(HOOK_SCRIPT)} --home ${q(home)}`;
}

export function noteAllowRule(): string {
  return `Bash(node ${q(HOOK_SCRIPT)} note:*)`;
}

export interface Plan {
  file: string;
  before: Record<string, any> | null;
  after: Record<string, any>;
  changed: boolean;
}

function load(file: string): Record<string, any> | null {
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, "utf8");
  try {
    return text.trim() ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${file} is not valid JSON; Dena will not modify it. Fix or remove it first.`);
  }
}

function strip(settings: Record<string, any>): Record<string, any> {
  const s = structuredClone(settings);
  if (s.hooks && typeof s.hooks === "object") {
    for (const [event, groups] of Object.entries<any[]>(s.hooks)) {
      if (!Array.isArray(groups)) continue;
      const kept = groups
        .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h: any) => !String(h.command ?? "").includes(MARK)) }))
        .filter((g) => g.hooks.length > 0);
      if (kept.length) s.hooks[event] = kept;
      else delete s.hooks[event];
    }
    if (Object.keys(s.hooks).length === 0) delete s.hooks;
  }
  if (Array.isArray(s.permissions?.allow)) {
    s.permissions.allow = s.permissions.allow.filter((r: string) => !String(r).includes(MARK));
    if (s.permissions.allow.length === 0) delete s.permissions.allow;
    if (Object.keys(s.permissions).length === 0) delete s.permissions;
  }
  return s;
}

export function planInstall(scope: Scope, home: string, root?: string, claudeHome?: string): Plan {
  const file = settingsFile(scope, root, claudeHome);
  const before = load(file);
  const after = strip(before ?? {});
  after.hooks ??= {};
  const command = hookCommand(home);
  for (const { event, matcher, sync } of EVENTS) {
    const hook: Record<string, unknown> = { type: "command", command, timeout: sync ? 5 : 10 };
    if (!sync) hook.async = true;
    (after.hooks[event] ??= []).push({ ...(matcher ? { matcher } : {}), hooks: [hook] });
  }
  after.permissions ??= {};
  after.permissions.allow = [...(after.permissions.allow ?? []), noteAllowRule()];
  return { file, before, after, changed: JSON.stringify(before) !== JSON.stringify(after) };
}

export function planUninstall(scope: Scope, root?: string, claudeHome?: string): Plan {
  const file = settingsFile(scope, root, claudeHome);
  const before = load(file);
  const after = strip(before ?? {});
  return { file, before, after, changed: before !== null && JSON.stringify(before) !== JSON.stringify(after) };
}

export function applyPlan(plan: Plan): string | null {
  if (!plan.changed) return null;
  fs.mkdirSync(path.dirname(plan.file), { recursive: true });
  let backup: string | null = null;
  if (plan.before !== null) {
    backup = `${plan.file}.dena-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    fs.copyFileSync(plan.file, backup);
  }
  const tmp = `${plan.file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(plan.after, null, 2) + "\n");
  fs.renameSync(tmp, plan.file);
  return backup;
}

export function installedIn(scope: Scope, root?: string, claudeHome?: string): boolean {
  try {
    const s = load(settingsFile(scope, root, claudeHome));
    return JSON.stringify(s?.hooks ?? {}).includes(MARK);
  } catch {
    return false;
  }
}
