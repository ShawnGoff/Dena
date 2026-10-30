import type { Store } from "@dena/core";
import { loadEpisodes } from "./episodes.ts";
import { ensureMemory, loadMemory } from "./memory.ts";
import { ensureDocRevision } from "./docs.ts";
import type { Claim } from "./schema.ts";
import { sectionKeys, sourceLabel, type WikiSource } from "./wiki.ts";
import { isStandingLimitationText, standingLimitations } from "./packet.ts";
import { howBuiltPage, howBuiltStep, type HowBuilt } from "./howbuilt.ts";

/** "How the AI built this" as one line of counts, read from captured events. */
export function howBuiltLine(h: HowBuilt): string {
  const s = h.stats;
  const parts = [s.sessions && `${s.sessions} Claude Code session${s.sessions === 1 ? "" : "s"}`, s.prompts && `${s.prompts} request${s.prompts === 1 ? "" : "s"} from the owner`,
    s.aiEdits && `${s.aiEdits} AI edit${s.aiEdits === 1 ? "" : "s"}`, s.commands && `${s.commands} command${s.commands === 1 ? "" : "s"}`,
    s.tests && `${s.tests} test run${s.tests === 1 ? "" : "s"}${s.testFailures ? ` (${s.testFailures} failed)` : ""}`, s.commits && `${s.commits} commit${s.commits === 1 ? "" : "s"}`,
    s.notes && `${s.notes} note${s.notes === 1 ? "" : "s"} from the AI`].filter(Boolean);
  return `Across ${h.scope}: ${parts.join(", ") || "no captured activity"}. Counted from captured events, not written by AI.`;
}

/**
 * The whole guide as one Markdown file, rendered from the structured documents (never the other
 * way round). Each document is exported in its current revision, so the owner's edits are what
 * readers see; nothing is generated here.
 */

const BADGE: Record<string, string> = {
  observed: "✓ Observed", inferred: "~ Inferred", agent_stated: "💬 Agent said", owner_stated: "🗣 You said", background: "📘 Background",
};

const anchor = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");

function claimLine(c: Claim, refLabel: (ref: string) => string): string {
  const text = c.flagged === "incorrect" ? `~~${c.text}~~ *(marked incorrect by the owner)*` : c.text;
  const refs = c.evidence.length ? ` [${c.evidence.map(refLabel).join(", ")}]` : "";
  return `- **${BADGE[c.kind] ?? c.kind}** — ${text}${refs}${c.edited ? " *(edited by the owner)*" : ""}`;
}

export interface ExportResult {
  markdown: string;
  counts: { wikiPages: number; steps: number; stepsTotal: number };
}

export function exportGuideMarkdown(store: Store, projectId: string, opts: { generatedAt?: string } = {}): ExportResult {
  ensureMemory(store, projectId);
  const project = store.getProject(projectId)!;
  const episodes = loadEpisodes(store, projectId);
  const mem = loadMemory(store, projectId);
  const of = (k: string) => mem.filter((m) => m.kind === k);
  const out: string[] = [];
  const toc: string[] = [];
  const h2 = (title: string) => {
    toc.push(`- [${title}](#${anchor(title)})`);
    out.push("", `## ${title}`, "");
  };

  // Wiki pages, in their current revisions.
  const pages = sectionKeys(store, projectId).map((s) => ({ ...s, rev: ensureDocRevision(store, projectId, "wiki", s.key) })).filter((p) => p.rev);
  for (const p of pages) {
    const sec = p.rev!.content as { title: string; summary: string; sections: { heading: string; claims: Claim[] }[]; uncertainty: string[]; learn?: { concept: string; explanation: string }[] };
    const sources = new Map(((p.rev!.meta.sources ?? []) as WikiSource[]).map((s) => [s.ref, s]));
    const prefix = anchor(p.key);
    h2(p.key.startsWith("component:") ? `Component: ${p.title}` : sec.title || p.title);
    out.push(sec.summary);
    for (const s of sec.sections) out.push("", `### ${s.heading}`, "", ...s.claims.map((c) => claimLine(c, (r) => `[${r}](#${prefix}-${r.toLowerCase()})`)));
    const uncertainPage = sec.uncertainty.filter((u) => !isStandingLimitationText(u));
    if (uncertainPage.length) out.push("", "### What is uncertain", "", ...uncertainPage.map((u) => `- ${u}`));
    if (sec.learn?.length) out.push("", "### What you can learn here", "", ...sec.learn.map((c) => `- **${c.concept}** — ${c.explanation}`));
    out.push("", "### How the AI built this", "", howBuiltLine(howBuiltPage(store, projectId, p.key)));
    const cited = [...new Set(sec.sections.flatMap((s) => s.claims.flatMap((c) => c.evidence)))].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
    if (cited.length) {
      out.push("", "<details><summary>Sources</summary>", "");
      for (const r of cited) {
        const s = sources.get(r);
        if (s) out.push(`- <a id="${prefix}-${r.toLowerCase()}"></a>**${r}** ${sourceLabel(s)}: ${s.text} — ${s.files?.length ? `file ${s.files.join(", ")}` : `events ${s.eventIds.map((i) => `#${i}`).join(", ")}`}`);
      }
      out.push("", "</details>");
    }
    if (p.rev!.meta.userEdited) out.push("", "*This page includes the owner's edits.*");
  }

  // Walkthrough: explained episodes in order.
  const steps = episodes.map((e) => ({ e, rev: ensureDocRevision(store, projectId, "step", e.id) })).filter((x) => x.rev);
  if (steps.length) {
    h2("Walkthrough");
    out.push(`${steps.length} of ${episodes.length} episodes are explained. Episodes not listed have not been explained yet.`);
    for (const { e, rev } of steps) {
      const st = rev!.content as Record<string, any>;
      const evidence = (rev!.meta.evidence ?? {}) as Record<string, { eventIds: number[]; kind: string }>;
      const prefix = `ep${e.position}`;
      out.push("", `### ${e.position}. ${st.title}`, "", `*${e.startedAt.slice(0, 16).replace("T", " ")} UTC${rev!.meta.model ? ` · written by ${rev!.meta.model}` : ""}${rev!.meta.userEdited ? " · includes the owner's edits" : ""}*`, "", st.summary);
      const link = (r: string) => `[${r}](#${prefix}-${r.toLowerCase()})`;
      if (st.goal) out.push("", `**What you'll build:** ${st.goal}`);
      const instructions = (st.instructions ?? []) as Claim[];
      const guide: [string, string][] = [["prerequisites", "Before you start"], ["check", "Check it works"], ["pitfalls", "If it goes wrong"]];
      if ((st.prerequisites as Claim[])?.length) out.push("", "**Before you start**", "", ...(st.prerequisites as Claim[]).map((c) => claimLine(c, link)));
      if (instructions.length) {
        out.push("", "**Steps**", "");
        instructions.forEach((c, i) => {
          out.push(claimLine(c, link).replace(/^- /, `${i + 1}. `));
          if (c.code) out.push("", "   ```", ...c.code.split("\n").map((l) => `   ${l}`), "   ```", "");
        });
      }
      for (const [k, label] of guide.slice(1))
        if ((st[k] as Claim[])?.length) out.push("", `**${label}**`, "", ...(st[k] as Claim[]).map((c) => claimLine(c, link)));
      const story: [string, string][] = [["whatHappened", "What happened"], ["whyItMattered", "Why it mattered"], ["howItWorks", "How it works"],
        ["whatChanged", "What changed"], ["decisions", "Decisions"], ["verification", "Verification"]];
      const sections: [string, string][] = [...guide, ["instructions", "Steps"], ...story];
      if (instructions.length) out.push("", "#### How the AI did it");
      for (const [k, label] of story)
        if ((st[k] as Claim[])?.length) out.push("", `**${label}**`, "", ...(st[k] as Claim[]).map((c) => claimLine(c, link)));
      const uncertain = ((st.uncertainty ?? []) as string[]).filter((u) => !isStandingLimitationText(u));
      if (uncertain.length) out.push("", "**What is uncertain**", "", ...uncertain.map((u) => `- ${u}`));
      const concepts = (st.concepts ?? []) as { term: string; explanation: string }[];
      if (concepts.length) out.push("", "**What you can learn here**", "", ...concepts.map((c) => `- **${c.term}** — ${c.explanation}`));
      out.push("", "**How the AI built this**", "", howBuiltLine(howBuiltStep(store, projectId, e.id)));
      const cited = [...new Set(sections.flatMap(([k]) => ((st[k] ?? []) as Claim[]).flatMap((c) => c.evidence)))].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
      if (cited.length) {
        out.push("", "<details><summary>Evidence</summary>", "");
        for (const r of cited) if (evidence[r]) out.push(`- <a id="${prefix}-${r.toLowerCase()}"></a>**${r}** ${evidence[r]!.kind} — events ${evidence[r]!.eventIds.map((i) => `#${i}`).join(", ") || "(capture gap)"}`);
        out.push("", "</details>");
      }
    }
  }

  // Facts-built sections.
  const problems = of("problem").sort((a, b) => b.sortKey - a.sortKey);
  if (problems.length) {
    h2("Problems and fixes");
    out.push("Read from captured test runs. That the changes in between fixed a failure is inferred, not shown.", "");
    for (const m of problems) {
      const d = m.data as any;
      out.push(`- **${m.title}** — ${d.status === "fixed" ? "fixed" : "still failing"}; failed ${d.failedRuns} time(s)${d.fixCounts ? `, then ${d.fixCounts.passed ?? "?"} passed` : ""}${d.commitAfterFix ? `; next commit ${d.commitAfterFix.sha} “${d.commitAfterFix.message}” (inferred link)` : ""}`);
    }
  }
  const decisions = of("decision");
  if (decisions.length) {
    h2("Decisions");
    for (const d of decisions) out.push(`- **${BADGE[(d.data as any).claimKind] ?? "Recorded"}** — ${(d.data as any).text}`);
  }
  const concepts = of("concept").sort((a, b) => a.title.localeCompare(b.title));
  if (concepts.length) {
    h2("Glossary");
    out.push("General background written while explaining episodes; not claims about this project.", "");
    for (const c of concepts) out.push(`- **${c.title}** — ${(c.data as any).explanation}`);
  }
  const unknowns = of("question");
  if (unknowns.length) {
    h2("What is unknown");
    for (const q of unknowns.slice(0, 60)) out.push(`- ${(q.data as any).text}`);
  }

  const date = opts.generatedAt ?? new Date().toISOString();
  const head = [
    `# ${project.name}: how it got built`, "",
    `> **Written by AI from captured project evidence, with the owner's corrections. It can be wrong.** Statements are labeled: **✓ Observed** (shown by the evidence), **~ Inferred** (a reasonable conclusion), **💬 Agent said** (the AI's own account), **🗣 You said** (the owner's context), **📘 Background** (general knowledge). References point to captured events (#123) kept in Dena.`,
    "", `*Exported from Dena on ${date.slice(0, 16).replace("T", " ")} UTC · ${episodes.length} episodes, ${steps.length} explained · ${pages.length} wiki pages written*`,
    ...(standingLimitations(store, projectId).length
      ? ["", "**About this guide.** What Dena could not capture, true for the whole project:", "", ...standingLimitations(store, projectId).map((l) => `- ${l}`),
        "- Changes the file watcher or git saw have no recorded author; where Dena connects them to the AI, that is marked as likely, not certain."]
      : []),
    "", "## Contents", "", ...toc,
  ];
  if (!pages.length && !steps.length) head.push("", "*Nothing has been written yet. Open the Wiki or the Guide in Dena to write pages; the sections below are built from captured facts.*");
  return { markdown: [...head, ...out, ""].join("\n"), counts: { wikiPages: pages.length, steps: steps.length, stepsTotal: episodes.length } };
}
