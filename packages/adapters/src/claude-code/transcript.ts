import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import {
  isSensitivePath,
  newReport,
  redactDeep,
  redactText,
  type IngestBatch,
  type NewEvent,
  type RedactionReport,
} from "@dena/core";

/**
 * Claude Code transcript adapter.
 *
 * Reads the JSONL session logs Claude Code keeps under ~/.claude/projects/<encoded-cwd>/.
 * The format is not a documented public API: it was mapped by surveying real files
 * (CLI versions 2.1.286 – 2.1.308). Unknown record types are counted, never guessed at.
 *
 * What this source can see: user prompts, assistant text, tool calls with inputs,
 * tool results (including Edit/Write diffs), and the parent chain linking them.
 * What it cannot see: anything done outside Claude Code (manual edits, other terminals),
 * and it deliberately does not store the model's private thinking blocks.
 */

export const SOURCE = "claude_code.transcript";
const INLINE_LIMIT = 2_000; // chars kept inline in an event payload; the rest goes to an artifact
const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const HARNESS_TAG = /^\s*<(command-name|command-message|command-args|local-command-[a-z-]+|system-reminder|task-notification|bash-input|bash-stdout|bash-stderr|user-prompt-submit-hook)\b/;
const TEST_RUNNER =
  /^(?:npx\s+|pnpm\s+(?:exec\s+|dlx\s+)?|yarn\s+|bunx?\s+|python3?\s+-m\s+|\.\/)?(vitest|jest|mocha|pytest|playwright test|cypress run|go test|cargo test|rspec|phpunit|(npm|pnpm|yarn|bun)( run)? test(:[\w-]+)?|xcodebuild\b.*\btest\b|swift test|dotnet test|mvn test|gradlew? test|node --test)\b/;

/**
 * True when one of the commands actually executed is a test runner. Heredoc bodies and
 * quoted strings are removed first: a script that merely mentions "vitest" is not a test run.
 */
export function isTestCommand(command: string): boolean {
  return commandSegments(command).some((seg) => TEST_RUNNER.test(seg));
}

function commandSegments(command: string): string[] {
  return command
    .replace(/<<-?\s*(['"]?)(\w+)\1[\s\S]*?\n\s*\2\b/g, "<<HEREDOC")
    .replace(/'[^']*'|"[^"]*"/g, "''")
    .split(/&&|\|\||;|\||\n/)
    .map((seg) => seg.trim().replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, ""))
    .filter(Boolean);
}

export interface TestOutcome {
  outcome: "passed" | "failed" | "unknown";
  passed?: number;
  failed?: number;
  basis: string;
}

/**
 * Decides a test run's outcome without overclaiming. Prefers the runner's own summary line;
 * falls back to exit status only when the test runner is the sole command (in `npm test | grep x`
 * the exit status belongs to grep). Otherwise the outcome is unknown.
 */
export function testOutcome(command: string, output: string, isError: boolean, interrupted: boolean): TestOutcome {
  const num = (re: RegExp) => {
    const m = output.match(re);
    return m ? Number(m[1]) : undefined;
  };
  const summaries: [RegExp, RegExp, string][] = [
    [/^# pass\s+(\d+)/m, /^# fail\s+(\d+)/m, "TAP summary"],
    [/Tests?:?\s+.*?(\d+) passed/, /Tests?:?\s+.*?(\d+) failed/, "runner summary line"],
    [/(\d+) passed/, /(\d+) failed/, "pass/fail counts in output"],
  ];
  for (const [p, f, label] of summaries) {
    const passed = num(p);
    const failed = num(f);
    if (passed !== undefined || failed !== undefined) {
      const bad = (failed ?? 0) > 0;
      return { outcome: bad ? "failed" : "passed", passed, failed: failed ?? 0, basis: `parsed from ${label}` };
    }
  }
  if (interrupted) return { outcome: "unknown", basis: "command was interrupted" };
  const segs = commandSegments(command).filter((s) => !/^cd\b/.test(s));
  if (segs.length === 1 && TEST_RUNNER.test(segs[0]!))
    return { outcome: isError ? "failed" : "passed", basis: "exit status of the test command" };
  return { outcome: "unknown", basis: "test ran inside a compound or piped command; exit status not attributable and no summary found" };
}

/** Claude Code names a project's transcript directory by replacing every non-alphanumeric char with '-'. */
export function encodeProjectDir(root: string): string {
  return path.resolve(root).replace(/[^a-zA-Z0-9]/g, "-");
}

export function transcriptDirFor(root: string, claudeHome = path.join(os.homedir(), ".claude")): string {
  return path.join(claudeHome, "projects", encodeProjectDir(root));
}

export function listTranscripts(root: string, claudeHome?: string): string[] {
  const dir = transcriptDirFor(root, claudeHome);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => path.join(dir, f))
    .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
}

export interface ImportReport {
  file: string;
  lines: number;
  unparseable: number;
  recordTypes: Record<string, number>;
  ignoredRecordTypes: Record<string, number>;
  thinkingBlocksSkipped: number;
  harnessMessages: number;
  redactions: RedactionReport;
  sensitiveFilesWithheld: number;
  unresolvedToolCalls: number;
}

interface PendingTool {
  sid: string;
  name: string;
  input: Record<string, unknown>;
  occurredAt: string;
  sessionId: string;
  promptSid: string | null;
}

const bump = (m: Record<string, number>, k: string) => (m[k] = (m[k] ?? 0) + 1);

function clip(s: string, limit = INLINE_LIMIT): { text: string; truncated: boolean } {
  return s.length <= limit ? { text: s, truncated: false } : { text: `${s.slice(0, limit)}…`, truncated: true };
}

function firstLine(s: string, max = 120): string {
  const line = s.trim().split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((b: any) => (b?.type === "text" ? b.text : b?.type === "image" ? "[image]" : ""))
      .filter(Boolean)
      .join("\n");
  return "";
}

function unifiedDiff(file: string, hunks: any[]): string {
  const body = hunks
    .map((h) => `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n${(h.lines ?? []).join("\n")}`)
    .join("\n");
  return `--- a/${file}\n+++ b/${file}\n${body}\n`;
}

export async function importTranscript(file: string, projectRoot: string): Promise<{ batch: IngestBatch; report: ImportReport }> {
  const root = path.resolve(projectRoot);
  const rel = (p: unknown): { path: string; outsideRoot: boolean } | null => {
    if (typeof p !== "string" || !p) return null;
    const abs = path.resolve(root, p);
    const r = path.relative(root, abs);
    return r.startsWith("..") || path.isAbsolute(r) ? { path: abs, outsideRoot: true } : { path: r, outsideRoot: false };
  };

  const report: ImportReport = {
    file,
    lines: 0,
    unparseable: 0,
    recordTypes: {},
    ignoredRecordTypes: {},
    thinkingBlocksSkipped: 0,
    harnessMessages: 0,
    redactions: newReport(),
    sensitiveFilesWithheld: 0,
    unresolvedToolCalls: 0,
  };
  const red = (s: string) => redactText(s, report.redactions);
  const batch: IngestBatch = { sessions: [], events: [], artifacts: [], links: [], gaps: [] };
  const sessions = new Map<string, { start: string; end: string; model?: string; branch?: string }>();
  const promptOf = new Map<string, string | null>(); // record uuid -> sourceEventId of the prompt it descends from
  const pending = new Map<string, PendingTool>();

  const push = (e: NewEvent, promptSid: string | null) => {
    batch.events.push(e);
    if (promptSid && e.sourceEventId !== promptSid)
      batch.links.push({
        source: SOURCE,
        fromSourceEventId: e.sourceEventId,
        toSourceEventId: promptSid,
        linkType: "in_response_to",
        strength: "observed",
        basis: "transcript parentUuid chain",
      });
  };
  const artifact = (sourceEventId: string, role: string, artifactType: string, content: string, uriOrPath?: string) =>
    batch.artifacts.push({ sourceEventId, role, artifactType, content, uriOrPath });

  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    report.lines++;
    if (!line.trim()) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      report.unparseable++;
      continue;
    }
    const type: string = o.type ?? "unknown";
    bump(report.recordTypes, type);
    const rawRef = `${path.basename(file)}:${report.lines}`;
    const sessionId: string | undefined = o.sessionId;
    const ts: string | undefined = o.timestamp;
    const inherited = o.parentUuid ? (promptOf.get(o.parentUuid) ?? null) : null;

    if (sessionId && ts) {
      const s = sessions.get(sessionId);
      if (!s) sessions.set(sessionId, { start: ts, end: ts, branch: o.gitBranch });
      else {
        if (ts < s.start) s.start = ts;
        if (ts > s.end) s.end = ts;
      }
    }

    if ((type !== "user" && type !== "assistant" && type !== "system") || !sessionId || !ts) {
      if (type !== "user" && type !== "assistant" && type !== "system") bump(report.ignoredRecordTypes, type);
      if (o.uuid) promptOf.set(o.uuid, inherited);
      continue;
    }

    const common = { sessionId, source: SOURCE, occurredAt: ts, rawRef } as const;
    const sidechain = Boolean(o.isSidechain);

    if (type === "system") {
      if (o.subtype === "api_error") {
        push({ ...common, sourceEventId: o.uuid, eventType: "error_detected", actor: "automated_tool",
          summary: "Model API request failed", payload: { subtype: o.subtype }, captureConfidence: "observed" }, inherited);
      } else if (o.subtype === "compact_boundary") {
        push({ ...common, sourceEventId: o.uuid, eventType: "session_marker", actor: "automated_tool",
          summary: "Conversation context was compacted", payload: { subtype: o.subtype }, captureConfidence: "observed" }, inherited);
      } else bump(report.ignoredRecordTypes, `system:${o.subtype ?? "?"}`);
      if (o.uuid) promptOf.set(o.uuid, inherited);
      continue;
    }

    const content = o.message?.content;

    if (type === "user") {
      const blocks: any[] = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
      const toolResults = blocks.filter((b) => b?.type === "tool_result");
      if (toolResults.length === 0) {
        const text = blocks.filter((b) => b?.type === "text").map((b) => b.text).join("\n");
        const images = blocks.filter((b) => b?.type === "image").length;
        if (o.isMeta || HARNESS_TAG.test(text)) {
          report.harnessMessages++;
          const tag = text.match(HARNESS_TAG)?.[1] ?? "meta";
          push({ ...common, sourceEventId: o.uuid, eventType: "session_marker", actor: "automated_tool",
            summary: `Harness context (${tag})`, payload: { tag, text: clip(red(text), 400).text },
            captureConfidence: "observed" }, inherited);
          promptOf.set(o.uuid, inherited);
          continue;
        }
        const t = clip(red(text), 20_000);
        const sid = o.uuid as string;
        // A sidechain "user" message is the main agent instructing a subagent, not the human.
        push({ ...common, sourceEventId: sid, eventType: "prompt_submitted", actor: sidechain ? "ai_agent" : "user",
          summary: firstLine(t.text) || (images ? "(image prompt)" : "(empty prompt)"),
          payload: { text: t.text, truncated: t.truncated, imagesAttached: images, sidechain, cwd: o.cwd, gitBranch: o.gitBranch },
          captureConfidence: t.truncated ? "partial" : "observed" }, null);
        promptOf.set(sid, sid);
        continue;
      }

      for (const b of toolResults) {
        const call = pending.get(b.tool_use_id);
        pending.delete(b.tool_use_id);
        const promptSid = call?.promptSid ?? inherited;
        const name = call?.name ?? "unknown";
        const isError = Boolean(b.is_error);
        const tur = o.toolUseResult && typeof o.toolUseResult === "object" ? o.toolUseResult : {};
        const sid = `result:${b.tool_use_id}`;
        const out = red(resultText(b.content));
        const outClip = clip(out);
        const status = isError ? "error" : tur.interrupted ? "interrupted" : "ok";
        const base = { ...common, sourceEventId: sid, actor: "ai_agent" as const };

        if (name === "Bash" || name === "bash") {
          const command = red(String(call?.input.command ?? ""));
          const isTest = isTestCommand(command);
          const payload = {
            tool: name, command, description: call?.input.description ?? null, status,
            exitStatusBasis: "tool_result.is_error flag (exact exit code not recorded by this source)",
            stdout: clip(red(String(tur.stdout ?? out))).text, stderr: clip(red(String(tur.stderr ?? ""))).text,
            interrupted: Boolean(tur.interrupted), sidechain,
          };
          if (isTest) {
            const t = testOutcome(command, `${tur.stdout ?? out}\n${tur.stderr ?? ""}`, isError, Boolean(tur.interrupted));
            const counts = t.passed !== undefined || t.failed ? ` (${t.passed ?? "?"} passed, ${t.failed ?? 0} failed)` : "";
            push({ ...base, eventType: "test_result",
              summary: `Tests ${t.outcome === "unknown" ? "ran, outcome unknown" : t.outcome}${counts}`,
              payload: { ...payload, outcome: t.outcome, testsPassed: t.passed ?? null, testsFailed: t.failed ?? null, outcomeBasis: t.basis },
              captureConfidence: "derived" }, promptSid);
          } else {
            push({ ...base, eventType: "command_executed",
              summary: `${isError ? "Command failed" : "Ran"}: ${firstLine(command, 90)}`,
              payload, captureConfidence: "observed" }, promptSid);
          }
          if (out.length > INLINE_LIMIT || String(tur.stdout ?? "").length > INLINE_LIMIT)
            artifact(sid, "output", "command_output", red(`${tur.stdout ?? out}\n${tur.stderr ?? ""}`));
        } else {
          const filePath = rel(call?.input.file_path ?? call?.input.path ?? call?.input.notebook_path ?? tur.filePath);
          const withheld = filePath ? isSensitivePath(filePath.path) : false;
          const payload: Record<string, unknown> = { tool: name, status, sidechain };
          if (filePath) Object.assign(payload, { file: filePath.path, outsideRoot: filePath.outsideRoot });
          if (name === "Read") payload.outputChars = out.length; // file contents are not copied into the store
          else if (!withheld) Object.assign(payload, { output: outClip.text, truncated: outClip.truncated });
          push({ ...base, eventType: isError ? "error_detected" : "tool_completed",
            summary: `${name} ${isError ? "failed" : "completed"}${filePath ? `: ${filePath.path}` : ""}`,
            payload, captureConfidence: "observed" }, promptSid);
          if (!withheld && name !== "Read" && outClip.truncated) artifact(sid, "output", "tool_output", out);

          // Edit/Write results carry the actual change, so the file event is observed, not inferred.
          if (!isError && FILE_TOOLS.has(name) && filePath) {
            const fsid = `file:${b.tool_use_id}`;
            const created = tur.type === "create" || (name === "Write" && !tur.originalFile);
            const hunks: any[] = Array.isArray(tur.structuredPatch) ? tur.structuredPatch : [];
            if (withheld) report.sensitiveFilesWithheld++;
            const added = hunks.reduce((n, h) => n + (h.lines ?? []).filter((l: string) => l.startsWith("+")).length, 0);
            const removed = hunks.reduce((n, h) => n + (h.lines ?? []).filter((l: string) => l.startsWith("-")).length, 0);
            push({ ...common, sourceEventId: fsid, eventType: created ? "file_created" : "file_modified", actor: "ai_agent",
              summary: `${created ? "Created" : "Modified"} ${filePath.path}${hunks.length ? ` (+${added} −${removed})` : ""}`,
              payload: { file: filePath.path, outsideRoot: filePath.outsideRoot, tool: name, linesAdded: added, linesRemoved: removed,
                userModifiedProposal: Boolean(tur.userModified), contentWithheld: withheld, sidechain },
              captureConfidence: hunks.length || created ? "observed" : "partial" }, promptSid);
            batch.links.push({ source: SOURCE, fromSourceEventId: fsid, toSourceEventId: `tool:${b.tool_use_id}`,
              linkType: "modified_file", strength: "observed", basis: "file change reported in the tool's own result" });
            if (!withheld) {
              if (hunks.length) artifact(fsid, "diff", "diff", red(unifiedDiff(filePath.path, hunks)), filePath.path);
              else if (created && typeof call?.input.content === "string")
                artifact(fsid, "content", "file_snapshot", red(call.input.content), filePath.path);
            }
          }
        }
        if (call)
          batch.links.push({ source: SOURCE, fromSourceEventId: sid, toSourceEventId: call.sid, linkType: "result_of",
            strength: "observed", basis: "tool_result.tool_use_id" });
      }
      if (o.uuid) promptOf.set(o.uuid, inherited);
      continue;
    }

    // assistant
    const blocks: any[] = Array.isArray(content) ? content : [];
    const model = o.message?.model;
    if (model && sessions.get(sessionId)) sessions.get(sessionId)!.model = model;
    blocks.forEach((b, i) => {
      if (b?.type === "thinking" || b?.type === "redacted_thinking") {
        report.thinkingBlocksSkipped++;
      } else if (b?.type === "text" && b.text?.trim()) {
        const t = clip(red(b.text), 20_000);
        push({ ...common, sourceEventId: `${o.uuid}:text:${i}`, eventType: "ai_response_received", actor: "ai_agent",
          summary: firstLine(t.text), payload: { text: t.text, truncated: t.truncated, model, sidechain },
          captureConfidence: t.truncated ? "partial" : "observed" }, inherited);
      } else if (b?.type === "tool_use") {
        const sid = `tool:${b.id}`;
        const input = redactDeep((b.input ?? {}) as Record<string, unknown>, report.redactions);
        const target = rel(input.file_path ?? input.path ?? input.notebook_path);
        const withheld = target ? isSensitivePath(target.path) : false;
        const slim: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(input)) {
          if (withheld && ["content", "new_string", "old_string", "edits"].includes(k)) continue;
          slim[k] = typeof v === "string" ? clip(v).text : v;
        }
        const label =
          b.name === "Bash" ? firstLine(String(input.description ?? input.command ?? ""), 90)
          : target ? target.path
          : firstLine(String(input.query ?? input.url ?? input.pattern ?? input.prompt ?? ""), 90);
        push({ ...common, sourceEventId: sid, eventType: "tool_invoked", actor: "ai_agent",
          summary: `${b.name}${label ? `: ${label}` : ""}`,
          payload: { tool: b.name, input: slim, model, sidechain, ...(withheld ? { contentWithheld: true } : {}) },
          captureConfidence: "observed" }, inherited);
        pending.set(b.id, { sid, name: b.name, input, occurredAt: ts, sessionId, promptSid: inherited });
      }
    });
    if (o.uuid) promptOf.set(o.uuid, inherited);
  }

  for (const [id, s] of sessions)
    batch.sessions.push({ id, source: SOURCE, startedAt: s.start, endedAt: s.end,
      summary: [s.model && `model ${s.model}`, s.branch && `branch ${s.branch}`].filter(Boolean).join(", ") || undefined });

  for (const p of pending.values()) {
    report.unresolvedToolCalls++;
    batch.gaps.push({ sessionId: p.sessionId, source: SOURCE, fromTime: p.occurredAt, toTime: null,
      reason: `No result recorded for ${p.name} call ${p.sid}` });
  }
  for (const id of sessions.keys())
    batch.gaps.push({ sessionId: id, source: SOURCE, fromTime: null, toTime: null,
      reason: "Changes made outside Claude Code (manual edits, other terminals) are not visible to this source" });

  return { batch, report };
}
