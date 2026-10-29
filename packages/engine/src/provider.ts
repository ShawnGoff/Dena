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
}

export interface Provider {
  readonly name: string;
  /**
   * `opts.model`: any model name or alias the backend accepts; omitted = the backend's default.
   * `opts.signal`: aborting it stops the call; the promise then rejects with a StoppedError.
   */
  generate(system: string, user: string, schema: object, opts?: { model?: string; signal?: AbortSignal }): Promise<GenerateResult>;
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

export class ClaudeCodeProvider implements Provider {
  readonly name: string;
  constructor(
    private readonly bin = findClaudeBinary(),
    private readonly opts: { model?: string; timeoutMs?: number; auth?: ClaudeAuth; effort?: string } = {},
  ) {
    this.name = `claude-code (${(opts.auth ?? "account") === "account" ? "your Claude account" : "API key"})`;
    if (!this.bin) throw new Error("Could not find Claude Code. Install it, or set DENA_CLAUDE_BIN to its path.");
  }

  generate(system: string, user: string, schema: object, callOpts: { model?: string; signal?: AbortSignal } = {}): Promise<GenerateResult> {
    if (callOpts.signal?.aborted) return Promise.reject(new StoppedError());
    const model = callOpts.model ?? this.opts.model;
    const args = [
      "-p", "--output-format", "json", "--json-schema", JSON.stringify(schema),
      "--system-prompt", system,
      "--tools", "", // the model explains the evidence it is given; it cannot read files or run anything
      "--no-session-persistence", // Dena's own calls never become transcripts
      "--strict-mcp-config", "--disable-slash-commands",
      ...(model ? ["--model", model] : []), // default: the user's configured model
      ...(this.opts.effort ? ["--effort", this.opts.effort] : []), // how much hidden reasoning the model may spend
    ];
    // A neutral working directory keeps project-level hooks and settings out of the call.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dena-gen-"));
    return new Promise((resolve, reject) => {
      const auth = this.opts.auth ?? "account";
      const child = spawn(this.bin!, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: childEnv(auth) });
      let out = "", err = "";
      const timer = setTimeout(() => child.kill("SIGTERM"), this.opts.timeoutMs ?? 300_000);
      let stopped = false;
      const onAbort = () => {
        stopped = true;
        child.kill("SIGTERM"); // ends the model call; tokens already spent by it are not reported
      };
      callOpts.signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        callOpts.signal?.removeEventListener("abort", onAbort);
        fs.rmSync(cwd, { recursive: true, force: true });
        if (stopped) return reject(new StoppedError());
        let o: any;
        try {
          o = JSON.parse(out);
        } catch {
          return reject(new Error(explainFailure(err || out || `exit ${code}`, this.opts.auth ?? "account")));
        }
        if (o.is_error || o.subtype !== "success") return reject(new Error(explainFailure(String(o.result ?? o.subtype ?? ""), auth)));
        let json = o.structured_output;
        if (json === undefined) {
          try {
            json = JSON.parse(o.result);
          } catch {
            return reject(new Error("Claude Code did not return structured output"));
          }
        }
        resolve({ json, model: Object.keys(o.modelUsage ?? {})[0] ?? null, costUsd: o.total_cost_usd ?? null, durationMs: o.duration_ms ?? 0,
          tokens: tokensFromUsage(o.usage) });
      });
      child.stdin.end(user);
    });
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
