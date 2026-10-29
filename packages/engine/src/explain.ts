import type { Store } from "@dena/core";
import { loadEpisodes } from "./episodes.ts";
import { factsOnlyStep, needsModel, verificationFromFacts, whatChangedFromFacts } from "./facts.ts";
import { buildPacket, renderPacket, type Depth, type Packet } from "./packet.ts";
import type { Provider } from "./provider.ts";
import { BATCH_JSON_SCHEMA, ModelStep, PROMPT_VERSION, STEP_JSON_SCHEMA, Step, batchPrompt, systemPrompt, userPrompt } from "./schema.ts";
import { validateStep, type Validation } from "./validate.ts";

export interface Explanation {
  unitId: string;
  step: Step;
  validation: Validation;
  evidence: Record<string, { eventIds: number[]; kind: string; at: string }>;
  model: string | null;
  costUsd: number | null;
  cached: boolean;
  attempts: number;
  batched: boolean;
  packetHash: string;
}

export interface ExplainOptions {
  force?: boolean;
  /** Overrides the project's model setting for this run. */
  model?: string;
  depth?: Depth;
  log?: (m: string) => void;
}

/** Settings resolved from the project, overridable per run. */
function resolve(store: Store, projectId: string, opts: ExplainOptions) {
  const s = store.projectSettings(projectId);
  return { model: opts.model ?? s.model ?? "", depth: opts.depth ?? s.depth ?? "thorough", maxUsd: s.maxUsdPerRun };
}

export function evidenceMap(packet: Packet): Explanation["evidence"] {
  return Object.fromEntries(packet.items.map((i) => [i.ref, { eventIds: i.eventIds, kind: i.kind, at: i.at }]));
}

function cachedRow(store: Store, projectId: string, unitId: string, packet: Packet, model: string): Explanation | null {
  // Any model's explanation of the same evidence is reused unless a specific model was asked for.
  const row = store.db
    .prepare(`SELECT * FROM explanation WHERE project_id = ? AND unit_id = ? AND packet_hash = ? AND prompt_version = ?
              ORDER BY (requested_model = ? OR model = ?) DESC, (generated_by = 'facts') DESC, id DESC LIMIT 1`)
    .get(projectId, unitId, packet.hash, PROMPT_VERSION, model, model) as any;
  if (!row) return null;
  if (model && row.generated_by !== "facts" && row.requested_model !== model && row.model !== model) return null;
  return { unitId, step: Step.parse(JSON.parse(row.content_json)), validation: JSON.parse(row.validation_json), evidence: JSON.parse(row.evidence_json),
    model: row.model, costUsd: row.cost_usd, cached: true, attempts: row.attempts, batched: !!row.batched, packetHash: packet.hash };
}

function save(store: Store, projectId: string, x: Explanation, meta: { requestedModel: string; depth: Depth; inputChars: number }) {
  store.db
    .prepare(`INSERT OR REPLACE INTO explanation (project_id, unit_id, packet_hash, prompt_version, requested_model, model, depth, generated_by,
              attempts, batched, input_chars, output_chars, content_json, validation_json, evidence_json, cost_usd, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(projectId, x.unitId, x.packetHash, PROMPT_VERSION, x.step.generatedBy === "facts" ? "" : meta.requestedModel, x.model, meta.depth,
      x.step.generatedBy, x.attempts, x.batched ? 1 : 0, meta.inputChars, JSON.stringify(x.step).length,
      JSON.stringify(x.step), JSON.stringify(x.validation), JSON.stringify(x.evidence), x.costUsd, new Date().toISOString());
}

function assemble(model: ModelStep, packet: Packet): Step {
  return { ...model, whatChanged: whatChangedFromFacts(packet), verification: verificationFromFacts(packet), generatedBy: "model" };
}

function repairPrompt(original: string, step: Step, v: Validation): string {
  const { whatChanged: _a, verification: _b, generatedBy: _c, ...modelPart } = step;
  return `${original}

Your previous answer:
${JSON.stringify(modelPart)}

It has these problems. Fix each one by correcting the claim, citing the right evidence, changing its kind, or removing it. Do not add claims the evidence cannot support.
${v.issues.filter((i) => i.severity === "error").map((e) => `- [${e.section}] "${e.claim ?? ""}": ${e.message}`).join("\n")}`;
}

/**
 * Explains one episode, lazily. Order of preference, cheapest first:
 *   1. a cached explanation of the same evidence;
 *   2. a facts-only step when the episode changed nothing (no model call);
 *   3. one model call for the narrative, with Dena filling in what changed and how it was verified;
 *   4. one repair call, only if the checks find errors. Problems that remain stay visible.
 */
export async function explainEpisode(store: Store, projectId: string, unitId: string, provider: Provider, opts: ExplainOptions = {}): Promise<Explanation> {
  const log = opts.log ?? (() => {});
  const { model, depth } = resolve(store, projectId, opts);
  const packet = buildPacket(store, projectId, unitId, { depth });
  if (!packet.items.length) throw new Error(`Episode ${unitId} has no evidence to explain`);
  if (!opts.force) {
    const hit = cachedRow(store, projectId, unitId, packet, model);
    if (hit) return hit;
  }
  const episodes = loadEpisodes(store, projectId);
  const idx = episodes.findIndex((e) => e.id === unitId);
  const title = episodes[idx]?.title ?? unitId;

  if (!needsModel(packet)) {
    const step = factsOnlyStep(packet, title);
    const x: Explanation = { unitId, step, validation: validateStep(step, packet, { depth }), evidence: evidenceMap(packet), model: null, costUsd: 0,
      cached: false, attempts: 0, batched: false, packetHash: packet.hash };
    save(store, projectId, x, { requestedModel: model, depth, inputChars: 0 });
    log("no changes in this episode; summarised from facts without a model call");
    return x;
  }

  const project = store.getProject(projectId)!;
  const prompt = userPrompt(project.name, title, renderPacket(packet), idx > 0 ? episodes[idx - 1]!.title : undefined);
  const system = systemPrompt(depth);
  log(`sending ${packet.items.length} evidence items (${packet.chars} chars${packet.truncated ? ", some truncated" : ""}) to ${provider.name}${model ? ` [${model}]` : ""}, depth ${depth}`);
  let res = await provider.generate(system, prompt, STEP_JSON_SCHEMA, { model: model || undefined });
  let cost = res.costUsd ?? 0;
  let step = assemble(ModelStep.parse(res.json), packet);
  let validation = validateStep(step, packet, { depth });
  let attempts = 1;
  if (!validation.ok) {
    log(`checks found ${validation.issues.filter((i) => i.severity === "error").length} problems; one repair call`);
    res = await provider.generate(system, repairPrompt(prompt, step, validation), STEP_JSON_SCHEMA, { model: model || undefined });
    cost += res.costUsd ?? 0;
    step = assemble(ModelStep.parse(res.json), packet);
    validation = validateStep(step, packet, { depth });
    attempts = 2;
  }
  const x: Explanation = { unitId, step, validation, evidence: evidenceMap(packet), model: res.model, costUsd: cost, cached: false, attempts, batched: false, packetHash: packet.hash };
  save(store, projectId, x, { requestedModel: model, depth, inputChars: prompt.length + system.length });
  return x;
}

export interface Estimate {
  episodes: number;
  cached: number;
  factsOnly: number;
  modelCalls: number;
  inputChars: number;
  /** From this model's past runs in this store; null when there is no history to go on. */
  estimatedUsd: number | null;
  basis: string;
}

const BATCH_MAX_ITEM_CHARS = 8_000;
const BATCH_MAX_CHARS = 24_000;
const BATCH_MAX_EPISODES = 5;

/** What a batch run would do, before doing it. */
export function estimate(store: Store, projectId: string, unitIds: string[], opts: ExplainOptions = {}): Estimate {
  const { model, depth } = resolve(store, projectId, opts);
  let cached = 0, factsOnly = 0, inputChars = 0, small = 0, smallChars = 0, large = 0;
  for (const id of unitIds) {
    const p = buildPacket(store, projectId, id, { depth });
    if (!opts.force && cachedRow(store, projectId, id, p, model)) cached++;
    else if (!needsModel(p)) factsOnly++;
    else {
      inputChars += p.chars;
      if (p.chars <= BATCH_MAX_ITEM_CHARS) {
        small++;
        smallChars += p.chars;
      } else large++;
    }
  }
  const batches = Math.max(Math.ceil(small / BATCH_MAX_EPISODES), Math.ceil(smallChars / BATCH_MAX_CHARS));
  const modelCalls = large + batches;
  const hist = store.db
    .prepare(`SELECT SUM(cost_usd) c, SUM(input_chars) i, COUNT(*) n FROM explanation
              WHERE generated_by = 'model' AND input_chars > 0 AND cost_usd > 0 AND (requested_model = ? OR model = ?)`)
    .get(model, model) as { c: number | null; i: number | null; n: number };
  const perChar = hist.n >= 2 && hist.c && hist.i ? hist.c / hist.i : null;
  return {
    episodes: unitIds.length, cached, factsOnly, modelCalls, inputChars,
    estimatedUsd: perChar !== null ? perChar * (inputChars + modelCalls * 6_000) * 1.15 : null, // instructions per call, plus repair allowance
    basis: perChar !== null ? `${hist.n} past explanations with ${model || "your default model"}` : `no past explanations with ${model || "your default model"} yet`,
  };
}

export interface BatchResult {
  explained: Explanation[];
  skippedForBudget: string[];
  spentUsd: number;
  calls: number;
}

/**
 * Explains many episodes with as few calls as possible: cached and facts-only episodes cost
 * nothing, small episodes share a call, large ones get their own. Stops before a call that
 * would exceed the run's budget.
 */
export async function explainMany(
  store: Store,
  projectId: string,
  unitIds: string[],
  provider: Provider,
  opts: ExplainOptions & { maxUsd?: number; onProgress?: (x: Explanation) => void } = {},
): Promise<BatchResult> {
  const log = opts.log ?? (() => {});
  const { model, depth, maxUsd: settingMax } = resolve(store, projectId, opts);
  const maxUsd = opts.maxUsd ?? settingMax;
  const project = store.getProject(projectId)!;
  const titles = new Map(loadEpisodes(store, projectId).map((e) => [e.id, e.title]));
  const result: BatchResult = { explained: [], skippedForBudget: [], spentUsd: 0, calls: 0 };
  const done = (x: Explanation) => {
    result.explained.push(x);
    opts.onProgress?.(x);
  };
  const avgCall = () => (result.calls ? result.spentUsd / result.calls : 0);
  // Stop once the cap is reached, or when the next call would likely cross it (judged by this run's average call).
  const overBudget = () => maxUsd !== undefined && (result.spentUsd >= maxUsd || result.spentUsd + avgCall() > maxUsd);

  const small: { id: string; packet: Packet }[] = [];
  const large: string[] = [];
  for (const id of unitIds) {
    const packet = buildPacket(store, projectId, id, { depth });
    if (!packet.items.length) continue;
    const hit = !opts.force ? cachedRow(store, projectId, id, packet, model) : null;
    if (hit) done(hit);
    else if (!needsModel(packet)) done(await explainEpisode(store, projectId, id, provider, { ...opts, force: true }));
    else if (packet.chars <= BATCH_MAX_ITEM_CHARS) small.push({ id, packet });
    else large.push(id);
  }

  // Small episodes, several per call.
  const system = systemPrompt(depth);
  while (small.length) {
    const group: typeof small = [];
    let chars = 0;
    while (small.length && group.length < BATCH_MAX_EPISODES && (group.length === 0 || chars + small[0]!.packet.chars <= BATCH_MAX_CHARS)) {
      const g = small.shift()!;
      group.push(g);
      chars += g.packet.chars;
    }
    if (overBudget()) {
      result.skippedForBudget.push(...group.map((g) => g.id), ...small.map((g) => g.id));
      small.length = 0;
      break;
    }
    const prompt = batchPrompt(project.name, group.map((g) => ({ id: g.id, title: titles.get(g.id) ?? g.id, packetText: renderPacket(g.packet) })));
    log(`one call for ${group.length} small episodes (${chars} chars)`);
    let res;
    try {
      res = await provider.generate(system, prompt, BATCH_JSON_SCHEMA, { model: model || undefined });
    } catch (err) {
      log(`batch call failed (${(err as Error).message}); explaining those episodes one by one`);
      large.unshift(...group.map((g) => g.id));
      continue;
    }
    result.calls++;
    result.spentUsd += res.costUsd ?? 0;
    const steps = ((res.json as any)?.steps ?? []) as any[];
    const share = (res.costUsd ?? 0) / group.length;
    for (const g of group) {
      const raw = steps.find((s) => s.episode === g.id);
      const parsed = raw ? ModelStep.safeParse(raw) : null;
      if (!parsed?.success) {
        large.unshift(g.id); // missing or malformed in the batch: give it its own call
        continue;
      }
      const step = assemble(parsed.data, g.packet);
      const validation = validateStep(step, g.packet, { depth });
      if (!validation.ok) {
        large.unshift(g.id); // its own call includes a repair round if needed
        continue;
      }
      const x: Explanation = { unitId: g.id, step, validation, evidence: evidenceMap(g.packet), model: res.model, costUsd: share, cached: false,
        attempts: 1, batched: true, packetHash: g.packet.hash };
      save(store, projectId, x, { requestedModel: model, depth, inputChars: Math.round((prompt.length + system.length) / group.length) });
      done(x);
    }
  }

  for (const id of large) {
    if (overBudget()) {
      result.skippedForBudget.push(id);
      continue;
    }
    const x = await explainEpisode(store, projectId, id, provider, { ...opts, force: true });
    result.calls += x.attempts;
    result.spentUsd += x.costUsd ?? 0;
    done(x);
  }
  return result;
}

export interface StoredExplanation extends Explanation {
  requestedModel: string;
  depth: Depth;
  createdAt: string;
  /** True when the episode's evidence has changed since this was written. */
  stale: boolean;
}

/**
 * The explanations already written for an episode, newest first, without generating anything.
 * Each is marked stale when the evidence it was built from no longer matches the current packet.
 */
export function storedExplanations(store: Store, projectId: string, unitId: string): StoredExplanation[] {
  const rows = store.db
    .prepare("SELECT * FROM explanation WHERE project_id = ? AND unit_id = ? AND prompt_version = ? ORDER BY id DESC")
    .all(projectId, unitId, PROMPT_VERSION) as any[];
  const current = new Map<string, string>();
  return rows.map((r) => {
    const depth = (r.depth ?? "thorough") as Depth;
    if (!current.has(depth)) current.set(depth, buildPacket(store, projectId, unitId, { depth }).hash);
    return {
      unitId, step: Step.parse(JSON.parse(r.content_json)), validation: JSON.parse(r.validation_json), evidence: JSON.parse(r.evidence_json),
      model: r.model, costUsd: r.cost_usd, cached: true, attempts: r.attempts, batched: !!r.batched, packetHash: r.packet_hash,
      requestedModel: r.requested_model, depth, createdAt: r.created_at, stale: current.get(depth) !== r.packet_hash,
    };
  });
}
