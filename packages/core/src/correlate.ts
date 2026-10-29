import type { LinkStrength, LinkType, StoredEvent } from "./model.ts";
import type { Store } from "./store.ts";

/**
 * Deterministic correlation across sources. Every link it adds is labeled "inferred" or
 * "weak" with a plain-language basis; none of them changes an event's actor. Re-running
 * it is safe: links are unique per (from, to, type).
 */

const FILE_TYPES = new Set(["file_created", "file_modified", "file_deleted"]);
const SAME_CHANGE_WINDOW_MS = 5_000;
const COMMAND_SETTLE_MS = 3_000; // watcher debounce plus scheduling slack after a command finishes

const ms = (iso: string) => Date.parse(iso);

interface Link {
  from: number;
  to: number;
  linkType: LinkType;
  strength: LinkStrength;
  basis: string;
}

export interface CorrelationResult {
  sameChange: number;
  changedDuring: number;
  committedIn: number;
  createdCommit: number;
}

export function correlate(store: Store, projectId: string): CorrelationResult {
  const events = store.timeline(projectId);
  const links: Link[] = [];
  const result: CorrelationResult = { sameChange: 0, changedDuring: 0, committedIn: 0, createdCommit: 0 };

  const fsFiles = events.filter((e) => e.source === "fs" && FILE_TYPES.has(e.eventType));
  const agentFiles = events.filter((e) => e.source !== "fs" && e.source !== "git" && FILE_TYPES.has(e.eventType));
  const commits = events.filter((e) => e.eventType === "git_commit");
  const byResultSid = new Map(events.filter((e) => e.sourceEventId.startsWith("result:")).map((e) => [e.sourceEventId, e]));
  const bashCalls = events
    .filter((e) => e.eventType === "tool_invoked" && (e.payload as any).tool === "Bash")
    .map((call) => ({ call, result: byResultSid.get(`result:${call.sourceEventId.slice("tool:".length)}`) }))
    .filter((c): c is { call: StoredEvent; result: StoredEvent } => !!c.result);

  // 1. The watcher and an agent's Edit/Write result saw the same change.
  for (const f of fsFiles) {
    const match = agentFiles.find(
      (a) => a.payload.file === f.payload.file && Math.abs(ms(a.occurredAt) - ms(f.occurredAt)) <= SAME_CHANGE_WINDOW_MS,
    );
    if (match) {
      links.push({ from: f.id, to: match.id, linkType: "same_change", strength: "inferred",
        basis: `same file changed within ${SAME_CHANGE_WINDOW_MS / 1000}s in both sources` });
      result.sameChange++;
    }
  }

  // 2. A file changed while an agent's shell command was running. Overlap alone is weak;
  //    the command naming the file makes it a stronger (still inferred) connection.
  for (const f of fsFiles) {
    if (links.some((l) => l.from === f.id && l.linkType === "same_change")) continue;
    const t = ms(f.occurredAt);
    for (const { call, result: res } of bashCalls) {
      if (t < ms(call.occurredAt) || t > ms(res.occurredAt) + COMMAND_SETTLE_MS) continue;
      const file = String(f.payload.file);
      const named = String((call.payload as any).input?.command ?? "").includes(file.split("/").pop()!);
      links.push({ from: f.id, to: call.id, linkType: "changed_during",
        strength: named ? "inferred" : "weak",
        basis: named ? "file changed while this command ran, and the command names the file"
          : "file changed while this command ran; the command may or may not have made the change" });
      result.changedDuring++;
    }
  }

  // 3. A working-tree change that a later commit contains (first commit after the change that lists the file).
  const fileEvents = [...fsFiles, ...agentFiles].sort((a, b) => ms(a.occurredAt) - ms(b.occurredAt));
  for (const fe of fileEvents) {
    const t = ms(fe.occurredAt);
    const commit = commits.find(
      (c) => ms(c.occurredAt) >= t && ((c.payload as any).files as { path: string }[] | undefined)?.some((x) => x.path === fe.payload.file),
    );
    if (commit) {
      links.push({ from: fe.id, to: commit.id, linkType: "committed_in", strength: "inferred",
        basis: "first later commit that lists this file" });
      result.committedIn++;
    }
  }

  // 4. An agent command ran `git commit` and a commit appeared while it ran.
  for (const { call, result: res } of bashCalls) {
    if (!/\bgit\b[^|;&]*\bcommit\b/.test(String((call.payload as any).input?.command ?? ""))) continue;
    const commit = commits.find((c) => ms(c.occurredAt) >= ms(call.occurredAt) - 1000 && ms(c.occurredAt) <= ms(res.occurredAt) + 1000);
    if (commit) {
      links.push({ from: call.id, to: commit.id, linkType: "created_commit", strength: "inferred",
        basis: "command ran `git commit` and this commit's timestamp falls within the command's run" });
      result.createdCommit++;
    }
  }

  store.linkEvents(links);
  return result;
}
