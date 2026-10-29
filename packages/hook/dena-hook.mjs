#!/usr/bin/env node
/**
 * Claude Code hook forwarder for Dena.
 *
 * Runs inside the user's Claude Code session, so it must be fast and must never break that
 * session: no dependencies, no database, and every failure exits 0 silently.
 *
 * It appends *metadata only* (ids, paths, exit codes, timings) to a local spool file. Prompt
 * text and tool output are not copied: Dena reads those from the transcript the hook points
 * at, with redaction, and only for projects being recorded.
 *
 *   dena-hook.mjs [--home DIR]                  hook mode, reads the hook JSON on stdin
 *   dena-hook.mjs note <kind> <<'NOTE' … NOTE   agent notes (the note text lives in the transcript)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const homeAt = args.indexOf("--home");
const HOME = homeAt >= 0 ? args[homeAt + 1] : (process.env.DENA_HOME ?? path.join(os.homedir(), ".dena"));
const SELF = fileURLToPath(import.meta.url);

if (args[0] === "note") {
  process.stdout.write("Noted for Dena.\n");
  process.exit(0);
}

const within = (p, root) => {
  if (!p || !root) return false;
  const r = path.relative(root, p);
  return r === "" || (!r.startsWith("..") && !path.isAbsolute(r));
};

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

const firstLine = (s, max = 200) => (typeof s === "string" ? s.split("\n")[0].slice(0, max) : undefined);

function notesInstructions() {
  const cmd = SELF.includes(" ") ? `node "${SELF}"` : `node ${SELF}`;
  return [
    "Dena is recording this project to build a guide that explains how it was built.",
    "When you make a non-obvious choice (an approach, library or trade-off) or find the cause of a problem, record one short note:",
    `${cmd} note decision <<'NOTE'`,
    "<one or two sentences: what you chose or found, and why>",
    "NOTE",
    "Kinds: decision, cause, assumption, todo. Note only what you actually considered; skip routine steps.",
    "Notes are shown to the user as your stated rationale, not as verified fact.",
  ].join("\n");
}

try {
  const raw = readStdin();
  if (!raw.trim()) process.exit(0);
  const input = JSON.parse(raw);

  let projects = [];
  try {
    projects = JSON.parse(fs.readFileSync(path.join(HOME, "recording.json"), "utf8")).projects ?? [];
  } catch {
    process.exit(0); // Dena not set up or nothing recorded yet
  }
  const recording = projects.filter((p) => p.state === "recording");
  if (recording.length === 0) process.exit(0); // paused or stopped: capture nothing

  const sessionDir = process.env.CLAUDE_PROJECT_DIR ?? input.cwd;
  const ti = input.tool_input ?? {};
  const tr = input.tool_response ?? {};
  const record = {
    received_at: new Date().toISOString(),
    hook_event_name: input.hook_event_name,
    session_id: input.session_id,
    prompt_id: input.prompt_id,
    transcript_path: input.transcript_path,
    agent_transcript_path: input.agent_transcript_path,
    agent_id: input.agent_id,
    cwd: input.cwd,
    project_dir: process.env.CLAUDE_PROJECT_DIR,
    source: input.source,
    reason: input.reason,
    model: input.model,
    tool_name: input.tool_name,
    tool_use_id: input.tool_use_id,
    file_path: typeof ti.file_path === "string" ? ti.file_path : undefined,
    duration_ms: input.duration_ms,
    is_interrupt: input.is_interrupt,
    exit_code: (() => {
      const m = typeof input.error === "string" ? input.error.match(/^Exit code (\d+)/) : null;
      return m ? Number(m[1]) : undefined;
    })(),
    error_kind: firstLine(input.error, 60),
    bash_changed_files: Array.isArray(tr.bashEditDiff?.changedFiles) ? tr.bashEditDiff.changedFiles.slice(0, 200) : undefined,
  };
  const spool = path.join(HOME, "spool");
  fs.mkdirSync(spool, { recursive: true });
  fs.appendFileSync(path.join(spool, `hooks-${record.received_at.slice(0, 10)}.jsonl`), JSON.stringify(record) + "\n");

  if (input.hook_event_name === "SessionStart" && recording.some((p) => within(sessionDir, p.root) || within(input.cwd, p.root))) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: notesInstructions() } }));
  }
} catch {
  // never interfere with the user's session
}
process.exit(0);
