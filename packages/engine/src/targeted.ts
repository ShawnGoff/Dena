import { sha256, type Store } from "@dena/core";
import { loadEpisodes } from "./episodes.ts";
import { cacheExplanation, evidenceMap, type Explanation } from "./explain.ts";
import { verificationFromFacts, whatChangedFromFacts } from "./facts.ts";
import { buildPacket, renderPacket, type Depth, type EvidenceItem, type Packet } from "./packet.ts";
import type { Provider, TokenUsage } from "./provider.ts";
import { activeRevision, adoptProposed, recordProposed, revisions, type DocType, type Revision } from "./revisions.ts";
import { Claim, ClaimKind, STEP_CLAIM_SECTIONS, Step, referenceGuide, systemPrompt } from "./schema.ts";
import { estimateTokens, type TokenEstimate } from "./tokens.ts";
import { autoFixStep, validateStep } from "./validate.ts";
import { WIKI_DEFAULT_EFFORT, buildBrief, cacheSection, renderBrief, validateSection, WIKI_SYSTEM_PROMPT, WikiSection, type Brief, type SectionKey, type WikiSource } from "./wiki.ts";
import { z } from "zod";

/**
 * Targeted updates: when a document's evidence changes, keep every statement whose cited
 * evidence is unchanged, and send the model only what changed: the statements that cite changed
 * or missing evidence, and evidence that is new. The result never replaces the current version
 * directly. It waits as a proposal, with a diff of added, changed and removed statements, until
 * the owner adopts or declines it.
 *
 * "Unchanged" is decided per evidence item: same kind, same events, and (for items written
 * since text hashes were kept) the same text the model saw. Statements the owner wrote or
 * marked are always kept as they are.
 */

const STEP_SECTIONS = STEP_CLAIM_SECTIONS;
type StepSection = (typeof STEP_SECTIONS)[number];
const FACT_SECTIONS = ["whatChanged", "verification"] as const;
export const SECTION_LABEL: Record<string, string> = {
  prerequisites: "Before you start", instructions: "Steps", check: "Check it works", pitfalls: "If it goes wrong",
  whatHappened: "What happened", whyItMattered: "Why it mattered", howItWorks: "How it works", decisions: "Decisions",
  whatChanged: "What changed", verification: "How it was verified",
};

export interface DiffEntry { section: string; text: string }
export interface UpdateDiff {
  kept: number;
  added: DiffEntry[];
  changed: (DiffEntry & { before: string })[];
  removed: DiffEntry[];
  summary: { before: string; after: string } | null;
  title: { before: string; after: string } | null;
  /** How much was sent to the model, against everything the document rests on. */
  sent: { items: number; of: number; statements: number };
}

interface Reviewed { id: string; section: string; claim: z.infer<typeof Claim>; reason: string }

export interface UpdatePlan {
  type: DocType;
  key: string;
  base: Revision;
  /** Statements kept as they are (references renumbered to the new evidence). */
  kept: Reviewed[];
  /** Statements whose evidence changed or disappeared: the model revises or drops them. */
  affected: Reviewed[];
  /** Evidence nothing kept cites: new, or changed since it was cited. */
  fresh: string[];
  /** Evidence shown to the model: the fresh items plus whatever the affected statements cited. */
  sendRefs: string[];
  allRefs: number;
  chars: number;
  needsModel: boolean;
  order: { section: string; id: string }[];
}

const itemKey = (kind: string, eventIds: number[]) => `${kind}|${[...eventIds].sort((a, b) => a - b).join(",")}`;
const sourceKey = (s: Pick<WikiSource, "type" | "grade" | "text" | "eventIds">) => `${s.type}|${s.grade}|${s.text}|${[...s.eventIds].sort((a, b) => a - b).join(",")}`;

/** Maps each old reference to its new one when that evidence is unchanged. */
function remapRefs<T>(old: Record<string, T>, sameAs: (o: T) => string | null): Map<string, string> {
  const out = new Map<string, string>();
  for (const [ref, o] of Object.entries(old)) {
    const n = sameAs(o);
    if (n) out.set(ref, n);
  }
  return out;
}

function sortClaims(sections: { name: string; claims: z.infer<typeof Claim>[] }[], remap: Map<string, string>) {
  const kept: Reviewed[] = [], affected: Reviewed[] = [];
  /** Every statement's id in document order, to rebuild each section in place. */
  const order: { section: string; id: string }[] = [];
  for (const s of sections)
    for (const c of s.claims) {
      const refs = c.evidence.map((r) => remap.get(r));
      let x: Reviewed;
      if (c.edited || c.flagged) // the owner's words stay; references that still exist are carried over
        kept.push((x = { id: `K${kept.length + 1}`, section: s.name, claim: { ...c, evidence: refs.filter((r): r is string => !!r) }, reason: "yours" }));
      else if (refs.every(Boolean)) kept.push((x = { id: `K${kept.length + 1}`, section: s.name, claim: { ...c, evidence: refs as string[] }, reason: "evidence unchanged" }));
      else {
        const gone = c.evidence.filter((r) => !remap.has(r)).length;
        affected.push((x = { id: `A${affected.length + 1}`, section: s.name, claim: c, reason: gone === c.evidence.length ? "all of its evidence changed" : `${gone} of its ${c.evidence.length} references changed` }));
      }
      order.push({ section: s.name, id: x.id });
    }
  return { kept, affected, order };
}

/**
 * Whether the owner rewrote the title or summary: statements carry an `edited` mark, but these
 * do not, so they are compared with the last version the AI wrote.
 */
function ownerWrote(store: Store, projectId: string, type: DocType, key: string, base: Revision): { title: boolean; summary: boolean } {
  if (!base.meta.userEdited) return { title: false, summary: false };
  const ai = revisions(store, projectId, type, key).find((r) => r.origin === "generated" && r.id <= base.id);
  return { title: !!ai && ai.content?.title !== base.content?.title, summary: !!ai && ai.content?.summary !== base.content?.summary };
}

// ---- steps ----

function stepPlan(store: Store, projectId: string, unitId: string): (UpdatePlan & { packet: Packet; depth: Depth }) | null {
  const base = activeRevision(store, projectId, "step", unitId);
  if (!base || base.content?.generatedBy === "facts") return null;
  const depth: Depth = base.meta.depth ?? store.projectSettings(projectId).depth ?? "thorough";
  const packet = buildPacket(store, projectId, unitId, { depth });
  const byKey = new Map<string, EvidenceItem>();
  for (const i of packet.items) if (!byKey.has(itemKey(i.kind, i.eventIds))) byKey.set(itemKey(i.kind, i.eventIds), i);
  const oldEv = (base.meta.evidence ?? {}) as Explanation["evidence"];
  const remap = remapRefs(oldEv, (o) => {
    const n = byKey.get(itemKey(o.kind, o.eventIds));
    return n && (!o.textHash || o.textHash === sha256(n.text)) ? n.ref : null;
  });
  const step = Step.parse(base.content);
  const { kept, affected, order } = sortClaims(STEP_SECTIONS.map((name) => ({ name, claims: step[name] })), remap);
  const unchanged = new Set(remap.values());
  const fresh = packet.items.filter((i) => !unchanged.has(i.ref)).map((i) => i.ref);
  // Affected statements are shown with the new form of what they cited, where it still exists.
  const citedByAffected = new Set<string>();
  for (const x of affected)
    for (const r of x.claim.evidence) {
      const o = oldEv[r];
      const n = o && byKey.get(itemKey(o.kind, o.eventIds));
      if (n) citedByAffected.add(n.ref);
    }
  const sendRefs = packet.items.map((i) => i.ref).filter((r) => fresh.includes(r) || citedByAffected.has(r));
  const chars = packet.items.filter((i) => sendRefs.includes(i.ref)).reduce((n, i) => n + i.text.length + 30, 0);
  return { type: "step", key: unitId, base, kept, affected, order, fresh, sendRefs, allRefs: packet.items.length, chars, needsModel: affected.length > 0 || fresh.length > 0, packet, depth };
}

/** What a targeted update of this document would send, for the estimate shown before running it. */
export function planUpdate(store: Store, projectId: string, type: DocType, key: string): (Omit<UpdatePlan, "base" | "order"> & { estimate: TokenEstimate | null }) | null {
  const p = type === "step" ? stepPlan(store, projectId, key) : wikiPlan(store, projectId, key as SectionKey);
  if (!p) return null;
  const { base: _b, order: _o, ...rest } = p;
  const model = store.projectSettings(projectId).model ?? "";
  const statements = p.kept.length + p.affected.length;
  const estimate = p.needsModel
    ? estimateTokens(store, model, p.chars + 4_000 + p.kept.reduce((n, x) => n + x.claim.text.length + 20, 0), 1, "code",
      Math.round(450 + 260 * (p.affected.length + Math.min(p.fresh.length, 8)) + (statements ? 0 : 1500))) // output: revised and new statements only
    : null;
  return { type: rest.type, key: rest.key, kept: rest.kept, affected: rest.affected, fresh: rest.fresh, sendRefs: rest.sendRefs, allRefs: rest.allRefs, chars: rest.chars, needsModel: rest.needsModel, estimate };
}

const updateJson = (sections: string[] | null, refPattern: string, allowOwner: boolean) => ({
  type: "object",
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
    updates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          section: sections ? { type: "string", enum: sections } : { type: "string" },
          replaces: { type: "string", description: "The id of the statement this revises (A1, K3…), or an empty string for a new statement." },
          text: { type: "string" },
          kind: { type: "string", enum: ["observed", "inferred", "agent_stated", ...(allowOwner ? ["owner_stated"] : []), "background"] },
          evidence: { type: "array", items: { type: "string", pattern: refPattern } },
          code: { type: "string", description: "For an instruction: the command or code to use, from the evidence; otherwise an empty string." },
        },
        required: ["section", "replaces", "text", "kind", "evidence", "code"],
        additionalProperties: false,
      },
    },
    remove: { type: "array", items: { type: "string" } },
    uncertainty: { type: "array", items: { type: "string" } },
  },
  required: ["title", "summary", "updates", "remove", "uncertainty"],
  additionalProperties: false,
});
const UpdateOut = z.object({
  title: z.string(),
  summary: z.string(),
  updates: z.array(z.object({ section: z.string(), replaces: z.string(), text: z.string().min(1), kind: ClaimKind, evidence: z.array(z.string()), code: z.string().optional() })),
  remove: z.array(z.string()),
  uncertainty: z.array(z.string()),
});

const UPDATE_RULES = `
You are UPDATING an existing document, not writing a new one. New evidence was captured since it was written.
- Statements marked K are kept as they are. Do not repeat them. Only if the new evidence contradicts or supersedes one, revise it (an update with "replaces" set to its id) or list its id in "remove".
- Statements marked A cite evidence that changed or no longer exists. For each, either return a revised statement that the evidence you were given supports ("replaces" set to its id), or leave it out, which removes it.
- Add new statements (empty "replaces") for what the NEW evidence adds to the story. Do not restate what K statements already say.
- Return the current title and summary unchanged unless the new evidence changes the story.
- "uncertainty": the complete updated list.
- Cite only the references in the evidence you were given.`;

function renderStatements(plan: Pick<UpdatePlan, "kept" | "affected">, label: (s: string) => string): string {
  const k = plan.kept.map((x) => `[${x.id}] (${label(x.section)}, ${x.claim.kind}${x.reason === "yours" ? ", written by the owner" : ""}) ${x.claim.text}`);
  const a = plan.affected.map((x) => `[${x.id}] (${label(x.section)}, ${x.claim.kind}; ${x.reason}) ${x.claim.text}`);
  return `<kept_statements>\n${k.join("\n") || "(none)"}\n</kept_statements>\n\n<statements_to_review>\n${a.join("\n") || "(none)"}\n</statements_to_review>`;
}

function textDiff(before: { section: string; claims: { text: string }[] }[], after: { section: string; claims: { text: string }[] }[], pairs: Map<string, string>): Omit<UpdateDiff, "summary" | "title" | "sent"> {
  const key = (s: string, t: string) => `${s}\u0000${t}`;
  const b = new Set(before.flatMap((s) => s.claims.map((c) => key(s.section, c.text))));
  const a = new Set(after.flatMap((s) => s.claims.map((c) => key(s.section, c.text))));
  const added: DiffEntry[] = [], changed: UpdateDiff["changed"] = [], removed: DiffEntry[] = [];
  let kept = 0;
  const paired = new Set<string>();
  for (const s of after)
    for (const c of s.claims) {
      if (b.has(key(s.section, c.text))) { kept++; continue; }
      const old = pairs.get(c.text);
      if (old !== undefined && !a.has(key(s.section, old))) {
        changed.push({ section: s.section, text: c.text, before: old });
        paired.add(old);
      } else added.push({ section: s.section, text: c.text });
    }
  for (const s of before) for (const c of s.claims) if (!a.has(key(s.section, c.text)) && !paired.has(c.text)) removed.push({ section: s.section, text: c.text });
  return { kept, added, changed, removed };
}

export interface UpdateResult { revision: Revision | null; diff: UpdateDiff; tokens: TokenUsage | null; costUsd: number; calledModel: boolean; ok: boolean }

/** Updates one episode's step from changed evidence; the result waits as a proposal with its diff. */
export async function updateStep(store: Store, projectId: string, unitId: string, provider: Provider,
  opts: { model?: string; signal?: AbortSignal; log?: (m: string) => void } = {}): Promise<UpdateResult> {
  const log = opts.log ?? (() => {});
  const plan = stepPlan(store, projectId, unitId);
  if (!plan) throw new Error("This episode has no AI-written explanation to update; explain it first.");
  const model = opts.model ?? store.projectSettings(projectId).model ?? "";
  const before = Step.parse(plan.base.content);
  const lists = Object.fromEntries(STEP_SECTIONS.map((x) => [x, []])) as unknown as Record<StepSection, z.infer<typeof Claim>[]>;
  // Each section is rebuilt in its original order: kept statements as they were, affected ones
  // replaced in place by their revision (or dropped), new ones at the end of their section.
  const slots = plan.order as { section: StepSection; id: string }[];
  const byId = new Map([...plan.kept, ...plan.affected].map((x) => [x.id, x]));
  let title = before.title, summary = before.summary, uncertainty = before.uncertainty;
  const replaced = new Map<string, z.infer<typeof Claim>>();
  const added: { section: StepSection; claim: z.infer<typeof Claim> }[] = [];
  const removedIds = new Set<string>();
  let tokens: TokenUsage | null = null, cost = 0, chars = 0, usedModel: string | null = plan.base.meta.model ?? null;

  if (plan.needsModel) {
    const send = plan.packet.items.filter((i) => plan.sendRefs.includes(i.ref));
    const freshSet = new Set(plan.fresh);
    const evidence = renderPacket({ ...plan.packet, items: send.map((i) => ({ ...i, text: `${freshSet.has(i.ref) ? "NEW OR CHANGED. " : "Cited by a statement under review. "}${i.text}` })) });
    const ownerNotes = send.some((i) => i.kind === "owner_note");
    const episodes = loadEpisodes(store, projectId);
    const ep = episodes.find((e) => e.id === unitId);
    const user = `Project: ${store.getProject(projectId)!.name}\nEpisode: ${ep?.title ?? unitId}\n\nCurrent title: ${before.title}\nCurrent summary: ${before.summary}\n\n${renderStatements(plan, (s) => SECTION_LABEL[s] ?? s)}\n\n<evidence>\n${evidence}\n</evidence>\n\n${referenceGuide(send)}\n\nReturn the update as JSON matching the schema.`;
    const system = `${systemPrompt(plan.depth, { ownerNotes })}\n${UPDATE_RULES}`;
    chars = user.length + system.length;
    log(`targeted update: ${plan.kept.length} statements kept, ${plan.affected.length} to review, ${plan.fresh.length} new or changed evidence items (sending ${send.length} of ${plan.allRefs})`);
    const res = await provider.generate(system, user, updateJson([...STEP_SECTIONS], "^E[0-9]+$", ownerNotes), { model: model || undefined, signal: opts.signal });
    tokens = res.tokens ?? null;
    cost = res.costUsd ?? 0;
    usedModel = res.model;
    const out = UpdateOut.parse(res.json);
    const mine = ownerWrote(store, projectId, plan.type, plan.key, plan.base);
    if (!mine.title) title = out.title.trim() || title;
    if (!mine.summary) summary = out.summary.trim() || summary;
    uncertainty = out.uncertainty;
    for (const r of out.remove) if (r.startsWith("K") && byId.get(r)?.reason !== "yours") removedIds.add(r);
    for (const u of out.updates) {
      if (!(STEP_SECTIONS as readonly string[]).includes(u.section)) continue;
      const claim = { text: u.text, kind: u.kind, evidence: u.evidence, ...(u.code?.trim() ? { code: u.code } : {}) };
      const target = byId.get(u.replaces);
      if (target && target.reason !== "yours" && !replaced.has(u.replaces)) replaced.set(u.replaces, claim);
      else if (!u.replaces) added.push({ section: u.section as StepSection, claim });
    }
  }
  for (const s of slots) {
    const x = byId.get(s.id)!;
    if (removedIds.has(s.id)) continue;
    if (replaced.has(s.id)) lists[s.section].push(replaced.get(s.id)!);
    else if (s.id.startsWith("K")) lists[s.section].push(x.claim);
    // an affected statement the model did not revise is removed
  }
  for (const a of added) lists[a.section].push(a.claim);

  let step: Step = { ...before, title, summary, uncertainty, ...lists, whatChanged: whatChangedFromFacts(plan.packet), verification: verificationFromFacts(plan.packet), generatedBy: "model" };
  let validation = validateStep(step, plan.packet, { depth: plan.depth });
  if (!validation.ok) {
    const fixed = autoFixStep(step, plan.packet, { depth: plan.depth });
    step = fixed.step;
    validation = fixed.validation;
  }
  const pairs = new Map<string, string>();
  for (const [id, c] of replaced) pairs.set(c.text, byId.get(id)!.claim.text);
  const all = [...STEP_SECTIONS, ...FACT_SECTIONS];
  const d = textDiff(all.map((s) => ({ section: s, claims: before[s] })), all.map((s) => ({ section: s, claims: step[s] })), pairs);
  const diff: UpdateDiff = { ...d, summary: summary !== before.summary ? { before: before.summary, after: summary } : null, title: title !== before.title ? { before: before.title, after: title } : null,
    sent: { items: plan.needsModel ? plan.sendRefs.length : 0, of: plan.allRefs, statements: plan.affected.length } };
  const meta = { model: usedModel, requestedModel: model, depth: plan.depth, evidence: evidenceMap(plan.packet), validation, costUsd: cost, tokens,
    attempts: plan.needsModel ? 1 : 0, packetHash: plan.packet.hash, targeted: true, diff, inputChars: chars, userEdited: !!plan.base.meta.userEdited };
  const revision = recordProposed(store, projectId, "step", unitId, step, meta, `Targeted update: ${d.added.length} added, ${d.changed.length} changed, ${d.removed.length} removed, ${d.kept} kept`);
  log(`proposed: ${d.added.length} added, ${d.changed.length} changed, ${d.removed.length} removed, ${d.kept} kept`);
  return { revision, diff, tokens, costUsd: cost, calledModel: plan.needsModel, ok: validation.ok };
}

// ---- wiki pages ----

/** Which section the j-th statement (in document order) belongs to; headings can repeat. */
function sectionIndex(page: WikiSection, j: number): number {
  let n = 0;
  for (let i = 0; i < page.sections.length; i++) {
    n += page.sections[i]!.claims.length;
    if (j < n) return i;
  }
  return -1;
}

function wikiPlan(store: Store, projectId: string, key: SectionKey): (UpdatePlan & { brief: Brief }) | null {
  const base = activeRevision(store, projectId, "wiki", key);
  if (!base) return null;
  const brief = buildBrief(store, projectId, key);
  const byKey = new Map<string, WikiSource>();
  for (const s of brief.sources) if (!byKey.has(sourceKey(s))) byKey.set(sourceKey(s), s);
  const oldSources = Object.fromEntries(((base.meta.sources ?? []) as WikiSource[]).map((s) => [s.ref, s]));
  const remap = remapRefs(oldSources, (o) => byKey.get(sourceKey(o))?.ref ?? null);
  const section = WikiSection.parse(base.content);
  const { kept, affected, order } = sortClaims(section.sections.map((s) => ({ name: s.heading, claims: s.claims })), remap);
  const unchanged = new Set(remap.values());
  const fresh = brief.sources.filter((s) => !unchanged.has(s.ref)).map((s) => s.ref);
  const sendRefs = brief.sources.map((s) => s.ref).filter((r) => fresh.includes(r));
  const chars = brief.sources.filter((s) => sendRefs.includes(s.ref)).reduce((n, s) => n + s.text.length + 40, 0) + brief.context.length;
  return { type: "wiki", key, base, kept, affected, order, fresh, sendRefs, allRefs: brief.sources.length, chars, needsModel: affected.length > 0 || fresh.length > 0, brief };
}

/** Updates one wiki page from changed sources; the result waits as a proposal with its diff. */
export async function updateSection(store: Store, projectId: string, key: SectionKey, provider: Provider,
  opts: { model?: string; signal?: AbortSignal; log?: (m: string) => void } = {}): Promise<UpdateResult> {
  const log = opts.log ?? (() => {});
  const plan = wikiPlan(store, projectId, key);
  if (!plan) throw new Error("This page has not been written yet; write it first.");
  const model = opts.model ?? store.projectSettings(projectId).model ?? "";
  const before = WikiSection.parse(plan.base.content);
  const byId = new Map([...plan.kept, ...plan.affected].map((x) => [x.id, x]));
  const order = before.sections.map((s, i) => ({ heading: s.heading, ids: plan.order.filter((o, j) => o.section === s.heading && sectionIndex(before, j) === i).map((o) => o.id) }));
  let title = before.title, summary = before.summary, uncertainty = before.uncertainty;
  const replaced = new Map<string, z.infer<typeof Claim>>();
  const added: { heading: string; claim: z.infer<typeof Claim> }[] = [];
  const removedIds = new Set<string>();
  let tokens: TokenUsage | null = null, cost = 0, chars = 0, usedModel: string | null = plan.base.meta.model ?? null;

  if (plan.needsModel) {
    // Kept statements' sources are not re-sent: the model sees what they say, and only new sources in full.
    const send = plan.brief.sources.filter((s) => plan.sendRefs.includes(s.ref));
    const user = `Page: ${plan.brief.title}\n\nCurrent title: ${before.title}\nCurrent summary: ${before.summary}\nSections: ${before.sections.map((s) => s.heading).join(" | ")}\n\n${renderStatements(plan, (s) => s)}\n\n<sources>\n${renderBrief({ ...plan.brief, sources: send })}\n</sources>\n\nThe sources above are the new or changed ones. Statements under review may be revised only with these sources. Use an existing section heading where it fits; a new heading adds a section.\nReturn the update as JSON matching the schema.`;
    const system = `${WIKI_SYSTEM_PROMPT}\n${UPDATE_RULES}`;
    chars = user.length + system.length;
    log(`targeted update: ${plan.kept.length} statements kept, ${plan.affected.length} to review, ${send.length} new or changed sources of ${plan.allRefs}`);
    const res = await provider.generate(system, user, updateJson(null, "^S[0-9]+$", false), { model: model || undefined, signal: opts.signal, effort: store.projectSettings(projectId).effort ?? WIKI_DEFAULT_EFFORT });
    tokens = res.tokens ?? null;
    cost = res.costUsd ?? 0;
    usedModel = res.model;
    const out = UpdateOut.parse(res.json);
    const mine = ownerWrote(store, projectId, plan.type, plan.key, plan.base);
    if (!mine.title) title = out.title.trim() || title;
    if (!mine.summary) summary = out.summary.trim() || summary;
    uncertainty = out.uncertainty;
    for (const r of out.remove) if (r.startsWith("K") && byId.get(r)?.reason !== "yours") removedIds.add(r);
    for (const u of out.updates) {
      const claim = { text: u.text, kind: u.kind, evidence: u.evidence, ...(u.code?.trim() ? { code: u.code } : {}) };
      const target = byId.get(u.replaces);
      if (target && target.reason !== "yours" && !replaced.has(u.replaces)) replaced.set(u.replaces, claim);
      else if (!u.replaces) added.push({ heading: u.section.trim() || before.sections[before.sections.length - 1]?.heading || "More", claim });
    }
  }
  const sections = order.map((o) => ({
    heading: o.heading,
    claims: o.ids.flatMap((id) => (removedIds.has(id) ? [] : replaced.has(id) ? [replaced.get(id)!] : id.startsWith("K") ? [byId.get(id)!.claim] : [])),
  }));
  for (const a of added) {
    let s = sections.find((x) => x.heading.toLowerCase() === a.heading.toLowerCase());
    if (!s) sections.push((s = { heading: a.heading, claims: [] }));
    s.claims.push(a.claim);
  }
  const section: WikiSection = { title, summary, sections: sections.filter((s) => s.claims.length), uncertainty, ...(before.learn ? { learn: before.learn } : {}) };
  const validation = validateSection(section, plan.brief);
  const pairs = new Map<string, string>();
  for (const [id, c] of replaced) pairs.set(c.text, byId.get(id)!.claim.text);
  const d = textDiff(before.sections.map((s) => ({ section: s.heading, claims: s.claims })), section.sections.map((s) => ({ section: s.heading, claims: s.claims })), pairs);
  const diff: UpdateDiff = { ...d, summary: summary !== before.summary ? { before: before.summary, after: summary } : null, title: title !== before.title ? { before: before.title, after: title } : null,
    sent: { items: plan.needsModel ? plan.sendRefs.length : 0, of: plan.allRefs, statements: plan.affected.length } };
  const meta = { model: usedModel, requestedModel: model, sources: plan.brief.sources, validation, costUsd: cost, tokens, attempts: plan.needsModel ? 1 : 0, inputHash: plan.brief.hash,
    targeted: true, diff, inputChars: chars, userEdited: !!plan.base.meta.userEdited };
  const revision = recordProposed(store, projectId, "wiki", key, section, meta, `Targeted update: ${d.added.length} added, ${d.changed.length} changed, ${d.removed.length} removed, ${d.kept} kept`);
  log(`proposed: ${d.added.length} added, ${d.changed.length} changed, ${d.removed.length} removed, ${d.kept} kept`);
  return { revision, diff, tokens, costUsd: cost, calledModel: plan.needsModel, ok: validation.ok };
}

/**
 * Adopts a proposal. A targeted update also becomes the cached reading of its evidence, so later
 * runs (a guide build, the update queue) treat the document as current instead of rewriting it.
 */
export function adoptUpdate(store: Store, projectId: string, type: DocType, key: string, id: number): Revision {
  const r = adoptProposed(store, projectId, type, key, id);
  if (!r.meta.targeted) return r;
  if (type === "step")
    cacheExplanation(store, projectId, { unitId: key, step: Step.parse(r.content), validation: r.meta.validation, evidence: r.meta.evidence, model: r.meta.model ?? null,
      costUsd: r.meta.costUsd ?? 0, tokens: r.meta.tokens ?? null, cached: false, attempts: r.meta.attempts ?? 1, batched: false, packetHash: r.meta.packetHash },
    { requestedModel: r.meta.requestedModel ?? "", depth: r.meta.depth ?? "thorough", inputChars: r.meta.inputChars ?? 0 });
  else
    cacheSection(store, projectId, key as SectionKey, { inputHash: r.meta.inputHash, requestedModel: r.meta.requestedModel ?? "", model: r.meta.model ?? null, attempts: r.meta.attempts ?? 1,
      section: WikiSection.parse(r.content), validation: r.meta.validation, sources: r.meta.sources, costUsd: r.meta.costUsd ?? 0, inputChars: r.meta.inputChars ?? 0, tokens: r.meta.tokens ?? null });
  return r;
}
