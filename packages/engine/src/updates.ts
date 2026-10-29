import type { Store } from "@dena/core";
import { loadEpisodes } from "./episodes.ts";
import { explainEpisode } from "./explain.ts";
import { buildPacket, packetMatches } from "./packet.ts";
import type { Provider } from "./provider.ts";
import { activeRevision, notesFor, revisions, type DocType } from "./revisions.ts";
import { buildBrief, generateSection, sectionKeys, type SectionKey } from "./wiki.ts";

/**
 * Keeping the guide current without regenerating everything:
 * 1. find documents whose inputs changed (new evidence, or the owner's notes);
 * 2. queue only those, with the owner's go-ahead;
 * 3. process the queue with retries; failures never lose captured events or existing text,
 *    and updates to documents the owner edited arrive as proposals, not replacements.
 */

export interface Outdated {
  type: DocType;
  key: string;
  title: string;
  reason: string;
  userEdited: boolean;
  chars: number;
}

export function findOutdated(store: Store, projectId: string): Outdated[] {
  const out: Outdated[] = [];
  for (const e of loadEpisodes(store, projectId)) {
    const rev = activeRevision(store, projectId, "step", e.id);
    if (!rev || rev.content?.generatedBy === "facts") continue;
    const packet = buildPacket(store, projectId, e.id, { depth: rev.meta.depth ?? store.projectSettings(projectId).depth });
    if (packetMatches(packet, rev.meta.packetHash)) continue;
    // Notes count as new if the AI has not written a version since they were added.
    const lastWritten = revisions(store, projectId, "step", e.id).find((r) => r.origin === "generated")?.createdAt ?? rev.createdAt;
    const notes = notesFor(store, projectId, "step", e.id).filter((n) => n.createdAt > lastWritten).length;
    out.push({ type: "step", key: e.id, title: `#${e.position} ${e.title}`, reason: notes ? `${notes} new note${notes > 1 ? "s" : ""} from you` : "new evidence",
      userEdited: !!rev.meta.userEdited, chars: packet.chars });
  }
  for (const s of sectionKeys(store, projectId)) {
    const rev = activeRevision(store, projectId, "wiki", s.key);
    if (!rev) continue;
    const brief = buildBrief(store, projectId, s.key);
    if (brief.hash === rev.meta.inputHash) continue;
    out.push({ type: "wiki", key: s.key, title: s.title, reason: "new evidence", userEdited: !!rev.meta.userEdited, chars: brief.chars });
  }
  return out;
}

export interface Job {
  id: number;
  type: DocType;
  key: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  attempts: number;
  nextAt: string;
  lastError: string | null;
  result: string | null;
  updatedAt: string;
}

const toJob = (r: any): Job => ({ id: r.id, type: r.doc_type, key: r.doc_key, status: r.status, attempts: r.attempts, nextAt: r.next_at, lastError: r.last_error,
  result: r.result, updatedAt: r.updated_at });

export function listJobs(store: Store, projectId: string, limit = 50): Job[] {
  return (store.db.prepare("SELECT * FROM update_job WHERE project_id = ? ORDER BY id DESC LIMIT ?").all(projectId, limit) as any[]).map(toJob);
}

/** Queues documents for update, skipping any already waiting. */
export function enqueue(store: Store, projectId: string, items: { type: DocType; key: string }[]): number {
  const now = new Date().toISOString();
  const waiting = store.db.prepare("SELECT 1 FROM update_job WHERE project_id = ? AND doc_type = ? AND doc_key = ? AND status IN ('queued', 'running')");
  const ins = store.db.prepare("INSERT INTO update_job (project_id, doc_type, doc_key, status, next_at, created_at, updated_at) VALUES (?, ?, ?, 'queued', ?, ?, ?)");
  let n = 0;
  store.db.transaction(() => {
    for (const it of items) if (!waiting.get(projectId, it.type, it.key)) n += ins.run(projectId, it.type, it.key, now, now, now).changes;
  })();
  return n;
}

export function cancelQueued(store: Store, projectId: string): number {
  return store.db.prepare("UPDATE update_job SET status = 'cancelled', updated_at = ? WHERE project_id = ? AND status = 'queued'").run(new Date().toISOString(), projectId).changes;
}

/** After a crash or restart, jobs left "running" go back to the queue. */
export function recoverJobs(store: Store): number {
  return store.db.prepare("UPDATE update_job SET status = 'queued', updated_at = ? WHERE status = 'running'").run(new Date().toISOString()).changes;
}

/** Sign-in, billing and missing-evidence failures will not fix themselves; everything else is retried. */
export function isRetryable(message: string): boolean {
  return !/not signed in|credit balance|no valid api key|no captured evidence|no such|could not find claude code/i.test(message);
}

export const RETRY_DELAYS_MS = [10_000, 60_000];

export interface RunResult {
  done: number;
  failed: number;
  retrying: number;
  /** When the next retry is due, if any job is waiting on a backoff. */
  nextAt: string | null;
  spentUsd: number;
  stoppedForBudget: boolean;
}

/**
 * Processes due jobs one at a time. Stops before exceeding the project's per-run cap.
 * A failure is recorded on the job and retried later (up to RETRY_DELAYS_MS.length times).
 */
export async function processDueJobs(store: Store, projectId: string, provider: Provider, opts: { now?: () => number; log?: (m: string) => void } = {}): Promise<RunResult> {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  const cap = store.projectSettings(projectId).maxUsdPerRun;
  const result: RunResult = { done: 0, failed: 0, retrying: 0, nextAt: null, spentUsd: 0, stoppedForBudget: false };
  const due = store.db.prepare("SELECT * FROM update_job WHERE project_id = ? AND status = 'queued' AND next_at <= ? ORDER BY id LIMIT 1");
  const set = store.db.prepare("UPDATE update_job SET status = ?, attempts = ?, next_at = ?, last_error = ?, result = ?, updated_at = ? WHERE id = ?");
  for (;;) {
    if (cap !== undefined && result.spentUsd >= cap) {
      result.stoppedForBudget = true;
      break;
    }
    const row = due.get(projectId, new Date(now()).toISOString());
    if (!row) break;
    const job = toJob(row);
    const stamp = () => new Date(now()).toISOString();
    set.run("running", job.attempts + 1, job.nextAt, null, null, stamp(), job.id);
    try {
      let summary: string;
      if (job.type === "step") {
        const x = await explainEpisode(store, projectId, job.key, provider, { force: true, log });
        result.spentUsd += x.costUsd ?? 0;
        summary = `${x.validation.ok ? "updated" : "updated, with check problems"}${activeRevision(store, projectId, "step", job.key)?.meta.userEdited ? " (waiting as a proposal: you had edited it)" : ""}`;
      } else {
        const s = await generateSection(store, projectId, job.key as SectionKey, provider, { force: true, log });
        result.spentUsd += s.costUsd ?? 0;
        summary = `${s.validation.ok ? "updated" : "updated, with check problems"}${activeRevision(store, projectId, "wiki", job.key)?.meta.userEdited ? " (waiting as a proposal: you had edited it)" : ""}`;
      }
      set.run("done", job.attempts + 1, job.nextAt, null, summary, stamp(), job.id);
      result.done++;
    } catch (e) {
      const msg = (e as Error).message.slice(0, 300);
      const attempt = job.attempts + 1;
      if (isRetryable(msg) && attempt <= RETRY_DELAYS_MS.length) {
        const next = new Date(now() + RETRY_DELAYS_MS[attempt - 1]!).toISOString();
        set.run("queued", attempt, next, msg, null, stamp(), job.id);
        result.retrying++;
        log(`update ${job.type} ${job.key} failed (attempt ${attempt}); retrying at ${next}: ${msg}`);
      } else {
        set.run("failed", attempt, job.nextAt, msg, null, stamp(), job.id);
        result.failed++;
        log(`update ${job.type} ${job.key} failed for good: ${msg}`);
        if (!isRetryable(msg)) break; // a sign-in or billing problem will fail every job the same way
      }
    }
  }
  const pending = store.db.prepare("SELECT MIN(next_at) n FROM update_job WHERE project_id = ? AND status = 'queued'").get(projectId) as { n: string | null };
  result.nextAt = pending.n;
  return result;
}
