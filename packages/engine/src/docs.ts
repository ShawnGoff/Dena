import type { Store } from "@dena/core";
import { storedExplanations } from "./explain.ts";
import { activeRevision, recordGenerated, type DocType, type Revision } from "./revisions.ts";
import { buildBrief, storedSection, type SectionKey } from "./wiki.ts";

/**
 * The current revision of a document. Documents written before revision history existed enter
 * it here on first use, so every reader (server, export) sees the same thing.
 */
export function ensureDocRevision(store: Store, projectId: string, type: DocType, key: string): Revision | null {
  const active = activeRevision(store, projectId, type, key);
  if (active) return active;
  if (type === "step") {
    const [x] = storedExplanations(store, projectId, key);
    if (!x) return null;
    return recordGenerated(store, projectId, "step", key, x.step, { model: x.model, requestedModel: x.requestedModel, depth: x.depth, evidence: x.evidence,
      validation: x.validation, costUsd: x.costUsd, tokens: x.tokens, attempts: x.attempts, batched: x.batched, packetHash: x.packetHash });
  }
  const w = storedSection(store, projectId, key as SectionKey);
  if (!w) return null;
  const hash = buildBrief(store, projectId, key as SectionKey).hash;
  return recordGenerated(store, projectId, "wiki", key, w.section, { model: w.model, requestedModel: w.requestedModel, sources: w.sources, validation: w.validation,
    costUsd: w.costUsd, tokens: w.tokens, attempts: w.attempts, inputHash: w.stale ? "" : hash });
}
