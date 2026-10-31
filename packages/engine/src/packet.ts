import { effectiveTest, redactText, sha256, type StoredEvent, type Store } from "@dena/core";
import { episodeEvents } from "./episodes.ts";
import { notesFor } from "./revisions.ts";

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
  | "error" | "reads" | "branch" | "session" | "gap" | "owner_note";

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
  /**
   * Fingerprints this same evidence had under earlier packet rules. A written explanation whose
   * stored fingerprint matches one of these is still current: only the packet's form changed.
   */
  legacyHashes: string[];
  chars: number;
  truncated: boolean;
}

/** Whether a stored fingerprint still describes this packet's evidence. */
export const packetMatches = (p: Packet, stored: string | null | undefined) => !!stored && (stored === p.hash || p.legacyHashes.includes(stored));

/**
 * Standing limitations hold for a whole project ("changes made outside Claude Code are not
 * visible"). They are shown once in "About this guide" rather than repeated in every step.
 */
export const isStandingGap = (g: { fromTime: string | null; toTime: string | null }) => g.fromTime === null && g.toTime === null;

/** Text that only restates a standing limitation (written before they were left out of packets). */
export const isStandingLimitationText = (t: string) =>
  /outside (of )?claude code|not visible to (this|that) source|manual edits.{0,30}other terminals|older than the local reflog/i.test(t);

/** The project's standing limitations, each stated once, for "About this guide". */
export function standingLimitations(store: Store, projectId: string): string[] {
  return [...new Set(store.gaps(projectId).filter(isStandingGap).map((g) => g.reason))];
}

export type Depth = "concise" | "thorough";

/** Character budgets. Input is the bulk of a call's size, so these are the main usage lever. */
const BUDGETS: Record<Depth, { total: number; prompt: number; response: number; finalResponse: number; diff: number; output: number; command: number; commitDiff: number }> = {
  thorough: { total: 40_000, prompt: 2_000, response: 600, finalResponse: 1_500, diff: 2_500, output: 400, command: 800, commitDiff: 3_500 },
  // Concise measured: 12k packed by importance wrote as good a step as 18k, for about 25% fewer tokens.
  concise: { total: 12_000, prompt: 1_200, response: 300, finalResponse: 900, diff: 1_200, output: 250, command: 400, commitDiff: 1_500 },
};

/** The total budgets before the concise cap was lowered (evidence is now packed by importance), for fingerprints of earlier explanations. */
const EARLIER_TOTAL: Record<Depth, number> = { thorough: 40_000, concise: 18_000 };

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
        items.push({ kind: "ai_response", eventIds: [e.id], at, facts: { final: e.id === lastResponseId },
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
          const tr = result ? effectiveTest(result) : null; // current label, not the reading stored at capture
          const lines = [
            `${isTest ? "TEST RUN" : "COMMAND"} run by the AI: ${take(String(p.input?.command ?? ""), BUDGET.command)}`,
            p.input?.description ? `stated purpose: ${p.input.description}` : null,
            `result: ${exit}${hp.durationMs ? `, ${hp.durationMs} ms` : ""}`,
            isTest && tr ? `test outcome: ${tr.outcome}${tr.passed != null || tr.failed ? ` (${tr.passed ?? "?"} passed, ${tr.failed ?? 0} failed)` : ""} — ${tr.basis}` : null,
            out ? `output (tail):\n${take(out.slice(-BUDGET.output * 2), BUDGET.output)}` : null,
          ].filter(Boolean);
          const ids = [e.id, ...[result, hook].filter(Boolean).map((r) => r!.id)];
          [result, hook].forEach((r) => r && consumed.add(r.id));
          const cmd = String(p.input?.command ?? "");
          const ok = !isTest && (hp.exitCode === 0 || (hp.exitCode == null && rp.status === "ok"));
          items.push({ kind: isTest ? "test" : "command", eventIds: ids, at,
            facts: isTest && tr ? { outcome: tr.outcome, passed: tr.passed, failed: tr.failed }
              : { status: rp.status ?? null, exitCode: hp.exitCode ?? null, readOnly: ok && isReadOnlyCommand(cmd), versionControl: ok && isVersionControlCommand(cmd),
                  label: p.input?.description ? String(p.input.description) : cmd.split("\n")[0]!.slice(0, 90) },
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
        items.push({ kind: "command", eventIds: [e.id, ...resultLink.map((r) => r.id)], at, facts: { housekeeping: HOUSEKEEPING.test(tool) }, text: `TOOL ${e.summary} — ${status}` });
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
        items.push({ kind: "file_change", eventIds: [e.id], at,
          facts: { file: p.file, type: e.eventType, added: p.linesAdded, removed: p.linesRemoved, rawDiff: !p.contentWithheld && blob(e.id, "diff") ? diff : null },
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
        items.push({ kind: "commit", eventIds: [e.id], at, facts: { sha: p.sha, files: files.map((f) => f.path), rawDiff: diff },
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
        items.push({ kind: "gap", eventIds: [], at: g.fromTime ?? from, facts: { standing: isStandingGap(g) }, text: `KNOWN GAP IN CAPTURE: ${g.reason}` });
    }
  }

  // The owner's corrections and context. They are not events: they explain intent the capture
  // could not see, and tell the writer which earlier statements were wrong.
  for (const n of notesFor(store, projectId, "step", unitId)) {
    const text = n.kind === "context" ? `OWNER NOTE (context from the project owner; not a record of events):\n${n.text}`
      : `OWNER NOTE: the owner says this statement was ${n.kind}: "${n.target ?? ""}"${n.text ? `\nTheir note: ${n.text}` : ""}`;
    items.push({ kind: "owner_note", eventIds: [], at: events[events.length - 1]?.occurredAt ?? n.createdAt, facts: { noteId: n.id, noteKind: n.kind }, text });
  }

  const number = (kept: Omit<EvidenceItem, "ref">[], cut: boolean) => {
    const final = kept.map((it, i) => ({ ...it, ref: `E${i + 1}`, text: redactText(it.text) }));
    return { final, cut, hash: sha256(JSON.stringify(final.map((i) => [i.ref, i.text]))) };
  };
  /** The earlier rule (items in time order until the budget ran out); kept only to fingerprint evidence explained under it. */
  const finalizeEarlier = (list: Omit<EvidenceItem, "ref">[]) => {
    const work = structuredClone(list);
    work.sort((a, b) => a.at.localeCompare(b.at));
    foldRepeatedTests(work);
    let total = 0, cut = false;
    const kept = work.filter((it) => {
      total += it.text.length;
      if (total > EARLIER_TOTAL[opts.depth ?? "thorough"] && !["prompt", "test", "commit", "agent_note", "owner_note"].includes(it.kind)) {
        cut = true;
        return false;
      }
      return true;
    });
    return number(kept, cut);
  };
  /**
   * Fits the budget by importance, not by time: cutting from the end lost the final fix, which is
   * what a how-to needs most. What is kept stays in time order.
   */
  const finalize = (list: Omit<EvidenceItem, "ref">[]) => {
    const work = structuredClone(list);
    work.sort((a, b) => a.at.localeCompare(b.at));
    foldRepeatedTests(work);
    const rank = (it: Omit<EvidenceItem, "ref">) =>
      ["prompt", "owner_note", "agent_note", "error", "test", "commit", "gap", "session", "branch"].includes(it.kind) ? 0
        : it.kind === "ai_response" && it.facts.final ? 1
        : it.kind === "file_change" ? 2
        : it.kind === "command" ? 3
        : 4; // intermediate replies, and what the AI looked at
    const order = work.map((it, i) => ({ it, i })).sort((a, b) => rank(a.it) - rank(b.it) || (rank(a.it) === 2 ? b.i - a.i : a.i - b.i)); // newest changes first
    let total = 0, cut = false;
    const keep = new Set<number>();
    for (const { it, i } of order) {
      if (rank(it) === 0 || total + it.text.length <= BUDGET.total) {
        keep.add(i);
        total += it.text.length;
      } else cut = true;
    }
    return number(work.filter((_, i) => keep.has(i)), cut);
  };
  // Standing limitations are left out (see isStandingGap), and the evidence is made leaner (see
  // lean). The fingerprints the same evidence had under the earlier rules are kept, so
  // explanations written before these changes are not flagged as outdated.
  const base = items.filter((i) => !(i.kind === "gap" && i.facts.standing));
  const current = finalize(lean(base, BUDGET));
  const earlier = [finalizeEarlier(base).hash, ...(items.length !== base.length ? [finalizeEarlier(items).hash] : [])];
  truncated ||= current.cut;
  return { unitId, items: current.final, hash: current.hash, legacyHashes: [...new Set(earlier)].filter((h) => h !== current.hash),
    chars: current.final.reduce((n, i) => n + i.text.length, 0), truncated };
}

/**
 * The same evidence, for fewer tokens, with nothing a step can teach from taken away:
 * - commands that only looked around (read files, searched, listed, checked git status) and
 *   succeeded fold into one line, the way file reads already do; their output is not sent;
 * - a commit's diff is left out when every file it touched is already a file change in the packet,
 *   since the model would read the same changes twice.
 * Folded commands keep their event ids, so nothing becomes uncitable.
 */
function lean(list: Omit<EvidenceItem, "ref">[], budget: { diff: number; commitDiff: number }): Omit<EvidenceItem, "ref">[] {
  const changed = new Set(list.filter((i) => i.kind === "file_change").map((i) => String(i.facts.file ?? "")));
  const out: Omit<EvidenceItem, "ref">[] = [];
  const looked: Omit<EvidenceItem, "ref">[] = [];
  for (const it of list) {
    if (it.kind === "command" && it.facts.housekeeping) continue; // the assistant's own bookkeeping: nothing to teach from
    if (it.kind === "command" && it.facts.readOnly) {
      looked.push(it);
      continue;
    }
    const files = (it.facts.files as string[] | undefined) ?? [];
    const raw = typeof it.facts.rawDiff === "string" ? it.facts.rawDiff : null;
    const facts = { ...it.facts, rawDiff: undefined }; // the raw diff has done its job; it is not evidence text
    if (it.kind === "commit") {
      const at = it.text.indexOf("\ndiff:\n");
      const head = at > 0 ? it.text.slice(0, at) : it.text;
      if (at > 0 && files.length && files.every((f) => changed.has(f))) out.push({ ...it, facts, text: `${head}\n(diff not repeated: these changes are shown in the file changes)` });
      else out.push({ ...it, facts, text: raw ? `${head}\nchanges:\n${cut(compactDiff(raw), budget.commitDiff).text}` : it.text });
      continue;
    }
    if (it.kind === "file_change" && raw) {
      const heading = it.text.split("\n")[0]!.replace(/seen by the file watcher while an AI command was running \((\w+) link: ([^)]*)\)/,
        (_m, strength: string, basis: string) => `seen by the file watcher while an AI command ran (${strength} link${/names the file/.test(basis) ? "; the command names this file" : ""})`);
      out.push({ ...it, facts, text: `${heading}\nchanges:\n${cut(compactDiff(raw).replace(/^file .*\n/gm, ""), budget.diff).text}` }); // the heading already names the file
      continue;
    }
    out.push({ ...it, facts });
  }
  if (looked.length)
    out.push({ kind: "reads", eventIds: looked.flatMap((i) => i.eventIds), at: looked[0]!.at, facts: {},
      text: `The AI also ran ${looked.length} command${looked.length === 1 ? "" : "s"} that only looked around (output not included): ${cut1500(looked.map((i) => String(i.facts.label)).join("; "))}` });
  return out;
}
/**
 * A diff as just its changes: added and removed lines under their file and hunk headings, without
 * unchanged context or index lines. Long runs of removed lines are counted, not repeated: a how-to
 * needs what was written, and the removed code mostly matters as "this replaced that".
 */
export function compactDiff(diff: string): string {
  const out: string[] = [];
  let removed: string[] = [];
  const flush = () => {
    if (removed.length > 4) out.push(...removed.slice(0, 2), `-… (${removed.length - 2} more lines removed)`);
    else out.push(...removed);
    removed = [];
  };
  for (const line of diff.split("\n")) {
    if (line.startsWith("-") && !line.startsWith("---")) {
      removed.push(line);
      continue;
    }
    flush();
    if (line.startsWith("+++ ")) out.push(`file ${line.slice(4).replace(/^b\//, "")}`);
    else if (line.startsWith("@@")) out.push(line.replace(/^@@ [^@]*@@ ?/, "@@ ").trimEnd());
    else if (line.startsWith("+") && !line.startsWith("+++")) out.push(line);
    // unchanged context, "diff --git", "index …" and "--- a/…" lines are left out
  }
  flush();
  return out.join("\n").replace(/(^|\n)@@ *\n(?=@@|$)/g, "$1"); // headings with nothing under them
}

const cut1500 = (s: string) => (s.length > 1500 ? `${s.slice(0, 1499)}…` : s);

/** Claude Code's own bookkeeping tools (task lists, wrap-up, loading tools). */
const HOUSEKEEPING = /^mcp__ccd_|^(ToolSearch|Skill|TodoWrite|TaskCreate|TaskUpdate|TaskList|TaskGet)$/;

/** Quoted text (a commit message, a search pattern) is not more commands. */
const unquote = (c: string) => c.replace(/<<-?\s*['"]?(\w+)['"]?[\s\S]*?\n\1\b/g, "").replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');

/** Read-only verbs: commands made only of these change nothing. */
const READ_ONLY = /^(cat|head|tail|less|more|grep|egrep|fgrep|rg|ls|wc|sort|uniq|cut|tr|awk|diff|cmp|file|stat|du|df|pwd|echo|printf|which|whereis|type|tree|jq|column|date|basename|dirname|realpath|readlink|true|test|\[|ps|lsof|id|whoami|uname|env|printenv|nl|md5|shasum|xxd|od|strings|plutil|defaults read|sqlite3 -readonly|npm ls|npm view|npm outdated|node (-v|--version)|python3? (-V|--version))\b/;
const GIT_READ = /^git (status|diff|log|show|branch( --show-current| -a| -v| --list)?$|rev-parse|ls-files|remote -v|blame|describe|shortlog|grep|config --get|stash list|tag( -l)?$)/;

/** A shell command that only reads: every part of it is a read-only verb, with no writing redirect. */
export function isReadOnlyCommand(cmd: string): boolean {
  const c = unquote(cmd).trim();
  if (!c || /<<|\btee\b|\b(rm|mv|cp|mkdir|touch|chmod|chown|ln|kill|pkill)\b/.test(c)) return false;
  if (/(^|[^0-9&>-])>(?!\s*\/dev\/null|&)/.test(c.replace(/2>&1|&>\/dev\/null|2>\/dev\/null/g, ""))) return false; // writes to a file
  const parts = c.split(/&&|\|\||;|\n|\|/).map((x) => x.trim()).filter(Boolean);
  return parts.every((x) => /^cd\s/.test(x) || (READ_ONLY.test(x) && !/^sed\b/.test(x) && !/^find\b.*-(delete|exec|ok)/.test(x)) || /^sed -n\b/.test(x) && !/\s-i\b/.test(x)
    || /^find\b/.test(x) && !/-(delete|exec|ok)\b/.test(x) || GIT_READ.test(x));
}

/** A command that only saves or moves work in git (add, commit, merge, push…), with nothing to teach on its own. */
export function isVersionControlCommand(cmd: string): boolean {
  const c = unquote(cmd);
  const parts = c.trim().split(/&&|;|\n/).map((x) => x.trim()).filter(Boolean);
  return parts.length > 0 && parts.every((x) => /^cd\s/.test(x) || /^git (add|commit|merge|push|pull|fetch|checkout|switch|stash|tag|status|log)\b/.test(x));
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
