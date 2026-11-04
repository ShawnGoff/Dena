import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { denaRoot, isBundled } from "@dena/core";

/**
 * Starting Dena and getting to its page without hunting for a link:
 * - a key that stays the same across restarts, so the link can be bookmarked;
 * - a note of the running server, so `dena open` and a second `dena serve` find it;
 * - a macOS login item that keeps Dena (and recording) running in the background.
 */

const REPO = denaRoot();

/**
 * The key the page's link carries. Kept in Dena's folder, readable only by you: other web pages in
 * your browser still cannot read it, which is what the key is for. `--new-key` replaces it.
 */
export function serverKey(home: string, opts: { renew?: boolean } = {}): string {
  const file = path.join(home, "server-key");
  if (!opts.renew) {
    try {
      const k = fs.readFileSync(file, "utf8").trim();
      if (/^[\w-]{32,}$/.test(k)) return k;
    } catch { /* first run */ }
  }
  const k = randomBytes(24).toString("base64url");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(file, `${k}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return k;
}

export interface ServerInfo { pid: number; port: number; url: string; startedAt: string }

const infoFile = (home: string) => path.join(home, "server.json");

export function writeServerInfo(home: string, info: ServerInfo): void {
  fs.writeFileSync(infoFile(home), JSON.stringify(info, null, 2), { mode: 0o600 });
}

/** Forgets the running server, if the note is this process's. */
export function clearServerInfo(home: string, pid = process.pid): void {
  try {
    const i = JSON.parse(fs.readFileSync(infoFile(home), "utf8")) as ServerInfo;
    if (i.pid === pid) fs.rmSync(infoFile(home), { force: true });
  } catch { /* nothing to clear */ }
}

/** The Dena server that is running now, if any: its process is alive and its page answers. */
export async function runningServer(home: string): Promise<ServerInfo | null> {
  let i: ServerInfo;
  try {
    i = JSON.parse(fs.readFileSync(infoFile(home), "utf8"));
  } catch {
    return null;
  }
  try {
    process.kill(i.pid, 0);
  } catch {
    return null; // it stopped without tidying up
  }
  try {
    const r = await fetch(`http://127.0.0.1:${i.port}/`, { signal: AbortSignal.timeout(2_000) });
    return r.ok ? i : null;
  } catch {
    return null;
  }
}

/** Opens a link in the default browser. */
export function openInBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
}

// ---- background service (macOS login item) ----

export const SERVICE_LABEL = "com.dena.server";
export const servicePlist = () => path.join(os.homedir(), "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Node by a path that survives upgrades: Homebrew installs each version under a versioned "Cellar"
 * folder that disappears on upgrade, and keeps a stable link to the current one under "opt".
 */
export function stableNode(execPath = process.execPath): string {
  const m = /^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/.exec(execPath);
  if (m) {
    const linked = `${m[1]}/opt/${m[2]}/bin/node`;
    if (fs.existsSync(linked)) return linked;
  }
  return execPath;
}

/** What the login item runs: this repo's Dena, with the same Node, Dena folder and port. */
export function servicePlan(home: string, port: number): { file: string; plist: string; command: string[]; log: string } {
  // From the source tree, tsx runs the TypeScript entry; from the installed package, the bundle runs directly.
  const entry = isBundled() ? [path.join(REPO, "packages", "cli", "dist", "dena.mjs")]
    : [path.join(REPO, "node_modules", "tsx", "dist", "cli.mjs"), path.join(REPO, "packages", "cli", "src", "index.ts")];
  const command = [stableNode(), ...entry, "serve", "--port", String(port)];
  const log = path.join(home, "logs", "server.log");
  const env: Record<string, string> = {
    // Login items start with almost no PATH; these are where Node, git and Claude Code usually live.
    PATH: [path.dirname(stableNode()), "/opt/homebrew/bin", "/usr/local/bin", path.join(os.homedir(), ".local", "bin"), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
    HOME: os.homedir(),
    DENA_HOME: home,
    ...(process.env.DENA_CLAUDE_BIN ? { DENA_CLAUDE_BIN: process.env.DENA_CLAUDE_BIN } : {}),
  };
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${command.map((a) => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key><string>${xml(REPO)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env).map(([k, v]) => `    <key>${k}</key><string>${xml(v)}</string>`).join("\n")}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
  return { file: servicePlist(), plist, command, log };
}

const uid = () => (process.getuid ? process.getuid() : 0);

export function serviceStatus(): { installed: boolean; loaded: boolean } {
  const installed = fs.existsSync(servicePlist());
  const r = spawnSync("launchctl", ["print", `gui/${uid()}/${SERVICE_LABEL}`], { encoding: "utf8" });
  return { installed, loaded: r.status === 0 };
}

export function installService(home: string, port: number): void {
  if (process.platform !== "darwin") throw new Error("The login item is for macOS. On other systems, run `dena serve` from your own startup scripts.");
  const plan = servicePlan(home, port);
  fs.mkdirSync(path.dirname(plan.file), { recursive: true });
  fs.mkdirSync(path.dirname(plan.log), { recursive: true });
  if (serviceStatus().loaded) spawnSync("launchctl", ["bootout", `gui/${uid()}/${SERVICE_LABEL}`]);
  fs.writeFileSync(plan.file, plan.plist);
  const r = spawnSync("launchctl", ["bootstrap", `gui/${uid()}`, plan.file], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`launchctl could not start it: ${(r.stderr || r.stdout).trim()}`);
}

export function uninstallService(): boolean {
  const had = fs.existsSync(servicePlist());
  spawnSync("launchctl", ["bootout", `gui/${uid()}/${SERVICE_LABEL}`]);
  fs.rmSync(servicePlist(), { force: true });
  return had;
}
