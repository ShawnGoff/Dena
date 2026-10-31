import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { transcriptsIn } from "./transcript.ts";

/**
 * Folders you have worked in with Claude Code, read from where its transcripts say each session
 * ran (the `cwd` field). Only the start of each transcript is read, and nothing is stored: this is
 * how Dena offers to add a project you started, without recording anything until you say yes.
 */

export interface UsedFolder {
  path: string;
  sessions: number;
  lastUsed: string;
  firstSeen: string;
}

/** Places that are not projects: temporary folders, app data, your home folder itself. */
export function isWorkFolder(dir: string, home = os.homedir()): boolean {
  const d = path.resolve(dir);
  if (d === home || d === "/" || !d.startsWith("/")) return false;
  return ![/^\/(private\/)?tmp(\/|$)/, /^\/private\/var\//, /^\/var\/folders\//, /\/Library\//, /\/\.claude(\/|$)/, /\/\.Trash(\/|$)/, /\/node_modules(\/|$)/].some((re) => re.test(d));
}

function cwdOf(file: string): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(256 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    for (const line of buf.subarray(0, n).toString("utf8").split("\n")) {
      if (!line.includes('"cwd"')) continue;
      try {
        const cwd = JSON.parse(line).cwd;
        if (typeof cwd === "string" && cwd) return cwd;
      } catch { /* a line cut at the end of the read */ }
    }
  } catch { /* unreadable */ } finally {
    if (fd !== null) fs.closeSync(fd);
  }
  return null;
}

/** When a session last had a message: the newest timestamp near the end of its transcript (the file's date can be touched without new messages). */
function lastActivity(file: string, fallbackMs: number): string {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 128 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const stamps = [...buf.toString("utf8").matchAll(/"timestamp":"(\d{4}-\d\d-\d\dT[^"]+)"/g)].map((m) => m[1]!);
    if (stamps.length) return stamps.sort()[stamps.length - 1]!;
  } catch { /* unreadable */ } finally {
    if (fd !== null) fs.closeSync(fd);
  }
  return new Date(fallbackMs).toISOString();
}

/** Every folder Claude Code sessions ran in, most recently used first. */
export function foldersUsedWithClaude(claudeHome = path.join(os.homedir(), ".claude"), opts: { perFolder?: number } = {}): UsedFolder[] {
  const base = path.join(claudeHome, "projects");
  if (!fs.existsSync(base)) return [];
  const found = new Map<string, UsedFolder>();
  for (const d of fs.readdirSync(base, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const files = transcriptsIn(path.join(base, d.name)).filter((f) => !f.includes(`${path.sep}subagents${path.sep}`))
      .map((f) => ({ f, mtime: fs.statSync(f).mtimeMs })).sort((a, b) => b.mtime - a.mtime).slice(0, opts.perFolder ?? 40);
    for (const { f, mtime } of files) {
      const cwd = cwdOf(f);
      if (!cwd) continue;
      const at = lastActivity(f, mtime);
      const u = found.get(cwd) ?? { path: cwd, sessions: 0, lastUsed: at, firstSeen: at };
      u.sessions++;
      if (at > u.lastUsed) u.lastUsed = at;
      if (at < u.firstSeen) u.firstSeen = at;
      found.set(cwd, u);
    }
  }
  return [...found.values()].sort((a, b) => b.lastUsed.localeCompare(a.lastUsed));
}
