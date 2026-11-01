#!/usr/bin/env node
// Copies the hook script into the plugin folder. The plugin is installed as a copy, so it cannot
// reach into packages/; packages/hook/test keeps this copy identical to the source.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const from = path.join(root, "packages/hook/dena-hook.mjs");
const to = path.join(root, "plugins/dena/hooks/dena-hook.mjs");
fs.copyFileSync(from, to);
console.log(`copied ${path.relative(root, from)} -> ${path.relative(root, to)}`);
