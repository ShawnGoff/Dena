import type { Store } from "@dena/core";

/**
 * Pausing is private: anything stamped inside a paused window (a conversation, a commit, a file
 * change) is left out, even when it is read later from Claude Code's transcripts or git history.
 * Stopping is different: work done while Dena was off is caught up when recording starts again.
 */
export interface Window { from: string; to: string }

export function pausedWindows(store: Store, projectId: string): Window[] {
  let done: Window[] = [];
  try {
    done = JSON.parse(store.getCursor(projectId, "dena", "paused_windows") ?? "[]");
  } catch { /* none recorded */ }
  // A pause still running is private too, up to whenever it ends.
  const open = store.getCursor(projectId, "dena", "paused_at");
  return open ? [...done, { from: open, to: "9999" }] : done;
}

export function addPausedWindow(store: Store, projectId: string, w: Window): void {
  if (w.to <= w.from) return;
  const done = pausedWindows(store, projectId).filter((x) => x.to !== "9999");
  store.setCursor(projectId, "dena", "paused_windows", JSON.stringify([...done, w]));
}

/** The batch without anything that happened while recording was paused. */
export function withoutPaused<T extends { events: { occurredAt: string; sourceEventId: string }[]; links: any[]; artifacts: any[] }>(store: Store, projectId: string, batch: T): T {
  const windows = pausedWindows(store, projectId);
  if (!windows.length) return batch;
  const inside = (t: string) => windows.some((w) => t >= w.from && t <= w.to);
  const dropped = new Set(batch.events.filter((e) => inside(e.occurredAt)).map((e) => e.sourceEventId));
  if (!dropped.size) return batch;
  return { ...batch, events: batch.events.filter((e) => !dropped.has(e.sourceEventId)),
    links: batch.links.filter((l) => !dropped.has(l.fromSourceEventId) && !dropped.has(l.toSourceEventId)),
    artifacts: batch.artifacts.filter((a) => !dropped.has(a.sourceEventId)) };
}
