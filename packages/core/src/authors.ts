import type { Store } from "./store.ts";

/**
 * "Likely author" for events no source attributed (file changes the watcher saw, commits, branch
 * switches). It is read from the connections correlation already recorded, never from timing
 * alone, and it is a reading of the evidence: the captured event keeps actor "unknown".
 */

export interface LikelyAuthor {
  who: "ai";
  /** "likely": a specific connection supports it. "possibly": only overlapping in time with an AI command. */
  confidence: "likely" | "possibly";
  basis: string;
}

const RULES: { link: string; direction: "out" | "in"; strength?: string; confidence: LikelyAuthor["confidence"]; basis: string }[] = [
  { link: "same_change", direction: "out", confidence: "likely", basis: "the same change Claude's own edit tool reported" },
  { link: "changed_during", direction: "out", strength: "inferred", confidence: "likely", basis: "changed while a Claude command that names this file was running" },
  { link: "created_commit", direction: "in", confidence: "likely", basis: "created while a Claude command running `git commit` was running" },
  { link: "changed_during", direction: "out", strength: "weak", confidence: "possibly", basis: "changed while a Claude command was running, though the command does not name this file" },
];

/** Likely authors for the given unknown-author events (all of a project's when `ids` is omitted). */
export function likelyAuthors(store: Store, projectId: string, ids?: number[]): Map<number, LikelyAuthor> {
  const filter = ids ? `AND e.id IN (${ids.map(() => "?").join(",") || "NULL"})` : "";
  const rows = store.db
    .prepare(`SELECT e.id, l.link_type, l.strength, CASE WHEN l.from_event_id = e.id THEN 'out' ELSE 'in' END AS dir
              FROM event e JOIN event_link l ON (l.from_event_id = e.id OR l.to_event_id = e.id)
              WHERE e.project_id = ? AND e.actor = 'unknown' ${filter}`)
    .all(projectId, ...(ids ?? [])) as { id: number; link_type: string; strength: string; dir: "out" | "in" }[];
  const byEvent = new Map<number, typeof rows>();
  for (const r of rows) byEvent.set(r.id, [...(byEvent.get(r.id) ?? []), r]);
  const out = new Map<number, LikelyAuthor>();
  for (const [id, links] of byEvent) {
    const rule = RULES.find((ru) => links.some((l) => l.link_type === ru.link && l.dir === ru.direction && (!ru.strength || l.strength === ru.strength)));
    if (rule) out.set(id, { who: "ai", confidence: rule.confidence, basis: rule.basis });
  }
  return out;
}

/** How the project's unknown-author events break down. */
export function authorSummary(store: Store, projectId: string): { unknown: number; likelyAi: number; possiblyAi: number; unclear: number } {
  const unknown = (store.db.prepare("SELECT COUNT(*) n FROM event WHERE project_id = ? AND actor = 'unknown'").get(projectId) as { n: number }).n;
  const map = likelyAuthors(store, projectId);
  const likelyAi = [...map.values()].filter((a) => a.confidence === "likely").length;
  const possiblyAi = [...map.values()].filter((a) => a.confidence === "possibly").length;
  return { unknown, likelyAi, possiblyAi, unclear: unknown - likelyAi - possiblyAi };
}
