import type { EvidenceItem, Packet } from "./packet.ts";
import type { Claim, Step } from "./schema.ts";

/**
 * Sections Dena writes from captured facts, without a model: they are exact, and they cost
 * nothing. A model only adds the narrative and teaching around them.
 */

const MODEL_WORTHY: EvidenceItem["kind"][] = ["file_change", "commit", "test", "command", "error", "agent_note"];

/** Episodes with no changes, commands or tests (questions, discussion) need no model call. */
export function needsModel(packet: Packet): boolean {
  return packet.items.some((i) => MODEL_WORTHY.includes(i.kind));
}

export function whatChangedFromFacts(packet: Packet): Claim[] {
  const claims: Claim[] = [];
  const inCommits = new Set<string>();
  for (const c of packet.items.filter((i) => i.kind === "commit")) {
    const files = (c.facts.files as string[] | undefined) ?? [];
    files.forEach((f) => inCommits.add(f));
    const shown = files.slice(0, 12).join(", ");
    const message = c.text.match(/^message: (.*)$/m)?.[1] ?? "";
    claims.push({ kind: "observed", evidence: [c.ref],
      text: `Commit ${String(c.facts.sha ?? "").slice(0, 7)} "${message.slice(0, 120)}" changed ${files.length} file${files.length === 1 ? "" : "s"}${shown ? `: ${shown}${files.length > 12 ? `, and ${files.length - 12} more` : ""}` : ""}.` });
  }
  for (const f of packet.items.filter((i) => i.kind === "file_change")) {
    const file = String(f.facts.file ?? "");
    if (!file || inCommits.has(file)) continue; // already listed under its commit
    const verb = f.facts.type === "file_created" ? "Created" : f.facts.type === "file_deleted" ? "Deleted" : "Modified";
    const lines = f.facts.added != null ? ` (+${f.facts.added} −${f.facts.removed ?? 0})` : "";
    const who = /by the AI via/.test(f.text) ? " by the AI" : /who made it is unknown/.test(f.text) ? " (author unknown)" : "";
    claims.push({ kind: "observed", evidence: [f.ref], text: `${verb} ${file}${lines}${who}.` });
  }
  return claims;
}

export function verificationFromFacts(packet: Packet): Claim[] {
  return packet.items
    .filter((i) => i.kind === "test")
    .map((t) => {
      const folded = t.text.match(/^\((\d+) earlier runs? with the same outcome/)?.[1];
      const counts = t.facts.passed != null ? ` (${t.facts.passed} passed, ${t.facts.failed ?? 0} failed)` : "";
      const outcome = t.facts.outcome === "unknown" ? "ran; outcome not captured" : `${t.facts.outcome}${counts}`;
      return { kind: "observed" as const, evidence: [t.ref], text: `Test run ${outcome}${folded ? `, after ${folded} earlier run${folded === "1" ? "" : "s"} with the same outcome` : ""}.` };
    });
}

/** A complete step for an episode with nothing to explain beyond what was said. */
export function factsOnlyStep(packet: Packet, title: string): Step {
  const prompt = packet.items.find((i) => i.kind === "prompt");
  const replies = packet.items.filter((i) => i.kind === "ai_response");
  const reads = packet.items.find((i) => i.kind === "reads");
  const gist = (s: string) => s.replace(/^[A-Z ()]+:\n/, "").split("\n").find((l) => l.trim())?.slice(0, 280) ?? "";
  const happened: Claim[] = [];
  if (prompt) happened.push({ kind: "observed", evidence: [prompt.ref], text: `The user asked: "${gist(prompt.text)}"` });
  if (reads) happened.push({ kind: "observed", evidence: [reads.ref], text: reads.text.split(":")[0]! + "." });
  const last = replies[replies.length - 1];
  if (last) happened.push({ kind: "observed", evidence: [last.ref], text: `The AI replied: "${gist(last.text)}"` });
  return {
    title,
    summary: "A conversation with no changes to the project. Dena summarised it from the captured messages without using a model.",
    whatHappened: happened,
    whyItMattered: [],
    howItWorks: [],
    decisions: [],
    concepts: [],
    uncertainty: packet.items.filter((i) => i.kind === "gap").map((g) => g.text.replace(/^KNOWN GAP IN CAPTURE: /, "")),
    whatChanged: [],
    verification: [],
    generatedBy: "facts",
  };
}
