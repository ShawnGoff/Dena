import type { Store } from "@dena/core";

/**
 * Token estimates calibrated on this user's own calls.
 *
 * Each recorded call gives (characters sent, calls made, prompt tokens reported). Prompt tokens
 * are modelled as a fixed overhead per call (Claude Code's own wrapping, the output schema)
 * plus characters divided by characters-per-token. Both are fitted by least squares on the
 * user's history for that model; with too little history, defaults are used and labelled so.
 */

/** Before calibration. Overhead: a 30-character call reported ~780 tokens (Claude Code 2.1.309), plus the output schema. */
export const DEFAULT_OVERHEAD_TOKENS = 2_000;
export const DEFAULT_CHARS_PER_TOKEN = 3.3; // evidence is mostly code, diffs and paths, which tokenize denser than prose
export const DEFAULT_OUTPUT_TOKENS = { thorough: 6_000, concise: 3_500, wiki: 6_500, code: 4_000 } as const; // includes hidden reasoning, which models report as output
export const DEFAULT_CALLS_PER_DOC = 1.5; // checks often ask for one repair
const MIN_SAMPLES = 3;

export interface Calibration {
  overheadTokens: number;
  charsPerToken: number;
  outputTokens: { thorough: number; concise: number; wiki: number; code: number };
  /** Average model calls per document (1 = never repaired, 2 = always repaired), learned from history. */
  callsPerDoc: number;
  samples: number;
  calibrated: boolean;
  basis: string;
}

interface Sample { chars: number; calls: number; prompt: number; output: number; kind: "thorough" | "concise" | "wiki" | "code" }

function samples(store: Store, model: string): Sample[] {
  const match = "(requested_model = @m OR model = @m)";
  const steps = store.db
    .prepare(`SELECT input_chars c, attempts a, prompt_tokens p, output_tokens o, depth d FROM explanation
              WHERE generated_by = 'model' AND batched = 0 AND prompt_tokens > 0 AND input_chars > 0 AND ${match}`)
    .all({ m: model }) as { c: number; a: number; p: number; o: number; d: string }[];
  const wiki = store.db
    .prepare(`SELECT input_chars c, attempts a, prompt_tokens p, output_tokens o FROM wiki_section WHERE prompt_tokens > 0 AND input_chars > 0 AND ${match}`)
    .all({ m: model }) as { c: number; a: number; p: number; o: number }[];
  const code = store.db
    .prepare(`SELECT input_chars c, attempts a, prompt_tokens p, output_tokens o FROM code_call WHERE prompt_tokens > 0 AND input_chars > 0 AND ${match}`)
    .all({ m: model }) as { c: number; a: number; p: number; o: number }[];
  return [
    ...steps.map((r) => ({ chars: r.c, calls: r.a, prompt: r.p, output: r.o, kind: (r.d === "concise" ? "concise" : "thorough") as Sample["kind"] })),
    ...wiki.map((r) => ({ chars: r.c, calls: r.a, prompt: r.p, output: r.o, kind: "wiki" as const })),
    ...code.map((r) => ({ chars: r.c, calls: r.a, prompt: r.p, output: r.o, kind: "code" as const })),
  ];
}

export function calibrate(store: Store, model: string): Calibration {
  const s = samples(store, model);
  const label = model || "your default model";
  const avgOut = (k: Sample["kind"]) => {
    const xs = s.filter((x) => x.kind === k);
    return xs.length ? Math.round(xs.reduce((n, x) => n + x.output / x.calls, 0) / xs.length) : DEFAULT_OUTPUT_TOKENS[k];
  };
  const outputTokens = { thorough: avgOut("thorough"), concise: avgOut("concise"), wiki: avgOut("wiki"), code: avgOut("code") };
  // Repairs re-send the evidence, so the repair rate matters as much as the size of one call.
  const callsPerDoc = s.length ? Math.round((s.reduce((n, x) => n + x.calls, 0) / s.length) * 100) / 100 : DEFAULT_CALLS_PER_DOC;
  if (s.length < MIN_SAMPLES)
    return { overheadTokens: DEFAULT_OVERHEAD_TOKENS, charsPerToken: DEFAULT_CHARS_PER_TOKEN, outputTokens, callsPerDoc: DEFAULT_CALLS_PER_DOC, samples: s.length, calibrated: false,
      basis: `typical values; ${s.length} of ${MIN_SAMPLES} recorded calls with ${label} needed to calibrate` };

  // Least squares for prompt = a·calls + b·chars (no intercept): solve the 2×2 normal equations.
  let s11 = 0, s12 = 0, s22 = 0, t1 = 0, t2 = 0;
  for (const x of s) {
    s11 += x.calls * x.calls; s12 += x.calls * x.chars; s22 += x.chars * x.chars;
    t1 += x.calls * x.prompt; t2 += x.chars * x.prompt;
  }
  const det = s11 * s22 - s12 * s12;
  let a = det ? (t1 * s22 - t2 * s12) / det : NaN;
  let b = det ? (s11 * t2 - s12 * t1) / det : NaN;
  if (!(a >= 0 && a < 20_000 && b > 0.05 && b < 1)) {
    // Too little spread in call sizes to separate the two parts: keep the default overhead, fit the ratio only.
    a = DEFAULT_OVERHEAD_TOKENS;
    const rest = s.reduce((n, x) => n + Math.max(1, x.prompt - a * x.calls), 0);
    b = rest / s.reduce((n, x) => n + x.chars, 0);
  }
  return { overheadTokens: Math.round(a), charsPerToken: Math.round((1 / b) * 100) / 100, outputTokens, callsPerDoc, samples: s.length, calibrated: true,
    basis: `calibrated on ${s.length} of your calls with ${label}, including ${Math.round((callsPerDoc - 1) * 100)}% repair calls` };
}

export interface TokenEstimate {
  /** Expected values, at this user's repair rate. */
  promptTokens: number;
  outputTokens: number;
  /** Total tokens if no document needs a repair call, and if every one does. */
  low: number;
  high: number;
  calibrated: boolean;
  basis: string;
}

/**
 * Tokens for writing `docs` documents whose first calls send `chars` characters in total.
 * Expected repair calls are included at this user's own repair rate. `outputPerCall` replaces the
 * learned output size when the caller knows better (a call explaining one function writes little).
 */
export function estimateTokens(store: Store, model: string, chars: number, docs: number, kind: Sample["kind"], outputPerCall?: number): TokenEstimate {
  const c = calibrate(store, model);
  const at = (perDoc: number) => ({
    prompt: docs * perDoc * c.overheadTokens + (chars / c.charsPerToken) * perDoc,
    output: docs * perDoc * (outputPerCall ?? c.outputTokens[kind]),
  });
  const exp = at(c.callsPerDoc), lo = at(1), hi = at(2);
  return {
    promptTokens: Math.round(exp.prompt),
    outputTokens: Math.round(exp.output),
    low: Math.round(lo.prompt + lo.output),
    high: Math.round(hi.prompt + hi.output),
    calibrated: c.calibrated,
    basis: c.basis,
  };
}

/** "about 12–25k tokens" */
export function formatTokenRange(e: Pick<TokenEstimate, "low" | "high">): string {
  return `about ${formatTokens(e.low).replace(/k$/, "")}–${formatTokens(e.high)} tokens`;
}

export function formatTokens(n: number): string {
  return n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1_000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
