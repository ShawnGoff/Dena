import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Model providers. The default runs the user's own Claude Code in headless mode, so Dena uses
 * whatever model and sign-in the user already has and needs no API key of its own.
 */

/** Tokens one call actually used. `prompt` is everything sent: fresh input plus cache reads and writes. */
export interface TokenUsage {
  prompt: number;
  output: number;
  cacheRead: number;
  /** Part of `output` spent on hidden reasoning, when reported. */
  thinking?: number;
}

export const NO_TOKENS: TokenUsage = { prompt: 0, output: 0, cacheRead: 0 };
export const addTokens = (a: TokenUsage, b?: TokenUsage | null): TokenUsage =>
  b ? { prompt: a.prompt + b.prompt, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, thinking: (a.thinking ?? 0) + (b.thinking ?? 0) } : a;

/** Reads Claude Code's `usage` block. */
export function tokensFromUsage(u: any): TokenUsage | null {
  if (!u || typeof u !== "object") return null;
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
  const prompt = n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens);
  return { prompt, output: n(u.output_tokens), cacheRead: n(u.cache_read_input_tokens), thinking: n(u.output_tokens_details?.thinking_tokens) };
}

export interface GenerateResult {
  json: unknown;
  model: string | null;
  costUsd: number | null;
  durationMs: number;
  /** Real token counts, when the backend reports them. */
  tokens?: TokenUsage | null;
  /** Model calls made to get this answer (a retry or the fallback adds one each). */
  calls?: number;
}

export interface Provider {
  readonly name: string;
  /**
   * `opts.model`: any model name or alias the backend accepts; omitted = the backend's default.
   * `opts.signal`: aborting it stops the call; the promise then rejects with a StoppedError.
   * `opts.effort`: how much hidden reasoning this call may spend, when the backend supports it.
   */
  generate(system: string, user: string, schema: object, opts?: { model?: string; signal?: AbortSignal; effort?: string }): Promise<GenerateResult>;
}

/** Raised when the owner stops a generation. Nothing from the stopped call is saved. */
export class StoppedError extends Error {
  constructor() {
    super("Stopped. Nothing was saved.");
    this.name = "StoppedError";
  }
}

/** Finds a Claude Code binary: $DENA_CLAUDE_BIN, `claude` on PATH, or the desktop app's bundled CLI (newest). */
export function findClaudeBinary(): string | null {
  if (process.env.DENA_CLAUDE_BIN && fs.existsSync(process.env.DENA_CLAUDE_BIN)) return process.env.DENA_CLAUDE_BIN;
  const which = spawnSync("which", ["claude"], { encoding: "utf8" });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  const base = path.join(os.homedir(), "Library", "Application Support", "Claude", "claude-code");
  if (!fs.existsSync(base)) return null;
  const versions = fs.readdirSync(base).filter((v) => /^\d+\.\d+\.\d+$/.test(v))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const v of versions)
    for (const h of fs.readdirSync(path.join(base, v))) {
      const bin = path.join(base, v, h, "claude.app", "Contents", "MacOS", "claude");
      if (fs.existsSync(bin)) return bin;
    }
  return null;
}

/**
 * How Dena signs in to Claude Code:
 * - "account": your Claude account (subscription) sign-in. API keys in the environment are
 *   blanked so they cannot silently take over and bill API credits. This is the default.
 * - "api-key": whatever API key the environment provides, billed to API credits.
 */
export type ClaudeAuth = "account" | "api-key";

/** Variables that select Claude Code's credentials, or belong to the session Dena was started from. */
const AUTH_VARS = /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_USE_VERTEX)$/;
const SESSION_VARS = /^(CLAUDE_CODE_|CLAUDECODE$)/;

export function childEnv(auth: ClaudeAuth, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (SESSION_VARS.test(k) && !(auth === "api-key" && AUTH_VARS.test(k))) continue; // never inherit another Claude session's internals
    if (auth === "account" && AUTH_VARS.test(k)) continue;
    out[k] = v;
  }
  // Claude Code can also pick up a key from the user's shell profile; an empty value overrides that.
  if (auth === "account") out.ANTHROPIC_API_KEY = "";
  return out;
}

/** Turns Claude Code's sign-in and billing failures into messages a user can act on. */
export function explainFailure(result: string, auth: ClaudeAuth): string {
  if (/credit balance is too low/i.test(result))
    return auth === "api-key"
      ? "Your Anthropic API credit balance is too low. Add credits, or switch Dena to your Claude account sign-in."
      : "Claude Code is using an API account with no credits left. Sign in to Claude Code with your Claude account instead.";
  if (/not logged in|please run \/login|invalid api key|authentication/i.test(result))
    return auth === "account"
      ? "Claude Code is not signed in to your Claude account. Sign in once (run `claude auth login` and choose your Claude account), then try again."
      : "No valid API key was found for Claude Code.";
  if (/usage limit|rate limit|overloaded/i.test(result)) return `Claude is unavailable right now: ${result.slice(0, 160)}`;
  return `Claude Code error: ${result.slice(0, 200)}`;
}

/**
 * How answers come back:
 * - "text" (default): the model answers in one turn with plain JSON, which Dena checks against the
 *   schema itself. Measured on a real step: about a third of the tokens sent and a quarter of the
 *   tokens written, compared with "tool".
 * - "tool": Claude Code's structured output. It guarantees the shape, but takes two turns: the
 *   second re-sends the whole prompt and the model's own answer. Used as the last resort.
 */
export type AnswerMode = "text" | "tool";

interface CallResult { text: string; json: unknown; model: string | null; costUsd: number | null; durationMs: number; tokens: TokenUsage | null }

export class ClaudeCodeProvider implements Provider {
  readonly name: string;
  constructor(
    private readonly bin = findClaudeBinary(),
    private readonly opts: { model?: string; timeoutMs?: number; auth?: ClaudeAuth; effort?: string; answers?: AnswerMode } = {},
  ) {
    this.name = `claude-code (${(opts.auth ?? "account") === "account" ? "your Claude account" : "API key"})`;
    if (!this.bin) throw new Error("Could not find Claude Code. Install it, or set DENA_CLAUDE_BIN to its path.");
  }

  async generate(system: string, user: string, schema: object, callOpts: { model?: string; signal?: AbortSignal; effort?: string } = {}): Promise<GenerateResult> {
    if ((this.opts.answers ?? "text") === "tool") return finish([await this.call(system, user, schema, callOpts)]);
    const sys = `${system}\n\n${jsonAnswerInstructions(schema)}`;
    const calls: CallResult[] = [];
    let ask = user;
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await this.call(sys, ask, null, callOpts);
      calls.push(r);
      const parsed = parseJsonAnswer(r.text);
      const problems = parsed.ok ? checkAgainstSchema(parsed.value, schema) : [parsed.error];
      if (!problems.length) return finish(calls, parsed.ok ? parsed.value : undefined);
      // One retry, saying exactly what was wrong. The prompt is the same, so it is mostly read from cache.
      ask = `${user}\n\nYour previous answer could not be used: ${problems.slice(0, 8).join("; ")}. Answer again with only the JSON object.`;
    }
    calls.push(await this.call(system, user, schema, callOpts)); // last resort: the structured-output tool, which enforces the shape
    return finish(calls);
  }

  private call(system: string, user: string, schema: object | null, callOpts: { model?: string; signal?: AbortSignal; effort?: string }): Promise<CallResult> {
    if (callOpts.signal?.aborted) return Promise.reject(new StoppedError());
    const model = callOpts.model ?? this.opts.model;
    const args = [
      "-p", "--output-format", "json", ...(schema ? ["--json-schema", JSON.stringify(schema)] : []),
      "--system-prompt", system,
      "--tools", "", // the model explains the evidence it is given; it cannot read files or run anything
      "--no-session-persistence", // Dena's own calls never become transcripts
      "--strict-mcp-config", "--disable-slash-commands",
      ...(model ? ["--model", model] : []), // default: the user's configured model
      ...((callOpts.effort ?? this.opts.effort) ? ["--effort", (callOpts.effort ?? this.opts.effort)!] : []), // how much hidden reasoning the model may spend
    ];
    // A neutral working directory keeps project-level hooks and settings out of the call.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dena-gen-"));
    return new Promise((resolve, reject) => {
      const auth = this.opts.auth ?? "account";
      // Its own process group, so Stop and the timeout end everything it started, not just the top process.
      const child = spawn(this.bin!, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: childEnv(auth), detached: true });
      const killAll = () => {
        try {
          if (child.pid) process.kill(-child.pid, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
      };
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };
      let out = "", err = "";
      const timer = setTimeout(killAll, this.opts.timeoutMs ?? 300_000);
      const onAbort = () => {
        killAll(); // ends the model call; tokens already spent by it are not reported
        clearTimeout(timer);
        fs.rmSync(cwd, { recursive: true, force: true });
        finish(() => reject(new StoppedError())); // report at once rather than wait for output to close
      };
      callOpts.signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("error", (e) => finish(() => reject(e)));
      child.on("close", (code) => {
        clearTimeout(timer);
        callOpts.signal?.removeEventListener("abort", onAbort);
        fs.rmSync(cwd, { recursive: true, force: true });
        if (settled) return;
        settled = true;
        let o: any;
        try {
          o = JSON.parse(out);
        } catch {
          return reject(new Error(explainFailure(err || out || `exit ${code}`, this.opts.auth ?? "account")));
        }
        if (o.is_error || o.subtype !== "success") return reject(new Error(explainFailure(String(o.result ?? o.subtype ?? ""), auth)));
        let json = o.structured_output;
        if (schema && json === undefined) {
          try {
            json = JSON.parse(o.result);
          } catch {
            return reject(new Error("Claude Code did not return structured output"));
          }
        }
        resolve({ text: String(o.result ?? ""), json, model: Object.keys(o.modelUsage ?? {})[0] ?? null, costUsd: o.total_cost_usd ?? null, durationMs: o.duration_ms ?? 0,
          tokens: tokensFromUsage(o.usage) });
      });
      child.stdin.end(user);
    });
  }
}

/** One result from several calls: the last answer, with every call's tokens, cost and time added up. */
function finish(calls: CallResult[], json?: unknown): GenerateResult {
  const last = calls[calls.length - 1]!;
  const tokens = calls.every((c) => c.tokens) ? calls.slice(1).reduce((t, c) => addTokens(t, c.tokens), calls[0]!.tokens!) : null;
  const cost = calls.some((c) => c.costUsd != null) ? calls.reduce((n, c) => n + (c.costUsd ?? 0), 0) : null;
  return { json: json ?? last.json, model: last.model, costUsd: cost, durationMs: calls.reduce((n, c) => n + c.durationMs, 0), tokens, calls: calls.length };
}

// ---- plain JSON answers ----

/** The answer format, told compactly (a JSON Schema costs several times the tokens to say the same). */
export function jsonAnswerInstructions(schema: object): string {
  return `Answer with ONLY one JSON object: no prose before or after it, and no code fence. Its shape (TypeScript notation; every field is required):\n${describeSchema(schema)}`;
}

export function describeSchema(s: any, indent = ""): string {
  if (!s || typeof s !== "object") return "unknown";
  if (Array.isArray(s.enum)) return s.enum.map((v: unknown) => JSON.stringify(v)).join(" | ");
  const note = s.description ? ` /* ${s.description} */` : s.pattern ? ` /* matching ${s.pattern} */` : "";
  if (s.type === "string") return `string${note}`;
  if (s.type === "number" || s.type === "integer") return `number${note}`;
  if (s.type === "boolean") return "boolean";
  if (s.type === "array") return `${wrapUnion(describeSchema(s.items, indent))}[]`;
  if (s.type === "object") {
    const inner = `${indent}  `;
    const fields = Object.entries(s.properties ?? {}).map(([k, v]) => `${inner}${k}: ${describeSchema(v, inner)}`);
    return `{\n${fields.join(",\n")}\n${indent}}`;
  }
  return "unknown";
}
const wrapUnion = (t: string) => (t.includes(" | ") ? `(${t})` : t);

/** Reads the JSON object out of an answer, tolerating a code fence or a stray sentence around it. */
export function parseJsonAnswer(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  const start = t.indexOf("{"), end = t.lastIndexOf("}");
  if (start < 0 || end <= start) return { ok: false, error: "it contained no JSON object" };
  try {
    return { ok: true, value: JSON.parse(t.slice(start, end + 1)) };
  } catch (e) {
    return { ok: false, error: `it was not valid JSON (${(e as Error).message.slice(0, 80)})` };
  }
}

/** Checks a value against the parts of JSON Schema Dena uses: types, required fields, enums and patterns. */
export function checkAgainstSchema(v: unknown, s: any, at = "answer"): string[] {
  if (!s || typeof s !== "object") return [];
  if (Array.isArray(s.enum)) return s.enum.includes(v) ? [] : [`${at} must be one of ${s.enum.map((x: unknown) => JSON.stringify(x)).join(", ")}`];
  switch (s.type) {
    case "string":
      if (typeof v !== "string") return [`${at} must be a string`];
      return s.pattern && !new RegExp(s.pattern).test(v) ? [`${at} must match ${s.pattern}`] : [];
    case "number":
    case "integer":
      return typeof v === "number" ? [] : [`${at} must be a number`];
    case "boolean":
      return typeof v === "boolean" ? [] : [`${at} must be true or false`];
    case "array":
      if (!Array.isArray(v)) return [`${at} must be an array`];
      return v.flatMap((x, i) => checkAgainstSchema(x, s.items, `${at}[${i}]`));
    case "object": {
      if (!v || typeof v !== "object" || Array.isArray(v)) return [`${at} must be an object`];
      const o = v as Record<string, unknown>;
      const missing = ((s.required ?? []) as string[]).filter((k) => !(k in o)).map((k) => `${at}.${k} is missing`);
      return [...missing, ...Object.entries(s.properties ?? {}).flatMap(([k, ps]) => (k in o ? checkAgainstSchema(o[k], ps, `${at}.${k}`) : []))];
    }
    default:
      return [];
  }
}

export interface AuthStatus {
  found: boolean;
  loggedIn: boolean;
  method: string | null; // e.g. "claude.ai" (account) or "api_key"
  detail: string;
}

/** What Claude Code would sign in with when Dena launches it, checked with Dena's exact environment. */
export function claudeAuthStatus(auth: ClaudeAuth, bin = findClaudeBinary()): AuthStatus {
  if (!bin) return { found: false, loggedIn: false, method: null, detail: "Claude Code was not found on this computer." };
  const r = spawnSync(bin, ["auth", "status"], { encoding: "utf8", env: childEnv(auth), timeout: 20_000, cwd: os.tmpdir() });
  try {
    const o = JSON.parse(r.stdout);
    const method = o.authMethod ?? null;
    const loggedIn = !!o.loggedIn && method !== "none";
    const detail = !loggedIn
      ? auth === "account" ? "Not signed in to a Claude account. Run `claude auth login` and choose your Claude account." : "No API key available."
      : method === "api_key" ? "Using an API key: calls are billed to API credits." : "Signed in with your Claude account: calls use your plan's usage.";
    return { found: true, loggedIn, method, detail };
  } catch {
    return { found: true, loggedIn: false, method: null, detail: "Could not read Claude Code's sign-in status." };
  }
}
