import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Model providers. The default runs the user's own Claude Code in headless mode, so Dena uses
 * whatever model and sign-in the user already has and needs no API key of its own.
 */

export interface GenerateResult {
  json: unknown;
  model: string | null;
  costUsd: number | null;
  durationMs: number;
}

export interface Provider {
  readonly name: string;
  /** `opts.model`: any model name or alias the backend accepts; omitted = the backend's default. */
  generate(system: string, user: string, schema: object, opts?: { model?: string }): Promise<GenerateResult>;
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

export class ClaudeCodeProvider implements Provider {
  readonly name = "claude-code (your model)";
  constructor(
    private readonly bin = findClaudeBinary(),
    private readonly opts: { model?: string; timeoutMs?: number } = {},
  ) {
    if (!this.bin) throw new Error("Could not find Claude Code. Install it, or set DENA_CLAUDE_BIN to its path.");
  }

  generate(system: string, user: string, schema: object, callOpts: { model?: string } = {}): Promise<GenerateResult> {
    const model = callOpts.model ?? this.opts.model;
    const args = [
      "-p", "--output-format", "json", "--json-schema", JSON.stringify(schema),
      "--system-prompt", system,
      "--tools", "", // the model explains the evidence it is given; it cannot read files or run anything
      "--no-session-persistence", // Dena's own calls never become transcripts
      "--strict-mcp-config", "--disable-slash-commands",
      ...(model ? ["--model", model] : []), // default: the user's configured model
    ];
    // A neutral working directory keeps project-level hooks and settings out of the call.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dena-gen-"));
    return new Promise((resolve, reject) => {
      const child = spawn(this.bin!, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
      let out = "", err = "";
      const timer = setTimeout(() => child.kill("SIGTERM"), this.opts.timeoutMs ?? 300_000);
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        fs.rmSync(cwd, { recursive: true, force: true });
        let o: any;
        try {
          o = JSON.parse(out);
        } catch {
          return reject(new Error(`Claude Code returned no JSON (exit ${code}): ${(err || out).slice(0, 300)}`));
        }
        if (o.is_error || o.subtype !== "success") return reject(new Error(`Claude Code error: ${o.subtype ?? ""} ${String(o.result ?? "").slice(0, 300)}`));
        let json = o.structured_output;
        if (json === undefined) {
          try {
            json = JSON.parse(o.result);
          } catch {
            return reject(new Error("Claude Code did not return structured output"));
          }
        }
        resolve({ json, model: Object.keys(o.modelUsage ?? {})[0] ?? null, costUsd: o.total_cost_usd ?? null, durationMs: o.duration_ms ?? 0 });
      });
      child.stdin.end(user);
    });
  }
}
