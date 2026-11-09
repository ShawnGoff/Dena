import type { Claim, Step } from "./api";
import { isStandingLimitationText } from "./format";

/**
 * Turns the guide's structured pages into something that reads well aloud. No model is used:
 * this only rearranges text already written. Each segment is one short utterance; `anchor` names
 * the part of the page to highlight (an element with a matching data-narr attribute).
 */
export interface Segment { text: string; anchor: string }

/** Plain text for the ear: no citation markers, markdown or file noise. */
export function speakable(raw: string): string {
  return raw
    .replace(/\[(?:[SE]\d+(?:\s*,\s*[SE]\d+)*)\]/g, "")
    .replace(/```[\s\S]*?```/g, " (code example on screen) ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "a link")
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

const MAX_CHUNK = 220;

/** Splits long text at sentence ends so no utterance is long enough for a browser to cut off. */
export function chunk(text: string): string[] {
  const t = speakable(text);
  if (!t) return [];
  if (t.length <= MAX_CHUNK) return [t];
  const out: string[] = [];
  let cur = "";
  for (const s of t.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [t]) {
    if (cur && (cur + s).length > MAX_CHUNK) {
      out.push(cur.trim());
      cur = "";
    }
    cur += s;
    while (cur.length > MAX_CHUNK) {
      const cut = cur.lastIndexOf(" ", MAX_CHUNK);
      const at = cut > 40 ? cut : MAX_CHUNK;
      out.push(cur.slice(0, at).trim());
      cur = cur.slice(at);
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

class Builder {
  segments: Segment[] = [];
  say(anchor: string, text: string) {
    for (const c of chunk(text)) this.segments.push({ text: c, anchor });
  }
  heading(anchor: string, text: string) {
    this.say(anchor, /[.!?:]$/.test(text) ? text : `${text}.`);
  }
}

/** The grade a listener should hear: what Dena observed is stated plainly, the rest is introduced. */
function lead(c: Claim): string {
  if (c.flagged === "incorrect") return "This statement was marked incorrect: ";
  if (c.kind === "inferred") return "Dena infers that ";
  if (c.kind === "agent_stated") return "The AI said that ";
  return "";
}
function lower(text: string): string {
  return /^[A-Z][a-z]/.test(text) ? text[0]!.toLowerCase() + text.slice(1) : text;
}
function claimText(c: Claim, n?: number): string {
  const l = lead(c);
  const body = l && !l.endsWith(": ") ? lower(c.text) : c.text;
  const code = c.code ? " The code for this is on screen." : "";
  return `${n ? `Step ${n}. ` : ""}${l}${body}${code}`;
}

function claims(b: Builder, anchor: string, title: string, list: Claim[] | undefined, numbered = false) {
  if (!list?.length) return;
  b.heading(anchor, title);
  list.forEach((c, i) => b.say(anchor, claimText(c, numbered ? i + 1 : undefined)));
}

const uncertain = (list: string[]) => list.filter((u) => !isStandingLimitationText(u));

/** An explained step. Instruction-style steps lead with the goal and the steps; the story is left for reading. */
export function narrateStep(s: Step): Segment[] {
  const b = new Builder();
  const guide = (s.instructions?.length ?? 0) > 0;
  b.heading("title", s.title);
  b.say("summary", guide ? (s.goal ? `What you'll build: ${s.goal}` : "") : s.summary);
  if (guide) {
    claims(b, "prerequisites", "Before you start", s.prerequisites);
    claims(b, "instructions", "The steps", s.instructions, true);
    claims(b, "check", "Check it works", s.check);
    claims(b, "pitfalls", "If it goes wrong", s.pitfalls);
  } else {
    claims(b, "whatHappened", "What happened", s.whatHappened);
    claims(b, "whyItMattered", "Why it mattered", s.whyItMattered);
    claims(b, "howItWorks", "How it works", s.howItWorks);
    claims(b, "whatChanged", "What changed", s.whatChanged);
    claims(b, "decisions", "Decisions", s.decisions);
    claims(b, "verification", "Verification", s.verification);
  }
  narrateConcepts(b, "concepts", s.concepts.map((c) => ({ name: c.term, explanation: c.explanation })));
  narrateUncertainty(b, s.uncertainty);
  return b.segments;
}

function narrateConcepts(b: Builder, anchor: string, list: { name: string; explanation: string }[]) {
  if (!list.length) return;
  b.heading(anchor, "What you can learn here");
  for (const c of list) b.say(anchor, `${c.name}. ${c.explanation}`);
}
function narrateUncertainty(b: Builder, list: string[]) {
  const u = uncertain(list);
  if (!u.length) return;
  b.heading("uncertainty", "What is uncertain");
  for (const x of u) b.say("uncertainty", x);
}

export interface WikiContent {
  title: string;
  summary: string;
  sections: { heading: string; claims: Claim[] }[];
  uncertainty: string[];
  learn?: { concept: string; explanation: string }[];
}

/** A wiki page; its sections are numbered when it is the build-it-yourself tutorial. */
export function narrateWiki(s: WikiContent, numbered = false): Segment[] {
  const b = new Builder();
  b.heading("title", s.title);
  b.say("summary", s.summary);
  s.sections.forEach((sec, i) => claims(b, `section:${i}`, sec.heading, sec.claims, numbered));
  narrateUncertainty(b, s.uncertainty);
  narrateConcepts(b, "learn", (s.learn ?? []).map((c) => ({ name: c.concept, explanation: c.explanation })));
  return b.segments;
}

export interface CodeContent {
  path: string;
  fileDoc: { purpose: string; fitsIn: string[]; learn: { concept: string; explanation: string }[]; readingOrder: string[] } | null;
  symbols: { key: string; status: "current" | "changed" | "new"; doc: { summary: string; how: string[]; learn: { concept: string; explanation: string }[]; watch: string[] } | null }[];
}

/** A code page: the file's purpose, then each explained part in file order (parts changed since are skipped). */
export function narrateCode(p: CodeContent): Segment[] {
  const b = new Builder();
  const name = p.path.split("/").pop() ?? p.path;
  b.heading("title", name);
  if (p.fileDoc) {
    b.say("purpose", p.fileDoc.purpose);
    if (p.fileDoc.fitsIn.length) {
      b.heading("fits", "How it fits in");
      for (const x of p.fileDoc.fitsIn) b.say("fits", x);
    }
    narrateConcepts(b, "learn", p.fileDoc.learn.map((c) => ({ name: c.concept, explanation: c.explanation })));
  }
  const parts = p.symbols.filter((s) => s.doc && s.status !== "changed");
  if (parts.length) b.heading("inside", "Inside the file");
  for (const s of parts) {
    const d = s.doc!;
    const a = `sym:${s.key}`;
    b.say(a, `${s.key}. ${d.summary}`);
    d.how.forEach((x, i) => b.say(a, `${i + 1}. ${x}`));
    if (d.watch.length) b.say(a, `Watch out: ${d.watch.join(" ")}`);
    for (const c of d.learn) b.say(a, `${c.concept}. ${c.explanation}`);
  }
  return b.segments;
}
