import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where Dena's files live: the repo in development, or the installed package when it runs from
 * the bundle (packages/cli/dist/dena.mjs). Both use the same folder layout, so we find the root by
 * looking up from the running file for the hook script, instead of counting "../" from each
 * module's own location (which differs between source and bundle).
 */
const MARKER = path.join("packages", "hook", "dena-hook.mjs");

export function denaRoot(fromUrl: string = import.meta.url): string {
  let dir = path.dirname(fileURLToPath(fromUrl));
  for (;;) {
    if (fs.existsSync(path.join(dir, MARKER))) return dir;
    const up = path.dirname(dir);
    if (up === dir) throw new Error("Dena's files were not found next to this program");
    dir = up;
  }
}

/** True when running the bundled package rather than the TypeScript sources. */
export function isBundled(fromUrl: string = import.meta.url): boolean {
  return !fs.existsSync(path.join(denaRoot(fromUrl), "packages", "cli", "src", "index.ts"));
}
