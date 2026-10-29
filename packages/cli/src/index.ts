#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { correlate, Store, type StoredEvent } from "@dena/core";
import { claudeCode, git, hookInstall, hooks, importGitIfChanged, Recorder, transcriptFiles } from "@dena/adapters";
import { buildPacket, ClaudeCodeProvider, estimate, explainEpisode, explainMany, loadEpisodes, rebuildEpisodes, renderPacket, renderStep, type Depth } from "@dena/engine";
import fs from "node:fs";
import { startServer } from "@dena/server";

const HOME = process.env.DENA_HOME ?? path.join(os.homedir(), ".dena");
const [cmd, ...args] = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const USAGE = `dena <command>
  init <dir> [--name N]          register a project folder
  projects                       list projects
  record <project> [--scope own|all]
                                 capture files, git and Claude Code until Ctrl-C
  pause <project> / resume <project>
                                 pause or resume a running recorder
  import-claude <project> [--scope own|all] [--file F]
                                 import Claude Code transcripts (default scope: all folders,
                                 keeping only activity that points at this project)
  import-git <project>           import commits and branch switches
  correlate <project>            link related events across sources
  exclude <project> <pattern>    add an excluded path (e.g. "generated/", "*.csv")
  gaps <project>                 known holes in what was captured
  hooks status|install|uninstall <project> [--scope project|user] [--yes]
                                 live Claude Code capture; shows the change first, writes only with --yes
  ingest-hooks <project>         process hook calls collected while not recording
  episodes <project>             group activity into episodes (rebuilt from events)
  packet <project> <episode>     show exactly what evidence would be sent to the model
  explain <project> <episode> [--force] [--model M] [--depth concise|thorough] [--out FILE]
                                 explain one episode (cached; episodes with no changes need no model)
                                 <episode> is a number from "episodes", an ep_ id, or "last"
  guide build <project> [--from N] [--to N] [--model M] [--depth D] [--max-usd X] [--yes]
                                 explain many episodes in as few calls as possible; shows an estimate first
  serve [--port N]               open Dena's interface in your browser (local only; the printed link carries a one-time key)
  config <project> [key value]   show or set: model (e.g. haiku, sonnet; "default" = your Claude Code default),
                                 depth (concise|thorough), max-usd (per batch run; "none" to clear)
  timeline <project> [--session S] [--all]
                                 activity grouped by prompt
  show <project> <eventId>       one event with its links and artifacts
  stats <project>                counts, actors, gaps
  delete <project>               delete a project and its stored history`;

function project(store: Store, ref: string | undefined) {
  const p = ref ? store.findProject(ref) : null;
  if (!p) throw new Error(`No project "${ref ?? ""}". Run: dena init <dir>`);
  return p;
}

const ICON: Record<string, string> = {
  prompt_submitted: "›", ai_response_received: "·", tool_invoked: "→", tool_completed: "✓",
  file_created: "+", file_modified: "~", file_deleted: "−", command_executed: "$", test_result: "▣",
  error_detected: "!", session_marker: "#", agent_note: "✎", git_commit: "◆", branch_changed: "⑂",
};

function printGroup(prompt: StoredEvent | null, children: StoredEvent[], all: boolean) {
  const head = prompt ? `${prompt.occurredAt.slice(0, 16).replace("T", " ")}  [${prompt.id}] › ${prompt.summary}` : "(activity before first prompt)";
  console.log(`\n${head}${prompt?.actor === "ai_agent" ? "  (subagent prompt)" : ""}`);
  const counts: Record<string, number> = {};
  for (const e of children) counts[e.eventType] = (counts[e.eventType] ?? 0) + 1;
  const parts = Object.entries(counts).map(([k, v]) => `${v} ${k.replace(/_/g, " ")}`);
  if (parts.length) console.log(`    ${parts.join(", ")}`);
  const notable = all
    ? children
    : children.filter((e) => ["file_created", "file_modified", "file_deleted", "test_result", "error_detected", "git_commit", "branch_changed", "agent_note"].includes(e.eventType)
        || (e.eventType === "command_executed" && (e.payload as any).status !== "ok"));
  for (const e of notable)
    console.log(`    ${ICON[e.eventType] ?? "?"} [${e.id}] ${e.summary}${e.captureConfidence !== "observed" ? `  (${e.captureConfidence})` : ""}`);
}

async function main() {
  if (!cmd || cmd === "help" || cmd === "--help") return console.log(USAGE);
  const store = new Store(HOME);
  try {
    switch (cmd) {
      case "init": {
        const dir = path.resolve(args[0] ?? ".");
        const p = store.createProject(flag("name") ?? path.basename(dir), dir);
        console.log(`Project "${p.name}" (${p.id})\n  folder: ${p.rootPath}\n  Claude Code transcripts: ${claudeCode.transcriptDirFor(dir)}`);
        break;
      }
      case "projects":
        for (const p of store.listProjects()) console.log(`${p.id}  ${p.name}  ${p.rootPath}  [${p.recordingState}]`);
        break;
      case "import-claude": {
        const p = project(store, args[0]);
        const scope = (flag("scope") ?? "all") as "own" | "all";
        const files = flag("file") ? [path.resolve(flag("file")!)] : transcriptFiles(p.rootPath, scope);
        if (scope === "all" && !flag("file"))
          console.log(`Reading ${files.length} Claude Code transcripts from all project folders; only activity that points at ${p.rootPath} is stored.`);
        let quiet = 0;
        for (const f of files) {
          const t0 = Date.now();
          const { batch, report } = await claudeCode.importTranscript(f, p.rootPath);
          const r = store.ingest(p.id, batch);
          if (!r.eventsInserted && !r.eventsSkippedDuplicate) {
            quiet++;
            continue;
          }
          console.log(`${path.basename(path.dirname(f)).slice(-28)}/${path.basename(f).slice(0, 8)}  +${r.eventsInserted} events `
            + `(${r.eventsSkippedDuplicate} dup), ${r.linksInserted} links, ${r.artifactsStored} artifacts | kept ${batch.events.length}, `
            + `left out ${report.excludedEvents} from ${report.excludedGroups} prompt groups for other projects | `
            + `redacted ${report.redactions.count}, withheld ${report.sensitiveFilesWithheld}  (${Date.now() - t0}ms)`);
        }
        if (quiet) console.log(`${quiet} transcripts had no activity for this project.`);
        const c = correlate(store, p.id);
        console.log(`correlated: ${JSON.stringify(c)}`);
        break;
      }
      case "import-git": {
        const p = project(store, args[0]);
        if (!git.isGitRepo(p.rootPath)) {
          console.log(`${p.rootPath} is not a git repository.`);
          break;
        }
        const { batch, report } = git.importGit(p.rootPath);
        const r = store.ingest(p.id, batch);
        console.log(`git: ${report.commits} commits, ${report.branchChanges} branch switches → +${r.eventsInserted} events, ${r.artifactsStored} diffs `
          + `| redacted ${report.redactions.count}, withheld ${report.filesWithheld} sensitive files, ${report.diffsTruncated} diffs truncated`);
        importGitIfChanged(store, p.id, p.rootPath); // set the recorder's fingerprint
        console.log(`correlated: ${JSON.stringify(correlate(store, p.id))}`);
        break;
      }
      case "correlate": {
        const p = project(store, args[0]);
        console.log(JSON.stringify(correlate(store, p.id)));
        break;
      }
      case "record": {
        const p = project(store, args[0]);
        const scope = (flag("scope") ?? "all") as "own" | "all";
        const ts = () => new Date().toTimeString().slice(0, 8);
        const rec = new Recorder(store, p.id, { transcriptScope: scope, log: (m) => console.log(`${ts()}  ${m}`) });
        console.log(`● Recording "${p.name}" (${p.rootPath})
  sources: files (watcher), git${git.isGitRepo(p.rootPath) ? "" : " — not a git repo, skipped"}, Claude Code transcripts (${scope === "all" ? "all folders, filtered to this project" : "this folder only"})
  not captured: commands you run yourself in other terminals; edits are seen, but not who made them
  Ctrl-C to stop · "dena pause ${p.name}" to pause`);
        await rec.start();
        await new Promise<void>((resolve) => {
          const done = () => {
            process.off("SIGINT", done);
            process.off("SIGTERM", done);
            resolve();
          };
          process.on("SIGINT", done);
          process.on("SIGTERM", done);
        });
        await rec.stop();
        console.log(`\n■ Stopped. ${JSON.stringify(store.stats(p.id).byType.slice(0, 6))}`);
        break;
      }
      case "pause":
      case "resume": {
        const p = project(store, args[0]);
        if (p.recordingState === "stopped") console.log(`"${p.name}" is not recording.`);
        else {
          store.setRecordingState(p.id, cmd === "pause" ? "paused" : "recording");
          console.log(`${cmd === "pause" ? "Pause" : "Resume"} requested; the recorder applies it within a few seconds.`);
        }
        break;
      }
      case "exclude": {
        const p = project(store, args[0]);
        if (!args[1]) throw new Error("Give a pattern, e.g. dena exclude myproj generated/");
        const s = store.updateProjectSettings(p.id, { exclude: [...new Set([...store.projectSettings(p.id).exclude, args[1]])] });
        console.log(`Excluded: ${s.exclude.join(", ")}`);
        break;
      }
      case "hooks": {
        const action = args[0];
        const p = project(store, args[1]);
        const scope = (flag("scope") ?? "project") as hookInstall.Scope;
        if (action === "status") {
          for (const s of ["project", "user"] as const)
            console.log(`${s.padEnd(8)} ${hookInstall.installedIn(s, p.rootPath) ? "installed" : "not installed"}  ${hookInstall.settingsFile(s, p.rootPath)}`);
          break;
        }
        if (action !== "install" && action !== "uninstall") throw new Error("Use: dena hooks status|install|uninstall <project>");
        const plan = action === "install" ? hookInstall.planInstall(scope, store.home, p.rootPath) : hookInstall.planUninstall(scope, p.rootPath);
        if (!plan.changed) {
          console.log(`Nothing to change in ${plan.file}.`);
          break;
        }
        const others = Object.keys(plan.before ?? {}).filter((k) => k !== "hooks" && k !== "permissions");
        console.log(`${action === "install" ? "Will add to" : "Will remove from"} ${plan.file}:
  hooks:  SessionStart, UserPromptSubmit, PostToolUse, PostToolUseFailure, SubagentStop, SessionEnd
          → ${hookInstall.hookCommand(store.home)}
  allow:  ${hookInstall.noteAllowRule()}   (lets the agent leave notes without a permission prompt)
  other settings and hooks are kept as they are${others.length ? ` (${others.join(", ")})` : ""}
${scope === "user" ? "  scope: every Claude Code session on this computer; it captures nothing unless a Dena project is recording\n" : "  scope: sessions launched in this folder only (sessions started elsewhere are still read from transcripts)\n"}
What the hook stores: ids, file paths, exit codes and timings for this computer's local spool — never prompt text or command output.`);
        if (!args.includes("--yes")) {
          console.log(`\nNothing written. Re-run with --yes to apply.`);
          break;
        }
        const backup = hookInstall.applyPlan(plan);
        console.log(`\nDone.${backup ? ` Backup of the previous file: ${backup}` : ""} New Claude Code sessions pick this up.`);
        break;
      }
      case "ingest-hooks": {
        const p = project(store, args[0]);
        const r = await hooks.ingestHooks(store, p.id, p.rootPath);
        console.log(JSON.stringify(r));
        break;
      }
      case "episodes": {
        const p = project(store, args[0]);
        const eps = rebuildEpisodes(store, p.id);
        for (const e of eps) {
          const s = e.stats;
          const bits = [s.prompts && `${s.prompts} prompts`, s.fileChanges && `${s.fileChanges} file changes`, s.commits && `${s.commits} commits`,
            s.tests && `${s.tests} test runs${s.testFailures ? ` (${s.testFailures} failed)` : ""}`, s.notes && `${s.notes} notes`].filter(Boolean).join(", ");
          console.log(`${String(e.position).padStart(3)}  ${e.id}  ${e.startedAt.slice(0, 16).replace("T", " ")}  ${e.title.slice(0, 70)}\n${" ".repeat(19)}${bits || "no changes"}`);
        }
        break;
      }
      case "packet":
      case "explain": {
        const p = project(store, args[0]);
        let eps = loadEpisodes(store, p.id);
        if (!eps.length) {
          rebuildEpisodes(store, p.id);
          eps = loadEpisodes(store, p.id);
        }
        const ref = args[1] ?? "last";
        const ep = ref === "last" ? eps[eps.length - 1] : eps.find((e) => e.id === ref || String(e.position) === ref);
        if (!ep) throw new Error(`No episode "${ref}". Run: dena episodes ${p.name}`);
        const depth = (flag("depth") ?? store.projectSettings(p.id).depth) as Depth;
        if (cmd === "packet") {
          const pk = buildPacket(store, p.id, ep.id, { depth });
          console.log(`${pk.items.length} items, ${pk.chars} characters${pk.truncated ? ", some truncated" : ""}. This text, after redaction, is what the model sees:\n`);
          console.log(renderPacket(pk));
          break;
        }
        const provider = new ClaudeCodeProvider();
        const x = await explainEpisode(store, p.id, ep.id, provider, { force: args.includes("--force"), model: flag("model"), depth,
          log: (m) => console.error(`· ${m}`) });
        const md = renderStep(x);
        if (flag("out")) {
          fs.writeFileSync(flag("out")!, md);
          console.error(`· wrote ${flag("out")}`);
        } else console.log(md);
        console.error(`· ${x.cached ? "cached" : x.step.generatedBy === "facts" ? "built from facts (no model call)" : `generated in ${x.attempts} call${x.attempts > 1 ? "s" : ""}${x.costUsd ? `, $${x.costUsd.toFixed(3)} reported` : ""}`}; ${x.validation.ok ? "passed checks" : `${x.validation.issues.filter((i) => i.severity === "error").length} problems remain (shown in the step)`}`);
        break;
      }
      case "guide": {
        if (args[0] !== "build") throw new Error("Use: dena guide build <project>");
        const p = project(store, args[1]);
        rebuildEpisodes(store, p.id);
        const eps = loadEpisodes(store, p.id);
        const from = Number(flag("from") ?? 1), to = Number(flag("to") ?? eps.length);
        const ids = eps.filter((e) => e.position >= from && e.position <= to).map((e) => e.id);
        const o = { model: flag("model"), depth: flag("depth") as Depth | undefined, force: args.includes("--force") };
        const est = estimate(store, p.id, ids, o);
        const s = store.projectSettings(p.id);
        const maxUsd = flag("max-usd") ? Number(flag("max-usd")) : s.maxUsdPerRun;
        console.log(`Episodes ${from}–${to}: ${est.episodes} total
  ${est.cached} already explained (free), ${est.factsOnly} with no changes (built from facts, free)
  ${est.modelCalls} model call${est.modelCalls === 1 ? "" : "s"} for the rest (small episodes share calls), ~${Math.round(est.inputChars / 1000)}k characters of evidence
  model: ${o.model ?? s.model ?? "your Claude Code default"} · depth: ${o.depth ?? s.depth}
  estimated usage: ${est.estimatedUsd !== null ? `~$${est.estimatedUsd.toFixed(2)} as Claude Code reports it (${est.basis})` : est.basis}${maxUsd !== undefined ? `\n  cap: stops before exceeding $${maxUsd}` : ""}`);
        if (!est.modelCalls) {
          if (est.factsOnly) await explainMany(store, p.id, ids, new ClaudeCodeProvider(), o);
          console.log("Nothing needs a model.");
          break;
        }
        if (!args.includes("--yes")) {
          console.log("\nNothing generated. Re-run with --yes to go ahead.");
          break;
        }
        const r = await explainMany(store, p.id, ids, new ClaudeCodeProvider(), { ...o, maxUsd, log: (m) => console.error(`· ${m}`),
          onProgress: (x) => !x.cached && console.error(`  ✓ ${x.unitId} ${x.step.generatedBy === "facts" ? "(facts)" : x.batched ? "(shared call)" : ""}${x.validation.ok ? "" : " ⚠ problems remain"}`) });
        const repairs = r.explained.filter((x) => !x.cached && x.attempts > 1).length;
        console.log(`\nDone: ${r.explained.length} episodes, ${r.calls} model calls, $${r.spentUsd.toFixed(2)} reported, ${repairs} needed a repair`
          + `${r.skippedForBudget.length ? `, ${r.skippedForBudget.length} skipped to stay under the cap` : ""}.`);
        break;
      }
      case "serve": {
        const srv = await startServer(store, { port: flag("port") ? Number(flag("port")) : 4600, log: (m) => console.log(`${new Date().toTimeString().slice(0, 8)}  ${m}`) });
        console.log(`Dena is running at:\n\n  ${srv.url}\n\nOnly this computer can reach it, and only with the key in that link. Ctrl-C to stop (stops any recording started here).`);
        await new Promise<void>((resolve) => {
          process.once("SIGINT", resolve);
          process.once("SIGTERM", resolve);
        });
        await srv.close();
        break;
      }
      case "config": {
        const p = project(store, args[0]);
        const [key, value] = [args[1], args[2]];
        if (key) {
          if (value === undefined) throw new Error("Give a value, e.g. dena config myproj model haiku");
          if (key === "model") store.updateProjectSettings(p.id, { model: value === "default" ? undefined : value });
          else if (key === "depth") {
            if (value !== "concise" && value !== "thorough") throw new Error("depth is concise or thorough");
            store.updateProjectSettings(p.id, { depth: value });
          } else if (key === "max-usd") store.updateProjectSettings(p.id, { maxUsdPerRun: value === "none" ? undefined : Number(value) });
          else throw new Error(`Unknown setting "${key}"`);
        }
        const s = store.projectSettings(p.id);
        console.log(`model:   ${s.model ?? "(your Claude Code default)"}\ndepth:   ${s.depth}\nmax-usd: ${s.maxUsdPerRun ?? "(no cap)"}\nexclude: ${s.exclude.join(", ") || "(defaults only)"}`);
        break;
      }
      case "gaps": {
        const p = project(store, args[0]);
        for (const g of store.gaps(p.id)) console.log(`${g.source.padEnd(24)} ${g.fromTime ?? "—"} → ${g.toTime ?? "—"}  ${g.reason}`);
        break;
      }
      case "timeline": {
        const p = project(store, args[0]);
        const events = store.timeline(p.id, { sessionId: flag("session") });
        let prompt: StoredEvent | null = null;
        let children: StoredEvent[] = [];
        for (const e of events) {
          if (e.eventType === "prompt_submitted" && e.actor === "user") {
            if (prompt || children.length) printGroup(prompt, children, args.includes("--all"));
            prompt = e;
            children = [];
          } else children.push(e);
        }
        if (prompt || children.length) printGroup(prompt, children, args.includes("--all"));
        break;
      }
      case "show": {
        const p = project(store, args[0]);
        const id = Number(args[1]);
        const e = store.db.prepare("SELECT id FROM event WHERE project_id = ? AND id = ?").get(p.id, id);
        if (!e) throw new Error(`No event ${id}`);
        const [ev] = store.timeline(p.id).filter((x) => x.id === id);
        console.log(JSON.stringify({ ...ev, links: store.linksFor(id), artifacts: store.artifactsFor(id) }, null, 2));
        for (const a of store.artifactsFor(id).filter((a) => a.artifactType === "diff"))
          console.log(`\n--- ${a.role} ---\n${store.blobs.get(a.contentHash)?.toString()}`);
        break;
      }
      case "stats": {
        const p = project(store, args[0]);
        const s = store.stats(p.id);
        console.log(`${p.name}: ${s.sessions} sessions, ${s.links} links, ${s.artifacts} artifacts, ${s.gaps} known gaps`);
        console.log("by type:  " + s.byType.map((t) => `${t.type}=${t.n}`).join("  "));
        console.log("by actor: " + s.byActor.map((t) => `${t.actor}=${t.n}`).join("  "));
        break;
      }
      case "delete": {
        const p = project(store, args[0]);
        store.deleteProject(p.id);
        console.log(`Deleted project "${p.name}" and its stored history.`);
        break;
      }
      default:
        console.log(USAGE);
        process.exitCode = 1;
    }
  } finally {
    store.close();
  }
}

main().catch((err) => {
  console.error(`dena: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
});
