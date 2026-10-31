#!/usr/bin/env node
// The `dena` command. Dena is TypeScript run with tsx, so this starts tsx on the command-line
// source, in the folder you ran it from (paths you give, like `dena init .`, mean what you expect).
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const child = spawn(process.execPath, [path.join(repo, "node_modules", "tsx", "dist", "cli.mjs"), path.join(repo, "packages", "cli", "src", "index.ts"), ...process.argv.slice(2)],
  { stdio: "inherit" });
// Ctrl-C reaches Dena directly (same terminal); other stop signals are passed on so it can stop cleanly.
process.on("SIGINT", () => {});
for (const sig of ["SIGTERM", "SIGHUP"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
