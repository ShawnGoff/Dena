#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { Store, type StoredEvent } from "@dena/core";
import { claudeCode } from "@dena/adapters";

const HOME = process.env.DENA_HOME ?? path.join(os.homedir(), ".dena");
const [cmd, ...args] = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const USAGE = `dena <command>
  init <dir> [--name N]          register a project folder
  projects                       list projects
  import-claude <project>        import Claude Code transcripts for the project's folder
                 [--file F]      ...or a single transcript file
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
  error_detected: "!", session_marker: "#", agent_note: "✎",
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
    : children.filter((e) => ["file_created", "file_modified", "file_deleted", "test_result", "error_detected", "session_marker"].includes(e.eventType)
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
        const files = flag("file") ? [path.resolve(flag("file")!)] : claudeCode.listTranscripts(p.rootPath);
        if (!files.length) console.log(`No transcripts found in ${claudeCode.transcriptDirFor(p.rootPath)}`);
        for (const f of files) {
          const t0 = Date.now();
          const { batch, report } = await claudeCode.importTranscript(f, p.rootPath);
          const r = store.ingest(p.id, batch);
          console.log(`${path.basename(f)}  ${report.lines} lines → +${r.eventsInserted} events (${r.eventsSkippedDuplicate} already stored), `
            + `${r.linksInserted} links, ${r.artifactsStored} artifacts, ${r.gapsRecorded} gaps  `
            + `| redacted ${report.redactions.count}, withheld ${report.sensitiveFilesWithheld} sensitive files, `
            + `${report.unparseable} unparseable, ${Object.values(report.ignoredRecordTypes).reduce((a, b) => a + b, 0)} ignored records  (${Date.now() - t0}ms)`);
        }
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
