import type { Store } from "@dena/core";
import { loadEpisodes } from "./episodes.ts";
import { estimate, explainMany, type Estimate } from "./explain.ts";
import type { Provider } from "./provider.ts";
import { activeRevision } from "./revisions.ts";
import type { TokenEstimate } from "./tokens.ts";
import { buildBrief, estimateSectionTokens, generateSection, storedSection, type StoredSection } from "./wiki.ts";

/**
 * The whole-project tutorial ("Build it yourself") is one page written from every explained step.
 * Writing it covers the entire project, so the owner sees what it would cost first: the page
 * itself, and, if they want it complete, explaining the steps that are not explained yet.
 */

export interface TutorialPlan {
  /** Episodes that changed something: the steps a tutorial could cover. */
  steps: number;
  explained: number;
  /** Explained steps written as instructions (the rest were explained as a story). */
  asInstructions: number;
  /** Steps not explained yet, which "explain the rest first" would explain. */
  missing: string[];
  explainEstimate: Estimate | null;
  pageEstimate: TokenEstimate;
  written: boolean;
}

const changedSomething = (e: { stats: { fileChanges: number; commits: number; tests: number } }) => e.stats.fileChanges > 0 || e.stats.commits > 0 || e.stats.tests > 0;

/** The steps worth explaining (they changed something), and which of them are not explained yet. */
export function stepCoverage(store: Store, projectId: string): { steps: string[]; explained: string[]; missing: string[]; asInstructions: number } {
  const revs = loadEpisodes(store, projectId).filter(changedSomething).map((e) => ({ e, rev: activeRevision(store, projectId, "step", e.id) }));
  return { steps: revs.map((x) => x.e.id), explained: revs.filter((x) => x.rev).map((x) => x.e.id), missing: revs.filter((x) => !x.rev).map((x) => x.e.id),
    asInstructions: revs.filter((x) => x.rev?.content?.instructions?.length).length };
}

export function tutorialPlan(store: Store, projectId: string, model?: string): TutorialPlan {
  const cov = stepCoverage(store, projectId);
  const missing = cov.missing;
  return {
    steps: cov.steps.length,
    explained: cov.explained.length,
    asInstructions: cov.asInstructions,
    missing,
    explainEstimate: missing.length ? estimate(store, projectId, missing, { model }) : null,
    pageEstimate: estimateSectionTokens(store, projectId, buildBrief(store, projectId, "tutorial"), model),
    written: !!storedSection(store, projectId, "tutorial"),
  };
}

/** Writes the tutorial; with `explainRest`, explains the missing steps first (batched, cheapest first). */
export async function writeTutorial(store: Store, projectId: string, provider: Provider,
  opts: { explainRest?: boolean; model?: string; signal?: AbortSignal; log?: (m: string) => void } = {}): Promise<{ explainedNow: number; page: StoredSection }> {
  let explainedNow = 0;
  if (opts.explainRest) {
    const { missing } = tutorialPlan(store, projectId, opts.model);
    if (missing.length) {
      opts.log?.(`explaining ${missing.length} steps before writing the tutorial`);
      const r = await explainMany(store, projectId, missing, provider, { model: opts.model, signal: opts.signal, log: opts.log });
      explainedNow = r.explained.length;
    }
  }
  const page = await generateSection(store, projectId, "tutorial", provider, { model: opts.model, force: true, signal: opts.signal, log: opts.log });
  return { explainedNow, page };
}
