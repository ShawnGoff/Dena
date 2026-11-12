import { sha256, type Store } from "@dena/core";
import { loadEpisodes } from "./episodes.ts";
import { factsOnlyStep, needsModel, verificationFromFacts, whatChangedFromFacts } from "./facts.ts";
import { buildPacket, packetMatches, renderPacket, type Depth, type Packet } from "./packet.ts";
import { addTokens, NO_TOKENS, type Provider, type TokenUsage } from "./provider.ts";
import { estimateTokens } from "./tokens.ts";
import { ModelStep, PROMPT_VERSION, Step, batchJsonSchema, batchPrompt, referenceGuide, stepJsonSchema, systemPrompt, userPrompt } from "./schema.ts";
import { autoFixStep, validateStep, type Validation } from "./validate.ts";
import { recordGenerated } from "./revisions.ts";

export interface Explanation {
  unitId: string;
  step: Step;
  validation: Validation;
  /** Per reference: the events behind it, and a hash of the text the model saw (to tell later whether that evidence changed). */
  evidence: Record<string, { eventIds: number[]; kind: string; at: string; textHash?: string }>;
  model: string | null;
  costUsd: number | null;
  /** Real tokens used to write it (all attempts), when the model reported them. */
  tokens: TokenUsage | null;
  cached: boolean;
  attempts: number;
  batched: boolean;
  packetHash: string;
}

export interface ExplainOptions {
  force?: boolean;
  /** Stops the generation when aborted (the Stop button). */
  signal?: AbortSignal;
  /** Overrides the project's model setting for this run. */
  model?: string;
  depth?: Depth;
  log?: (m: string) => void;
}

/** Settings resolved from the project, overridable per run. */
function resolve(store: Store, projectId: string, opts: ExplainOptions) {
  const s = store.projectSettings(projectId);
  return { model: opts.model ?? s.model ?? "", depth: opts.depth ?? s.depth ?? "thorough", maxUsd: s.maxUsdPerRun, maxTokens: s.maxTokensPerRun };
}

export function evidenceMap(packet: Packet): Explanation["evidence"] {
  return Object.fromEntries(packet.items.map((i) => [i.ref, { eventIds: i.eventIds, kind: i.kind, at: i.at, textHash: sha256(i.text) }]));
}

function cachedRow(store: Store, projectId: string, unitId: string, packet: Packet, model: string): Explanation | null {
  // Any model's explanation of the same evidence is reused unless a specific model was asked for.
  const row = store.db
    .prepare(`SELECT * FROM explanation WHERE project_id = ? AND unit_id = ? AND packet_hash IN (SELECT value FROM json_each(?)) AND prompt_version = ?
              ORDER BY (requested_model = ? OR model = ?) DESC, (generated_by = 'facts') DESC, id DESC LIMIT 1`)
    .get(projectId, unitId, JSON.stringify([packet.hash, ...packet.legacyHashes]), PROMPT_VERSION, model, model) as any;
  if (!row) return null;
  if (model && row.generated_by !== "facts" && row.requested_model !== model && row.model !== model) return null;
  return { unitId, step: Step.parse(JSON.parse(row.content_json)), validation: JSON.parse(row.validation_json), evidence: JSON.parse(row.evidence_json),
    model: row.model, costUsd: row.cost_usd, tokens: rowTokens(row), cached: true, attempts: row.attempts, batched: !!row.batched, packetHash: packet.hash };
}

const rowTokens = (r: any): TokenUsage | null =>
  r.prompt_tokens != null ? { prompt: r.prompt_tokens, output: r.output_tokens ?? 0, cacheRead: r.cache_read_tokens ?? 0 } : null;

function save(store: Store, projectId: string, x: Explanation, meta: { requestedModel: string; depth: Depth; inputChars: number }) {
  cacheExplanation(store, projectId, x, meta);
  // Every new version also enters the step's revision history (and never overwrites the owner's edits).
  recordGenerated(store, projectId, "step", x.unitId, x.step, { model: x.model, requestedModel: meta.requestedModel, depth: meta.depth,
    evidence: x.evidence, validation: x.validation, costUsd: x.costUsd, tokens: x.tokens, attempts: x.attempts, batched: x.batched, packetHash: x.packetHash });
}

/** Stores an explanation as the current reading of its evidence, so later runs reuse it instead of paying again. */
export function cacheExplanation(store: Store, projectId: string, x: Explanation, meta: { requestedModel: string; depth: Depth; inputChars: number }) {
  store.db
    .prepare(`INSERT OR REPLACE INTO explanation (project_id, unit_id, packet_hash, prompt_version, requested_model, model, depth, generated_by,
              attempts, batched, input_chars, output_chars, content_json, validation_json, evidence_json, cost_usd, created_at,
              prompt_tokens, output_tokens, cache_read_tokens)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(projectId, x.unitId, x.packetHash, PROMPT_VERSION, x.step.generatedBy === "facts" ? "" : meta.requestedModel, x.model, meta.depth,
      x.step.generatedBy, x.attempts, x.batched ? 1 : 0, meta.inputChars, JSON.stringify(x.step).length,
      JSON.stringify(x.step), JSON.stringify(x.validation), JSON.stringify(x.evidence), x.costUsd, new Date().toISOString(),
      x.tokens?.prompt ?? null, x.tokens?.output ?? null, x.tokens?.cacheRead ?? null);
}

function assemble(model: ModelStep, packet: Packet): Step {
  // Instructions always carry a "code" field in the model's answer; "" means none.
  for (const c of model.instructions) {
    if (!c.code?.trim()) delete c.code;
    c.text = c.text.replace(/^\s*(?:step\s*)?\d+[.):]\s+/i, ""); // the page numbers them
  }
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
      tokens: NO_TOKENS, cached: false, attempts: 0, batched: false, packetHash: packet.hash };
    save(store, projectId, x, { requestedModel: model, depth, inputChars: 0 });
    log("no changes in this episode; summarised from facts without a model call");
    return x;
  }

  const project = store.getProject(projectId)!;
  const ownerNotes = packet.items.some((i) => i.kind === "owner_note");
  const prompt = userPrompt(project.name, title, renderPacket(packet), idx > 0 ? episodes[idx - 1]!.title : undefined, referenceGuide(packet.items), idx === 0);
  const system = systemPrompt(depth, { ownerNotes });
  const schema = stepJsonSchema(ownerNotes);
  log(`sending ${packet.items.length} evidence items (${packet.chars} chars${packet.truncated ? ", some truncated" : ""}) to ${provider.name}${model ? ` [${model}]` : ""}, depth ${depth}`);
  let res = await provider.generate(system, prompt, schema, { model: model || undefined, signal: opts.signal });
  let cost = res.costUsd ?? 0;
  let tokens: TokenUsage | null = res.tokens ?? null;
  let sentChars = prompt.length + system.length;
  let step = assemble(ModelStep.parse(res.json), packet);
  let validation = validateStep(step, packet, { depth });
  let attempts = res.calls ?? 1; // a format retry inside the provider counts as a call
  let repairReasons: Validation["issues"] | undefined;
  if (!validation.ok) {
    // Small problems are fixed here by weakening or removing statements; a repair call only when that would strip too much.
    const fixed = autoFixStep(step, packet, { depth });
    if (fixed.acceptable) {
      log(`fixed ${fixed.fixes.length} problem${fixed.fixes.length === 1 ? "" : "s"} without another call: ${fixed.fixes.join(" ")}`);
      step = fixed.step;
      validation = { ...fixed.validation, repairReasons: validation.issues.filter((i) => i.severity === "error") };
    }
  }
  if (!validation.ok) {
    repairReasons = validation.issues.filter((i) => i.severity === "error");
    log(`checks found ${repairReasons.length} problems; one repair call: ${repairReasons.map((i) => i.message.replace(/: .*$/, "")).join("; ")}`);
    const repair = repairPrompt(prompt, step, validation);
    res = await provider.generate(system, repair, schema, { model: model || undefined, signal: opts.signal });
    cost += res.costUsd ?? 0;
    tokens = tokens && res.tokens ? addTokens(tokens, res.tokens) : null;
    sentChars += repair.length + system.length;
    step = assemble(ModelStep.parse(res.json), packet);
    validation = { ...validateStep(step, packet, { depth }), repairReasons };
    attempts += res.calls ?? 1;
  }
  const x: Explanation = { unitId, step, validation, evidence: evidenceMap(packet), model: res.model, costUsd: cost, tokens, cached: false, attempts, batched: false, packetHash: packet.hash };
  save(store, projectId, x, { requestedModel: model, depth, inputChars: sentChars });
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
  /** Tokens to send (including Dena's instructions and per-call overhead) and to be written back. */
  promptTokens: number;
  outputTokens: number;
  /** Total tokens with no repairs, and with a repair for every call. */
  tokensLow: number;
  tokensHigh: number;
  tokenBasis: string;
  tokensCalibrated: boolean;
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
  // Each call also carries Dena's instructions and the prompt wrapper around the evidence.
  const tok = estimateTokens(store, model, inputChars + modelCalls * (systemPrompt(depth).length + 400), modelCalls, depth);
  return {
    episodes: unitIds.length, cached, factsOnly, modelCalls, inputChars,
    promptTokens: tok.promptTokens, outputTokens: tok.outputTokens, tokensLow: tok.low, tokensHigh: tok.high, tokenBasis: tok.basis, tokensCalibrated: tok.calibrated,
    estimatedUsd: perChar !== null ? perChar * (inputChars + modelCalls * 6_000) * 1.15 : null, // instructions per call, plus repair allowance
    basis: perChar !== null ? `${hist.n} past explanations with ${model || "your default model"}` : `no past explanations with ${model || "your default model"} yet`,
  };
}

export interface BatchResult {
  explained: Explanation[];
  /** Left for the next run, to stay within the run's budget. */
  skippedForBudget: string[];
  spentUsd: number;
  /** Tokens this run used (sent and written), as reported. */
  spentTokens: number;
  calls: number;
}

const used = (t: TokenUsage | null | undefined) => (t ? t.prompt + t.output : 0);

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
  opts: ExplainOptions & { maxUsd?: number; maxTokens?: number; onProgress?: (x: Explanation) => void } = {},
): Promise<BatchResult> {
  const log = opts.log ?? (() => {});
  const { model, depth, maxUsd: settingMax, maxTokens: settingTokens } = resolve(store, projectId, opts);
  const maxUsd = opts.maxUsd ?? settingMax;
  const maxTokens = opts.maxTokens ?? settingTokens;
  const project = store.getProject(projectId)!;
  const all = loadEpisodes(store, projectId);
  const titles = new Map(all.map((e) => [e.id, e.title]));
  const firstId = all[0]?.id; // the first recorded step is told that earlier work may not be recorded
  const result: BatchResult = { explained: [], skippedForBudget: [], spentUsd: 0, spentTokens: 0, calls: 0 };
  const done = (x: Explanation) => {
    result.explained.push(x);
    opts.onProgress?.(x);
  };
  const avgCall = () => (result.calls ? result.spentUsd / result.calls : 0);
  const avgTokens = () => (result.calls ? result.spentTokens / result.calls : 0);
  // Stop once a cap is reached, or when the next call would likely cross it (judged by this run's average call).
  const overBudget = () => (maxUsd != null && (result.spentUsd >= maxUsd || result.spentUsd + avgCall() > maxUsd))
    || (maxTokens != null && (result.spentTokens >= maxTokens || result.spentTokens + avgTokens() > maxTokens));

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
  const anyOwner = small.some((g) => g.packet.items.some((i) => i.kind === "owner_note"));
  const system = systemPrompt(depth, { ownerNotes: anyOwner });
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
    const prompt = batchPrompt(project.name, group.map((g) => ({ id: g.id, title: titles.get(g.id) ?? g.id, packetText: `${renderPacket(g.packet)}\n\n${referenceGuide(g.packet.items)}`, first: g.id === firstId })));
    log(`one call for ${group.length} small episodes (${chars} chars)`);
    let res;
    try {
      res = await provider.generate(system, prompt, batchJsonSchema(anyOwner), { model: model || undefined, signal: opts.signal });
    } catch (err) {
      log(`batch call failed (${(err as Error).message}); explaining those episodes one by one`);
      large.unshift(...group.map((g) => g.id));
      continue;
    }
    result.calls += res.calls ?? 1;
    result.spentUsd += res.costUsd ?? 0;
    result.spentTokens += used(res.tokens);
    const steps = ((res.json as any)?.steps ?? []) as any[];
    const share = (res.costUsd ?? 0) / group.length;
    const tokShare: TokenUsage | null = res.tokens
      ? { prompt: Math.round(res.tokens.prompt / group.length), output: Math.round(res.tokens.output / group.length), cacheRead: Math.round(res.tokens.cacheRead / group.length) }
      : null;
    for (const g of group) {
      const raw = steps.find((s) => s.episode === g.id);
      const parsed = raw ? ModelStep.safeParse(raw) : null;
      if (!parsed?.success) {
        large.unshift(g.id); // missing or malformed in the batch: give it its own call
        continue;
      }
      let step = assemble(parsed.data, g.packet);
      let validation = validateStep(step, g.packet, { depth });
      if (!validation.ok) {
        const fixed = autoFixStep(step, g.packet, { depth });
        if (fixed.acceptable) ({ step, validation } = fixed);
      }
      if (!validation.ok) {
        large.unshift(g.id); // its own call includes a repair round if needed
        continue;
      }
      const x: Explanation = { unitId: g.id, step, validation, evidence: evidenceMap(g.packet), model: res.model, costUsd: share, tokens: tokShare, cached: false,
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
    result.spentTokens += used(x.tokens);
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
  const current = new Map<string, Packet>();
  return rows.map((r) => {
    const depth = (r.depth ?? "thorough") as Depth;
    if (!current.has(depth)) current.set(depth, buildPacket(store, projectId, unitId, { depth }));
    return {
      unitId, step: Step.parse(JSON.parse(r.content_json)), validation: JSON.parse(r.validation_json), evidence: JSON.parse(r.evidence_json),
      model: r.model, costUsd: r.cost_usd, tokens: rowTokens(r), cached: true, attempts: r.attempts, batched: !!r.batched, packetHash: r.packet_hash,
      requestedModel: r.requested_model, depth, createdAt: r.created_at, stale: !packetMatches(current.get(depth)!, r.packet_hash),
    };
  });
}
