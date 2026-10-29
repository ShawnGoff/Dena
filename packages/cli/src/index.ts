#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { correlate, Store, type StoredEvent } from "@dena/core";
import { claudeCode, git, hookInstall, hooks, importGitIfChanged, Recorder, transcriptFiles } from "@dena/adapters";

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
