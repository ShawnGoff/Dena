import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The first-run checklist: what Dena needs before it can explain anything (required), and what
 * makes it see more (optional). It only reads state; nothing here changes a setting.
 */

export interface SetupStep { id: string; label: string; required: boolean; done: boolean; detail: string }

export interface SetupFacts {
  claudeFound: boolean;
  projects: number;
  recording: number;
  /** The Dena plugin is enabled, or a project or your Claude Code settings have Dena's hooks. */
  liveCapture: boolean;
}

export function setupSteps(f: SetupFacts): SetupStep[] {
  return [
    {
      id: "claude", label: "Claude Code is installed", required: true, done: f.claudeFound,
      detail: f.claudeFound ? "Found on this computer." : "Install Claude Code, or set DENA_CLAUDE_BIN to its path.",
    },
    {
      id: "project", label: "Add the folder you work on", required: true, done: f.projects > 0,
      detail: f.projects > 0 ? `${f.projects} ${f.projects === 1 ? "project" : "projects"} added.` : "Use + Add project on the left.",
    },
    {
      id: "recording", label: "Start recording a project", required: true, done: f.recording > 0,
      detail: f.recording > 0 ? `${f.recording} ${f.recording === 1 ? "project is" : "projects are"} being recorded.` : "Open the project and press Start recording.",
    },
    {
      id: "capture", label: "Live capture from Claude Code", required: false, done: f.liveCapture,
      detail: "Adds exit codes, timings and the notes channel. Install the Dena plugin, or run dena hooks install <project>.",
    },
  ];
}

/** Ready once every required step is done. The optional steps stay on the list until they are done. */
export const requiredDone = (steps: SetupStep[]) => steps.every((s) => !s.required || s.done);

/** Whether the Dena plugin is switched on in Claude Code's user settings. */
export function pluginInstalled(claudeHome = path.join(os.homedir(), ".claude")): boolean {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(claudeHome, "settings.json"), "utf8"));
    return Object.entries<unknown>(s.enabledPlugins ?? {}).some(([name, on]) => on === true && /^dena@/.test(name));
  } catch {
    return false;
  }
}
