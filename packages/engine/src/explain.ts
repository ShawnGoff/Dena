import type { Store } from "@dena/core";
import { loadEpisodes } from "./episodes.ts";
import { buildPacket, renderPacket, type Packet } from "./packet.ts";
import type { Provider } from "./provider.ts";
import { PROMPT_VERSION, Step, STEP_JSON_SCHEMA, SYSTEM_PROMPT, userPrompt } from "./schema.ts";
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
  packetHash: string;
}

/**
 * Explains one episode, lazily: a cached explanation is reused while its evidence packet is
 * unchanged. A step that fails validation gets one repair attempt with the problems listed;
 * if problems remain, it is stored with them, so the reader sees the warnings rather than a
 * silently "cleaned" text.
 */
export async function explainEpisode(
  store: Store,
  projectId: string,
  unitId: string,
  provider: Provider,
  opts: { force?: boolean; log?: (m: string) => void } = {},
): Promise<Explanation> {
  const log = opts.log ?? (() => {});
  const packet = buildPacket(store, projectId, unitId);
  if (!packet.items.length) throw new Error(`Episode ${unitId} has no evidence to explain`);

  if (!opts.force) {
    const row = store.db
      .prepare("SELECT * FROM explanation WHERE project_id = ? AND unit_id = ? AND packet_hash = ? AND prompt_version = ? ORDER BY id DESC LIMIT 1")
      .get(projectId, unitId, packet.hash, PROMPT_VERSION) as any;
    if (row)
      return { unitId, step: JSON.parse(row.content_json), validation: JSON.parse(row.validation_json), evidence: JSON.parse(row.evidence_json),
        model: row.model, costUsd: row.cost_usd, cached: true, attempts: 0, packetHash: packet.hash };
  }

  const project = store.getProject(projectId)!;
  const episodes = loadEpisodes(store, projectId);
  const idx = episodes.findIndex((e) => e.id === unitId);
  const prompt = userPrompt(project.name, episodes[idx]?.title ?? unitId, renderPacket(packet), idx > 0 ? episodes[idx - 1]!.title : undefined);

  log(`sending ${packet.items.length} evidence items (${packet.chars} chars${packet.truncated ? ", some truncated" : ""}) to ${provider.name}`);
  let res = await provider.generate(SYSTEM_PROMPT, prompt, STEP_JSON_SCHEMA);
  let cost = res.costUsd ?? 0;
  let step = Step.parse(res.json);
  let validation = validateStep(step, packet);
  let attempts = 1;

  if (!validation.ok) {
    const errors = validation.issues.filter((i) => i.severity === "error");
    log(`validation found ${errors.length} problems; asking for one repair`);
    const repair = `${prompt}

Your previous answer:
${JSON.stringify(step)}

It has these problems. Fix each one by correcting the claim, citing the right evidence, changing its kind, or removing it. Do not add claims the evidence cannot support.
${errors.map((e) => `- [${e.section}] "${e.claim ?? ""}": ${e.message}`).join("\n")}`;
    res = await provider.generate(SYSTEM_PROMPT, repair, STEP_JSON_SCHEMA);
    cost += res.costUsd ?? 0;
    step = Step.parse(res.json);
    validation = validateStep(step, packet);
    attempts = 2;
  }

  const evidence = evidenceMap(packet);
  store.db
    .prepare(`INSERT OR REPLACE INTO explanation (project_id, unit_id, packet_hash, prompt_version, model, content_json, validation_json, evidence_json, cost_usd, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(projectId, unitId, packet.hash, PROMPT_VERSION, res.model, JSON.stringify(step), JSON.stringify(validation), JSON.stringify(evidence), cost, new Date().toISOString());
  return { unitId, step, validation, evidence, model: res.model, costUsd: cost, cached: false, attempts, packetHash: packet.hash };
}

export function evidenceMap(packet: Packet): Explanation["evidence"] {
  return Object.fromEntries(packet.items.map((i) => [i.ref, { eventIds: i.eventIds, kind: i.kind, at: i.at }]));
}
