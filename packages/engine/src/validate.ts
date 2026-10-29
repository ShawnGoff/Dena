import type { Packet } from "./packet.ts";
import type { Claim, Step } from "./schema.ts";

/**
 * Programmatic checks on a generated step. They catch a known set of mistakes; passing them
 * does not mean the explanation is correct, and the UI must not present it that way.
 */

export interface Issue {
  severity: "error" | "warning";
  section: string;
  claim?: string;
  message: string;
}

export interface Validation {
  ok: boolean;
  issues: Issue[];
  counts: Record<Claim["kind"], number>;
  /** Share of project-specific claims (non-background) whose citations all exist. */
  citedShare: number;
  /** The errors that triggered a repair call, kept so repair causes can be measured. */
  repairReasons?: Issue[];
  /** Problems Dena fixed itself by removing or weakening statements, shown to the reader. */
  autoFixes?: string[];
}

const SECTIONS = ["whatHappened", "whyItMattered", "howItWorks", "whatChanged", "decisions", "verification"] as const;
/**
 * Claims about a test outcome ("tests passed", "the suite failed", "all 33 pass"). Descriptions
 * such as "the failing test" or "fix the failure" are not outcome claims: matching them removed
 * correct statements in a real run.
 */
const PASS = /\b(?:tests?|suite|run|checks?)\b[^.;]{0,40}\b(?:pass(?:es|ed)?|succeed(?:s|ed)?|went green)\b|\ball (?:\d+ )?(?:tests? )?pass(?:ed|es)?\b|\b\d+ (?:tests? )?passed\b/i;
const FAIL = /\b(?:tests?|suite|run|checks?)\b[^.;]{0,40}\b(?:fail(?:s|ed)?|broke)\b|\b\d+ (?:tests? )?failed\b/i;

export function validateStep(step: Step, packet: Packet, opts: { depth?: "concise" | "thorough" } = {}): Validation {
  const issues: Issue[] = [];
  const items = new Map(packet.items.map((i) => [i.ref, i]));
  const counts = { observed: 0, inferred: 0, agent_stated: 0, owner_stated: 0, background: 0 };
  let specific = 0, wellCited = 0;

  for (const section of SECTIONS) {
    for (const c of step[section]) {
      counts[c.kind]++;
      const short = c.text.slice(0, 80);
      const missing = c.evidence.filter((r) => !items.has(r));
      if (missing.length) issues.push({ severity: "error", section, claim: short, message: `cites evidence that does not exist: ${missing.join(", ")}` });
      const cited = c.evidence.map((r) => items.get(r)).filter(Boolean) as Packet["items"];

      if (c.kind !== "background") {
        specific++;
        if (c.evidence.length === 0) issues.push({ severity: "error", section, claim: short, message: `${c.kind} claim cites no evidence` });
        else if (!missing.length) wellCited++;
      }
      if (c.kind === "agent_stated" && cited.length && !cited.some((i) => i.kind === "agent_note" || i.kind === "ai_response"))
        issues.push({ severity: "error", section, claim: short, message: "agent_stated claim must cite an AGENT NOTE or AI RESPONSE" });
      if (c.kind === "owner_stated" && cited.length && !cited.some((i) => i.kind === "owner_note"))
        issues.push({ severity: "error", section, claim: short, message: "owner_stated claim must cite an OWNER NOTE" });
      if ((c.kind === "observed" || c.kind === "inferred") && cited.length && cited.every((i) => i.kind === "owner_note"))
        issues.push({ severity: "error", section, claim: short, message: "the owner's notes are not evidence of events; label this owner_stated" });

      // Test outcomes must agree with what was captured.
      const tests = cited.filter((i) => i.kind === "test");
      if (tests.length && c.kind !== "background") {
        const outcomes = new Set(tests.map((t) => t.facts.outcome));
        if (PASS.test(c.text) && !FAIL.test(c.text) && !outcomes.has("passed"))
          issues.push({ severity: "error", section, claim: short, message: `says tests passed, but the cited test runs were: ${[...outcomes].join(", ")}` });
        if (FAIL.test(c.text) && !PASS.test(c.text) && !outcomes.has("failed") && !c.text.match(/unknown|not (observed|captured)/i))
          issues.push({ severity: "error", section, claim: short, message: `says tests failed, but the cited test runs were: ${[...outcomes].join(", ")}` });
      }
      if (section === "verification" && c.kind === "observed" && PASS.test(c.text) && !cited.some((i) => i.kind === "test" || i.kind === "command"))
        issues.push({ severity: "error", section, claim: short, message: "verification claim about a result must cite the test run or command" });

      // Files named in a change claim must appear in what it cites.
      if (section === "whatChanged" && c.kind === "observed") {
        const named = c.text.match(/[\w.-]+\/[\w./-]+\.\w+|\b[\w-]+\.(?:[jt]sx?|css|html|md|json|py|lua|rs|go|swift|ya?ml|toml|sh)\b/g) ?? [];
        const citedText = cited.map((i) => `${i.text} ${JSON.stringify(i.facts)}`).join("\n");
        for (const f of named) {
          const base = f.split("/").pop()!;
          if (!citedText.includes(base)) issues.push({ severity: "error", section, claim: short, message: `names ${f}, which is not in the cited evidence` });
        }
      }
    }
  }

  // Depth: an explanation that only restates what happened has not taught anything.
  const howChars = step.howItWorks.reduce((n, c) => n + c.text.length, 0);
  const substantial = packet.items.some((i) => i.kind === "file_change" || i.kind === "commit");
  const minHow = opts.depth === "concise" ? 150 : 400;
  if (step.generatedBy !== "facts" && substantial && howChars < minHow)
    issues.push({ severity: "warning", section: "howItWorks", message: `only ${howChars} characters; the mechanism is not really explained` });
  if (packet.truncated && !step.uncertainty.some((u) => /truncat|not included|cut|partial/i.test(u)))
    issues.push({ severity: "warning", section: "uncertainty", message: "evidence was truncated but the step does not say so" });

  return { ok: !issues.some((i) => i.severity === "error"), issues, counts, citedShare: specific ? wellCited / specific : 1 };
}

const MODEL_SECTIONS = ["whatHappened", "whyItMattered", "howItWorks", "decisions"] as const;

/**
 * Fixes check failures without another model call, but only in ways that make the step say
 * less, never more: a wrong label is lowered, a reference to evidence that does not exist is
 * dropped, and a statement left with no support, or contradicting a captured test result, is
 * removed. Every change is listed so the reader can see it.
 *
 * Returns `acceptable: false` when fixing would strip too much (then a repair call is better).
 */
export function autoFixStep(step: Step, packet: Packet, opts: { depth?: "concise" | "thorough" } = {}):
  { step: Step; validation: Validation; fixes: string[]; acceptable: boolean } {
  const items = new Map(packet.items.map((i) => [i.ref, i]));
  const isAgent = (r: string) => ["agent_note", "ai_response"].includes(items.get(r)?.kind ?? "");
  const isOwner = (r: string) => items.get(r)?.kind === "owner_note";
  const fixes: string[] = [];
  const before = MODEL_SECTIONS.reduce((n, s) => n + step[s].length, 0);
  let removed = 0;
  const out: Step = structuredClone(step);
  const short = (t: string) => `“${t.length > 70 ? `${t.slice(0, 69)}…` : t}”`;

  for (let pass = 0; pass < 3; pass++) {
    const errors = validateStep(out, packet, opts).issues.filter((i) => i.severity === "error" && i.claim);
    if (!errors.length) break;
    for (const e of errors) {
      if (!(MODEL_SECTIONS as readonly string[]).includes(e.section)) continue; // fact sections are Dena's own
      const list = out[e.section as (typeof MODEL_SECTIONS)[number]];
      const i = list.findIndex((c) => c.text.slice(0, 80) === e.claim);
      if (i < 0) continue;
      const c = list[i]!;
      if (e.message.startsWith("cites evidence that does not exist")) {
        c.evidence = c.evidence.filter((r) => items.has(r));
        fixes.push(`Dropped a reference to evidence that does not exist from ${short(c.text)}.`);
        if (!c.evidence.length && c.kind !== "background") {
          list.splice(i, 1);
          removed++;
          fixes.push(`Removed ${short(c.text)}: none of its references existed.`);
        }
      } else if (/claim cites no evidence$/.test(e.message) || /^says tests (passed|failed)/.test(e.message)) {
        list.splice(i, 1);
        removed++;
        fixes.push(`Removed ${short(c.text)}: ${e.message.startsWith("says") ? "it contradicted the captured test result" : "it cited no evidence"}.`);
      } else if (e.message.startsWith("agent_stated claim must cite")) {
        c.kind = "inferred";
        fixes.push(`Relabelled ${short(c.text)} from “Agent said” to “Inferred”: it does not cite anything the AI said.`);
      } else if (e.message.startsWith("owner_stated claim must cite")) {
        c.kind = c.evidence.some(isAgent) ? "agent_stated" : "inferred";
        fixes.push(`Relabelled ${short(c.text)} from “You said” to “${c.kind === "agent_stated" ? "Agent said" : "Inferred"}”: there is no note from you behind it.`);
      } else if (e.message.startsWith("the owner's notes are not evidence")) {
        c.kind = "owner_stated";
        c.evidence = c.evidence.filter(isOwner);
        fixes.push(`Relabelled ${short(c.text)} as “You said”: it rests only on your notes.`);
      }
    }
  }
  const validation = validateStep(out, packet, opts);
  const emptied = MODEL_SECTIONS.some((s) => step[s].length >= 2 && out[s].length === 0);
  const acceptable = validation.ok && !emptied && removed <= Math.max(1, Math.floor(before * 0.2));
  return { step: out, validation: { ...validation, autoFixes: fixes }, fixes, acceptable };
}
