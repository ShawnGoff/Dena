#!/usr/bin/env node
// Builds the installable `dena` package into build/npm/. The package keeps the repo's folder layout
// (packages/hook, apps/web/dist, packages/cli/dist), so Dena finds its files the same way in both.
// Usage: npm run build:npm   then   cd build/npm && npm pack   (publishing is a separate, deliberate step)
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "build", "npm");
const rel = (...p) => path.join(root, ...p);

fs.rmSync(out, { recursive: true, force: true });

// 1. The web UI, built by Vite the same way as in development.
execFileSync("npm", ["run", "build:web"], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });

// 2. The CLI and server as one ESM file. Native and large runtime packages stay external and are
//    listed as dependencies: better-sqlite3 (native addon) and typescript (reads its own lib files).
await build({
  entryPoints: [rel("packages", "cli", "src", "index.ts")],
  outfile: path.join(out, "packages", "cli", "dist", "dena.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["better-sqlite3", "typescript"],
  banner: { js: 'import { createRequire as __dena_createRequire } from "node:module"; const require = __dena_createRequire(import.meta.url);' },
  logLevel: "warning",
});

// 3. Files Dena reads at runtime, in the same places as in the repo.
fs.cpSync(rel("apps", "web", "dist"), path.join(out, "apps", "web", "dist"), { recursive: true });
fs.mkdirSync(path.join(out, "packages", "hook"), { recursive: true });
fs.copyFileSync(rel("packages", "hook", "dena-hook.mjs"), path.join(out, "packages", "hook", "dena-hook.mjs"));

// 4. The command: a thin launcher around the bundle (the repo's bin uses tsx, which is not shipped).
const binDir = path.join(out, "packages", "cli", "bin");
fs.mkdirSync(binDir, { recursive: true });
const bin = path.join(binDir, "dena.mjs");
fs.writeFileSync(bin, '#!/usr/bin/env node\nimport "../dist/dena.mjs";\n');
fs.chmodSync(bin, 0o755);

// 5. Package metadata. Versions of the external dependencies come from the lockfile.
const rootPkg = JSON.parse(fs.readFileSync(rel("package.json"), "utf8"));
const depVersion = (name) => JSON.parse(fs.readFileSync(rel("node_modules", name, "package.json"), "utf8")).version;
const pkg = {
  // "dena" on npm is taken (an unrelated scheduler), so the package is "dena-guide"; its command is still `dena`.
  name: process.env.DENA_PACKAGE_NAME ?? "dena-guide",
  version: process.env.DENA_VERSION ?? "0.1.0",
  description: "Turns your Claude Code activity into a readable, evidence-linked guide to what was built and how.",
  license: rootPkg.license,
  author: "Shawn Goff",
  homepage: "https://github.com/ShawnGoff/Dena#readme",
  repository: { type: "git", url: "git+https://github.com/ShawnGoff/Dena.git" },
  bugs: { url: "https://github.com/ShawnGoff/Dena/issues" },
  type: "module",
  bin: { dena: "packages/cli/bin/dena.mjs" },
  engines: { node: ">=22" },
  files: ["packages", "apps/web/dist", "README.md", "LICENSE", "CHANGELOG.md", "SECURITY.md"],
  dependencies: {
    "better-sqlite3": `^${depVersion("better-sqlite3")}`,
    typescript: `^${depVersion("typescript")}`,
  },
  keywords: ["claude-code", "documentation", "guide", "learning"],
};
fs.writeFileSync(path.join(out, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
fs.copyFileSync(rel("README.md"), path.join(out, "README.md"));
fs.copyFileSync(rel("LICENSE"), path.join(out, "LICENSE"));
for (const f of ["CHANGELOG.md", "SECURITY.md"]) fs.copyFileSync(rel(f), path.join(out, f));

console.log(`built ${path.relative(root, out)} (${pkg.name}@${pkg.version})`);
