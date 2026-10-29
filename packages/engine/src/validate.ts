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
}

const SECTIONS = ["whatHappened", "whyItMattered", "howItWorks", "whatChanged", "decisions", "verification"] as const;
const PASS = /\b(pass(es|ed|ing)?|succeed(s|ed)?|green|all tests)\b/i;
const FAIL = /\b(fail(s|ed|ing|ure)?|broke|red)\b/i;

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
