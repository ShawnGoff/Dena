import { redactText, sha256, type StoredEvent, type Store } from "@dena/core";
import { episodeEvents } from "./episodes.ts";

/**
 * Evidence packets: the smallest useful, bounded, redacted view of one episode that a model
 * needs in order to explain it. Every item gets a short reference (E1, E2, …) that maps back
 * to a stored event, so each claim in the explanation can be checked.
 *
 * Noise is folded rather than dropped: e.g. "the AI read 14 files" is one item. Content is
 * cut to a budget, and cutting is marked in the text so the model cannot mistake a fragment
 * for the whole.
 */

export type EvidenceKind =
  | "prompt" | "ai_response" | "agent_note" | "command" | "test" | "file_change" | "commit"
  | "error" | "reads" | "branch" | "session" | "gap";

export interface EvidenceItem {
  ref: string;
  kind: EvidenceKind;
  eventIds: number[];
  at: string;
  /** Facts the validator uses (test outcome, files, …), independent of the prose. */
  facts: Record<string, unknown>;
  text: string;
}

export interface Packet {
  unitId: string;
  items: EvidenceItem[];
  hash: string;
  chars: number;
  truncated: boolean;
}

export type Depth = "concise" | "thorough";

/** Character budgets. Input is the bulk of a call's size, so these are the main usage lever. */
const BUDGETS: Record<Depth, { total: number; prompt: number; response: number; finalResponse: number; diff: number; output: number; command: number; commitDiff: number }> = {
  thorough: { total: 40_000, prompt: 2_000, response: 600, finalResponse: 1_500, diff: 2_500, output: 400, command: 800, commitDiff: 3_500 },
  concise: { total: 18_000, prompt: 1_200, response: 300, finalResponse: 900, diff: 1_200, output: 250, command: 400, commitDiff: 1_500 },
};

function cut(s: string, n: number): { text: string; cut: boolean } {
  return s.length <= n ? { text: s, cut: false } : { text: `${s.slice(0, n)}\n[… ${s.length - n} more characters not included]`, cut: true };
}

export function buildPacket(store: Store, projectId: string, unitId: string, opts: { depth?: Depth } = {}): Packet {
  const BUDGET = BUDGETS[opts.depth ?? "thorough"];
  const events = episodeEvents(store, projectId, unitId);
  const lastResponseId = [...events].reverse().find((e) => e.eventType === "ai_response_received" && !(e.payload as any).sidechain)?.id;
  const byId = new Map(events.map((e) => [e.id, e]));
  const bySid = new Map(events.map((e) => [`${e.source}|${e.sourceEventId}`, e]));
  const links = (id: number) => store.linksFor(id);
  const blob = (eventId: number, role: string) => {
    const a = store.artifactsFor(eventId).find((x) => x.role === role);
    return a ? (store.blobs.get(a.contentHash)?.toString("utf8") ?? null) : null;
  };
  const items: Omit<EvidenceItem, "ref">[] = [];
  const consumed = new Set<number>();
  let truncated = false;
  const take = (s: string, n: number) => {
    const r = cut(s, n);
    truncated ||= r.cut;
    return r.text;
  };

  const reads: string[] = [];
  const readIds: number[] = [];

  for (const e of events) {
    if (consumed.has(e.id)) continue;
    const p = e.payload as Record<string, any>;
    const at = e.occurredAt;

    switch (e.eventType) {
      case "prompt_submitted":
        items.push({ kind: "prompt", eventIds: [e.id], at, facts: { actor: e.actor },
          text: `${e.actor === "user" ? "USER PROMPT" : "SUBAGENT INSTRUCTION (from the main agent)"}:\n${take(String(p.text ?? e.summary), BUDGET.prompt)}` });
        break;
      case "ai_response_received":
        // The closing reply usually summarises the work; earlier ones mostly narrate what the evidence already shows.
        items.push({ kind: "ai_response", eventIds: [e.id], at, facts: {},
          text: `AI RESPONSE${p.sidechain ? " (subagent)" : ""}:\n${take(String(p.text ?? e.summary), e.id === lastResponseId ? BUDGET.finalResponse : BUDGET.response)}` });
        break;
      case "agent_note":
        items.push({ kind: "agent_note", eventIds: [e.id], at, facts: { noteKind: p.kind },
          text: `AGENT NOTE (${p.kind}; the agent's own stated reasoning, not verified):\n${p.text}` });
        break;
      case "tool_invoked": {
        const tool = String(p.tool);
        const resultLink = links(e.id).filter((l) => l.direction === "in" && l.linkType === "result_of").map((l) => byId.get(l.otherId)).filter(Boolean) as StoredEvent[];
        if (tool === "Read" || tool === "Glob" || tool === "Grep" || tool === "WebFetch" || tool === "WebSearch" || tool === "ToolSearch") {
          reads.push(`${tool} ${e.summary.replace(/^\w+: ?/, "")}`.trim());
          readIds.push(e.id, ...resultLink.map((r) => r.id));
          resultLink.forEach((r) => consumed.add(r.id));
          break;
        }
        if (tool === "Bash") {
          const result = resultLink.find((r) => r.source === e.source);
          const hook = resultLink.find((r) => r.source !== e.source);
          const rp = (result?.payload ?? {}) as Record<string, any>;
          const hp = (hook?.payload ?? {}) as Record<string, any>;
          if (String(p.input?.command ?? "").includes("dena-hook.mjs note")) {
            [result, hook].forEach((r) => r && consumed.add(r.id)); // the note itself is its own item
            break;
          }
          const isTest = result?.eventType === "test_result";
          const exit = hp.exitCode !== undefined && hp.exitCode !== null ? `exit code ${hp.exitCode}` : rp.status === "error" ? "failed (non-zero exit)" : rp.status === "ok" ? "succeeded" : "no result recorded";
          const out = [rp.stdout, rp.stderr].filter(Boolean).join("\n").trim();
          const lines = [
            `${isTest ? "TEST RUN" : "COMMAND"} run by the AI: ${take(String(p.input?.command ?? ""), BUDGET.command)}`,
            p.input?.description ? `stated purpose: ${p.input.description}` : null,
            `result: ${exit}${hp.durationMs ? `, ${hp.durationMs} ms` : ""}`,
            isTest ? `test outcome: ${rp.outcome}${rp.testsPassed != null ? ` (${rp.testsPassed} passed, ${rp.testsFailed ?? 0} failed)` : ""} — ${rp.outcomeBasis}` : null,
            out ? `output (tail):\n${take(out.slice(-BUDGET.output * 2), BUDGET.output)}` : null,
          ].filter(Boolean);
          const ids = [e.id, ...[result, hook].filter(Boolean).map((r) => r!.id)];
          [result, hook].forEach((r) => r && consumed.add(r.id));
          items.push({ kind: isTest ? "test" : "command", eventIds: ids, at,
            facts: isTest ? { outcome: rp.outcome, passed: rp.testsPassed, failed: rp.testsFailed } : { status: rp.status ?? null, exitCode: hp.exitCode ?? null },
            text: lines.join("\n") });
          break;
        }
        if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool)) {
          // Folded into the file-change item that the tool's result produced.
          resultLink.forEach((r) => consumed.add(r.id));
          const fileEv = links(e.id).filter((l) => l.direction === "in" && l.linkType === "modified_file").map((l) => byId.get(l.otherId)).find(Boolean);
          if (!fileEv) {
            const failed = resultLink.some((r) => r.eventType === "error_detected");
            items.push({ kind: failed ? "error" : "file_change", eventIds: [e.id, ...resultLink.map((r) => r.id)], at, facts: { file: p.input?.file_path },
              text: `${tool} by the AI on ${p.input?.file_path ?? "?"}: ${failed ? "FAILED" : "no change recorded"}` });
          }
          break;
        }
        // Other tools (browser, MCP, …): one line each.
        const status = resultLink[0] ? (resultLink[0].eventType === "error_detected" ? "failed" : "completed") : "no result recorded";
        resultLink.forEach((r) => consumed.add(r.id));
        items.push({ kind: "command", eventIds: [e.id, ...resultLink.map((r) => r.id)], at, facts: {}, text: `TOOL ${e.summary} — ${status}` });
        break;
      }
      case "file_created":
      case "file_modified":
      case "file_deleted": {
        // Skip the watcher's copy of a change the agent's tool result already reported.
        if (e.source === "fs" && links(e.id).some((l) => l.direction === "out" && l.linkType === "same_change")) {
          consumed.add(e.id);
          break;
        }
        const tool = e.source === "fs" ? null : p.tool;
        const during = links(e.id).filter((l) => l.direction === "out" && l.linkType === "changed_during");
        const who = tool ? `by the AI via ${tool}` : during.length ? `seen by the file watcher while an AI command was running (${during[0]!.strength} link: ${during[0]!.basis})` : "seen by the file watcher; who made it is unknown";
        const diff = p.contentWithheld ? "[contents withheld: sensitive file]" : blob(e.id, "diff") ?? blob(e.id, "content");
        items.push({ kind: "file_change", eventIds: [e.id], at, facts: { file: p.file, type: e.eventType, added: p.linesAdded, removed: p.linesRemoved },
          text: `FILE ${e.eventType.replace("file_", "").toUpperCase()} ${p.file} ${who}${p.linesAdded != null ? ` (+${p.linesAdded} −${p.linesRemoved ?? 0})` : ""}`
            + (diff ? `\n${take(diff, BUDGET.diff)}` : p.diffUnavailable ? `\n(${p.diffUnavailable})` : "") });
        break;
      }
      case "test_result":
      case "command_executed":
      case "tool_completed":
        break; // reached through their tool call; an orphan result adds nothing on its own
      case "git_commit": {
        const created = links(e.id).filter((l) => l.direction === "in" && l.linkType === "created_commit");
        const files = (p.files ?? []) as { path: string; added: number | null; removed: number | null }[];
        const diff = blob(e.id, "diff");
        items.push({ kind: "commit", eventIds: [e.id], at, facts: { sha: p.sha, files: files.map((f) => f.path) },
          text: `GIT COMMIT ${String(p.sha).slice(0, 7)}${created.length ? " (made by an AI command — inferred: the command ran `git commit` while this commit was created)" : " (author of the change unknown)"}\n`
            + `message: ${p.message}\nfiles: ${files.map((f) => `${f.path} (+${f.added ?? "bin"} −${f.removed ?? "bin"})`).join(", ")}`
            + (diff ? `\ndiff:\n${take(diff, BUDGET.commitDiff)}` : "") });
        break;
      }
      case "error_detected":
        items.push({ kind: "error", eventIds: [e.id], at, facts: {}, text: `ERROR: ${e.summary}` });
        break;
      case "branch_changed":
        items.push({ kind: "branch", eventIds: [e.id], at, facts: {}, text: e.summary });
        break;
      case "session_marker":
        if (e.source !== "claude_code.transcript" || /compacted/.test(e.summary))
          items.push({ kind: "session", eventIds: [e.id], at, facts: {}, text: e.summary });
        break;
      default:
        break;
    }
  }
  if (reads.length)
    items.push({ kind: "reads", eventIds: readIds, at: byId.get(readIds[0]!)!.occurredAt, facts: {},
      text: `The AI also looked things up ${reads.length} times (contents not included): ${take(reads.slice(0, 40).join("; "), 1_500)}` });

  // Known gaps overlapping this episode, so the explanation can say what was not observed.
  if (events.length) {
    const from = events[0]!.occurredAt, to = events[events.length - 1]!.occurredAt;
    const sessions = new Set(events.map((e) => e.sessionId).filter(Boolean));
    for (const g of store.gaps(projectId)) {
      const overlaps = (g.fromTime === null || g.fromTime <= to) && (g.toTime === null || g.toTime >= from);
      if (overlaps && (!g.sessionId || sessions.has(g.sessionId)) && g.source !== "git")
        items.push({ kind: "gap", eventIds: [], at: g.fromTime ?? from, facts: {}, text: `KNOWN GAP IN CAPTURE: ${g.reason}` });
    }
  }

  items.sort((a, b) => a.at.localeCompare(b.at));
  foldRepeatedTests(items);
  // Enforce the total budget from the end of the episode backwards: the opening prompt matters most.
  let total = 0;
  const kept = items.filter((it) => {
    total += it.text.length;
    if (total > BUDGET.total && it.kind !== "prompt" && it.kind !== "test" && it.kind !== "commit" && it.kind !== "agent_note") {
      truncated = true;
      return false;
    }
    return true;
  });
  const final = kept.map((it, i) => ({ ...it, ref: `E${i + 1}`, text: redactText(it.text) }));
  return { unitId, items: final, hash: sha256(JSON.stringify(final.map((i) => [i.ref, i.text]))), chars: final.reduce((n, i) => n + i.text.length, 0), truncated };
}

/**
 * Agents re-run the same tests many times. Keep the runs that tell the story (the first, every
 * change of outcome, the last) and fold the rest into a count on the next kept run. Folded runs
 * keep their event ids, so nothing becomes uncitable.
 */
function foldRepeatedTests(items: Omit<EvidenceItem, "ref">[]): void {
  const tests = items.filter((i) => i.kind === "test");
  if (tests.length <= 2) return;
  const drop = new Set<Omit<EvidenceItem, "ref">>();
  let pendingIds: number[] = [];
  let pendingCount = 0;
  tests.forEach((t, i) => {
    const prev = tests[i - 1];
    const keep = i === 0 || i === tests.length - 1 || t.facts.outcome !== prev?.facts.outcome || tests[i + 1]?.facts.outcome !== t.facts.outcome;
    if (!keep) {
      drop.add(t);
      pendingIds.push(...t.eventIds);
      pendingCount++;
      return;
    }
    if (pendingCount) {
      t.eventIds = [...pendingIds, ...t.eventIds];
      t.text = `(${pendingCount} earlier run${pendingCount > 1 ? "s" : ""} with the same outcome folded into this item)\n${t.text}`;
      pendingIds = [];
      pendingCount = 0;
    }
  });
  for (let i = items.length - 1; i >= 0; i--) if (drop.has(items[i]!)) items.splice(i, 1);
}

/** The exact text sent to the model; also what `dena packet` shows the user. */
export function renderPacket(p: Packet): string {
  return p.items.map((i) => `[${i.ref}] ${i.at.slice(0, 19).replace("T", " ")} UTC\n${i.text}`).join("\n\n");
}
