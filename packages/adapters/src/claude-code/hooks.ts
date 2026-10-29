import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { redactText, type IngestBatch, type Store } from "@dena/core";
import { SOURCE as TRANSCRIPT_SOURCE, importTranscript } from "./transcript.ts";

/**
 * Claude Code hooks adapter.
 *
 * Hooks are Claude Code's documented integration point, so this adapter does not depend on
 * the (undocumented) transcript format for the facts it records. Its jobs:
 *  1. Doorbell: import the exact transcript a hook points at, right away.
 *  2. Facts transcripts lack: real exit codes and durations for tool calls, session start/end.
 *  3. Fallback: if a tool call reported by a hook never shows up in the transcript, record that
 *     it happened (with whatever metadata the hook had) and record the gap.
 * The spool holds metadata only; content still comes from the transcript, with redaction.
 */

export const SOURCE = "claude_code.hooks";
export const HOOK_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../hook/dena-hook.mjs");

export interface HookRecord {
  received_at: string;
  hook_event_name: string;
  session_id?: string;
  prompt_id?: string;
  transcript_path?: string;
  agent_transcript_path?: string;
  agent_id?: string;
  cwd?: string;
  project_dir?: string;
  source?: string;
  reason?: string;
  model?: string;
  tool_name?: string;
  tool_use_id?: string;
  file_path?: string;
  duration_ms?: number;
  is_interrupt?: boolean;
  exit_code?: number;
  error_kind?: string;
  bash_changed_files?: string[];
}

const within = (p: string | undefined, root: string) => {
  if (!p) return false;
  const r = path.relative(root, p);
  return r === "" || (!r.startsWith("..") && !path.isAbsolute(r));
};

/** Reads spool lines this project has not consumed yet. Partial trailing lines wait for the next read. */
export function readSpool(store: Store, projectId: string): HookRecord[] {
  const dir = path.join(store.home, "spool");
  if (!fs.existsSync(dir)) return [];
  const out: HookRecord[] = [];
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort()) {
    const file = path.join(dir, name);
    const offset = Number(store.getCursor(projectId, SOURCE, name) ?? 0);
    const size = fs.statSync(file).size;
    if (size <= offset) continue;
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    const text = buf.toString("utf8");
    const end = text.lastIndexOf("\n") + 1;
    for (const line of text.slice(0, end).split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* a corrupt line is skipped; the transcript remains the primary record */
      }
    }
    store.setCursor(projectId, SOURCE, name, String(offset + Buffer.byteLength(text.slice(0, end))));
  }
  return out;
}

export interface HookIngestResult {
  records: number;
  transcriptsImported: number;
  events: number;
  fallbacks: number;
}

/** A hook can fire before Claude Code flushes the matching transcript line; wait this long before calling it missing. */
export const FALLBACK_GRACE_MS = 30_000;

/**
 * @param opts.final  recording is stopping: decide every pending record now instead of waiting.
 */
export async function ingestHooks(store: Store, projectId: string, root: string, opts: { final?: boolean; now?: number } = {}): Promise<HookIngestResult> {
  const pendingKey = "pending";
  const pending: HookRecord[] = JSON.parse(store.getCursor(projectId, SOURCE, pendingKey) ?? "[]");
  const fresh = readSpool(store, projectId);
  const records = [...pending, ...fresh];
  const result: HookIngestResult = { records: fresh.length, transcriptsImported: 0, events: 0, fallbacks: 0 };
  if (!records.length) return result;
  const now = opts.now ?? Date.now();
  const stillPending: HookRecord[] = [];

  // 1. Doorbell: import the transcripts these hooks point at (the session's transcript path is
  //    carried by every hook call, so a record without one borrows it from its session).
  const bySession = new Map(records.filter((r) => r.transcript_path).map((r) => [r.session_id, r.transcript_path]));
  const transcripts = new Set(
    records.flatMap((r) => [r.transcript_path ?? bySession.get(r.session_id), r.agent_transcript_path]).filter((p): p is string => !!p),
  );
  for (const t of transcripts) {
    const file = t.startsWith("~") ? path.join(process.env.HOME ?? "", t.slice(1)) : t;
    if (!fs.existsSync(file)) continue;
    const { batch } = await importTranscript(file, root);
    store.ingest(projectId, batch);
    const st = fs.statSync(file);
    store.setCursor(projectId, TRANSCRIPT_SOURCE, file, `${st.size}:${Math.floor(st.mtimeMs)}`);
    result.transcriptsImported++;
  }

  // 2 & 3. Hook facts, kept only when they belong to this project.
  const batch: IngestBatch = { sessions: [], events: [], artifacts: [], links: [], gaps: [] };
  const sessions = new Set<string>();
  const inProject = (r: HookRecord) =>
    (r.session_id && store.hasSessionEvents(projectId, r.session_id)) || within(r.project_dir, root) || within(r.cwd, root) || within(r.file_path, root);

  for (const r of records) {
    const sessionId = r.session_id ?? null;
    const at = r.received_at;
    const base = { source: SOURCE, occurredAt: at, rawRef: `spool:${r.hook_event_name}` } as const;

    if (r.tool_use_id && (r.hook_event_name === "PostToolUse" || r.hook_event_name === "PostToolUseFailure")) {
      const inTranscript = store.hasEvent(projectId, TRANSCRIPT_SOURCE, `tool:${r.tool_use_id}`);
      if (!inTranscript && !inProject(r)) {
        if (!opts.final && now - Date.parse(r.received_at) < FALLBACK_GRACE_MS) stillPending.push(r); // may belong once the transcript catches up
        continue;
      }
      if (!inTranscript && !opts.final && now - Date.parse(r.received_at) < FALLBACK_GRACE_MS) {
        stillPending.push(r);
        continue;
      }
      const failed = r.hook_event_name === "PostToolUseFailure";
      if (!inTranscript) {
        batch.events.push({ ...base, sessionId, sourceEventId: `hook:tool:${r.tool_use_id}`, eventType: "tool_invoked", actor: "ai_agent",
          summary: `${r.tool_name ?? "Tool"} call reported by hook${r.file_path ? `: ${r.file_path}` : ""} (not found in transcript)`,
          payload: { tool: r.tool_name, file: r.file_path, toolUseId: r.tool_use_id, contentUnavailable: true },
          captureConfidence: "partial" });
        batch.gaps.push({ sessionId, source: SOURCE, fromTime: at, toTime: at,
          reason: `Tool call ${r.tool_use_id} was reported by a hook but is missing from the transcript; its input and output are unavailable` });
        result.fallbacks++;
      }
      const sid = `hook:${r.hook_event_name}:${r.tool_use_id}`;
      batch.events.push({ ...base, sessionId, sourceEventId: sid, eventType: failed ? "error_detected" : "tool_completed",
        actor: "automated_tool",
        summary: failed
          ? `${r.tool_name} failed${r.exit_code !== undefined ? ` with exit code ${r.exit_code}` : r.is_interrupt ? " (interrupted)" : ""}`
          : `${r.tool_name} finished${r.duration_ms !== undefined ? ` in ${r.duration_ms} ms` : ""}`,
        payload: { tool: r.tool_name, toolUseId: r.tool_use_id, exitCode: r.exit_code ?? (failed ? null : 0),
          exitCodeBasis: failed ? (r.exit_code !== undefined ? "PostToolUseFailure error text" : "failure without an exit code") : "PostToolUse (success)",
          durationMs: r.duration_ms ?? null, interrupted: r.is_interrupt ?? false,
          errorKind: r.error_kind ? redactText(r.error_kind) : undefined,
          bashChangedFiles: r.bash_changed_files },
        captureConfidence: "observed" });
      batch.links.push({ source: SOURCE, fromSourceEventId: sid, toSource: inTranscript ? TRANSCRIPT_SOURCE : SOURCE,
        toSourceEventId: inTranscript ? `tool:${r.tool_use_id}` : `hook:tool:${r.tool_use_id}`,
        linkType: "result_of", strength: "observed", basis: "hook tool_use_id" });
      if (sessionId) sessions.add(sessionId);
      continue;
    }

    if (["SessionStart", "SessionEnd", "SubagentStop", "Stop"].includes(r.hook_event_name)) {
      if (!sessionId || !inProject(r)) continue;
      if (r.hook_event_name === "Stop") continue; // turn boundaries are already visible in the transcript
      const what =
        r.hook_event_name === "SessionStart" ? `Claude Code session started (${r.source ?? "startup"})${r.model ? `, model ${r.model}` : ""}`
        : r.hook_event_name === "SessionEnd" ? `Claude Code session ended${r.reason ? ` (${r.reason})` : ""}`
        : `Subagent finished${r.agent_id ? ` (${r.agent_id})` : ""}`;
      batch.events.push({ ...base, sessionId, sourceEventId: `hook:${r.hook_event_name}:${sessionId}:${at}`, eventType: "session_marker",
        actor: "automated_tool", summary: what,
        payload: { hook: r.hook_event_name, source: r.source, reason: r.reason, model: r.model, agentId: r.agent_id },
        captureConfidence: "observed" });
      sessions.add(sessionId);
      continue;
    }

    if (r.hook_event_name === "UserPromptSubmit" && r.prompt_id && inProject(r)) {
      // Only a gap check: the prompt text itself comes from the transcript.
      const found = store.db
        .prepare("SELECT 1 FROM event WHERE project_id = ? AND event_type = 'prompt_submitted' AND json_extract(payload_json, '$.promptId') = ?")
        .get(projectId, r.prompt_id);
      if (!found && !opts.final && now - Date.parse(r.received_at) < FALLBACK_GRACE_MS) stillPending.push(r);
      else if (!found)
        batch.gaps.push({ sessionId, source: SOURCE, fromTime: at, toTime: at,
          reason: `A prompt (${r.prompt_id}) was submitted but is missing from the transcript` });
    }
  }

  // Sessions must exist before events reference them; the upsert keeps any times already known.
  for (const id of sessions) batch.sessions.push({ id, source: TRANSCRIPT_SOURCE, startedAt: null, endedAt: null });
  result.events = store.ingest(projectId, batch).eventsInserted;
  store.setCursor(projectId, SOURCE, pendingKey, JSON.stringify(stillPending));
  return result;
}
