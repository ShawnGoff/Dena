import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "@dena/core";
import { HOOK_SCRIPT, ingestHooks } from "../src/claude-code/hooks.ts";
import { addPausedWindow } from "../src/paused.ts";
import { applyPlan, installedIn, planInstall, planUninstall } from "../src/claude-code/install.ts";
import { parseAgentNote, transcriptsIn } from "../src/claude-code/transcript.ts";

let home: string;
let root: string;
let store: Store;
let pid: string;

const runHook = (input: object, env: Record<string, string> = {}) =>
  spawnSync("node", [HOOK_SCRIPT, "--home", home], { input: JSON.stringify(input), encoding: "utf8", env: { ...process.env, ...env } });
const spoolLines = () => {
  const dir = path.join(home, "spool");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).flatMap((f) => fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "dena-hk-"));
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dena-hkr-")));
  store = new Store(home);
  pid = store.createProject("h", root).id;
});
afterEach(() => {
  store.close();
  for (const d of [home, root]) fs.rmSync(d, { recursive: true, force: true });
});

describe("hook forwarder", () => {
  it("captures nothing unless a project is recording", () => {
    const r = runHook({ hook_event_name: "PostToolUse", session_id: "s", cwd: root, tool_name: "Bash", tool_use_id: "t1" });
    expect(r.status).toBe(0);
    expect(spoolLines()).toHaveLength(0);
  });

  it("spools metadata only — no prompt text or tool output — and always exits 0", () => {
    store.setRecordingState(pid, "recording");
    runHook({ hook_event_name: "UserPromptSubmit", session_id: "s", cwd: root, prompt_id: "p1", prompt: "my secret plan" });
    runHook({ hook_event_name: "PostToolUse", session_id: "s", cwd: root, tool_name: "Bash", tool_use_id: "t1", duration_ms: 42,
      tool_input: { command: "cat secrets.txt" }, tool_response: { stdout: "TOPSECRET", stderr: "" } });
    runHook({ hook_event_name: "PostToolUseFailure", session_id: "s", cwd: root, tool_name: "Bash", tool_use_id: "t2", error: "Exit code 3\nboom" });
    const lines = spoolLines();
    expect(lines).toHaveLength(3);
    const all = JSON.stringify(lines);
    expect(all).not.toContain("my secret plan");
    expect(all).not.toContain("TOPSECRET");
    expect(all).not.toContain("cat secrets.txt");
    expect(lines[2]).toMatchObject({ tool_use_id: "t2", exit_code: 3 });
    expect(runHook({ not: "a hook" }).status).toBe(0);
    expect(spawnSync("node", [HOOK_SCRIPT, "--home", home], { input: "{garbage", encoding: "utf8" }).status).toBe(0);
  });

  it("teaches the notes channel at SessionStart, only inside a recording project", () => {
    store.setRecordingState(pid, "recording");
    const inside = runHook({ hook_event_name: "SessionStart", session_id: "s", cwd: root, source: "startup" }, { CLAUDE_PROJECT_DIR: root });
    const ctx = JSON.parse(inside.stdout).hookSpecificOutput;
    expect(ctx.hookEventName).toBe("SessionStart");
    expect(ctx.additionalContext).toContain("note decision <<'NOTE'");
    expect(ctx.additionalContext).toContain("not as verified fact");
    const outside = runHook({ hook_event_name: "SessionStart", session_id: "s2", cwd: "/elsewhere" }, { CLAUDE_PROJECT_DIR: "/elsewhere" });
    expect(outside.stdout).toBe("");
  });

  it("reminds the agent to note its reasons after a commit with no note since the last one", () => {
    store.setRecordingState(pid, "recording");
    const bash = (command: string) =>
      runHook({ hook_event_name: "PostToolUse", session_id: "s", cwd: root, tool_name: "Bash", tool_use_id: command, tool_input: { command } }, { CLAUDE_PROJECT_DIR: root }).stdout;
    const reminder = (out: string) => (out ? JSON.parse(out).hookSpecificOutput.additionalContext as string : "");
    expect(reminder(bash("npm test"))).toBe("");
    expect(reminder(bash("cat > t.ts <<'EOF'\nrun('git add -A && git commit -m x');\nEOF"))).toBe(""); // only mentioned in a heredoc
    expect(reminder(bash('echo "then git commit"'))).toBe("");
    expect(reminder(bash('git commit -m "Add parser"'))).toContain("no note was recorded");
    expect(reminder(bash(`node ${HOOK_SCRIPT} note decision <<'NOTE'\nUsed a state machine for quoting.\nNOTE`))).toBe("");
    expect(reminder(bash("git add -A && git commit -q -m next"))).toBe(""); // noted since the last commit
    expect(reminder(bash("git -C . commit --amend --no-edit"))).toContain("no note was recorded"); // nothing new since then
  });

  it("stops capturing when paused", () => {
    store.setRecordingState(pid, "recording");
    store.setRecordingState(pid, "paused");
    runHook({ hook_event_name: "PostToolUse", session_id: "s", cwd: root, tool_use_id: "t9" });
    expect(spoolLines()).toHaveLength(0);
  });
});

describe("agent notes", () => {
  it("parses heredoc and quoted forms", () => {
    expect(parseAgentNote(`node ${HOOK_SCRIPT} note decision <<'NOTE'\nUsed SQLite: one file, no server.\nNOTE`))
      .toEqual({ kind: "decision", text: "Used SQLite: one file, no server." });
    expect(parseAgentNote(`node "/x y/dena-hook.mjs" note cause "Stale cache key"`)).toEqual({ kind: "cause", text: "Stale cache key" });
    expect(parseAgentNote("node dena-hook.mjs note weird 'x'")).toEqual({ kind: "note", text: "x" });
    expect(parseAgentNote("echo note decision")).toBeNull();
    expect(parseAgentNote(`node ${HOOK_SCRIPT} note decision`)).toBeNull();
  });
  it("the note command itself is a harmless no-op", () => {
    expect(spawnSync("node", [HOOK_SCRIPT, "note", "decision"], { input: "text", encoding: "utf8" }).stdout).toBe("Noted for Dena.\n");
  });
});

describe("ingestHooks", () => {
  it("imports the transcript a hook points at, adds exit codes, and records fallbacks and gaps", async () => {
    const tdir = fs.mkdtempSync(path.join(os.tmpdir(), "dena-tr-"));
    const transcript = path.join(tdir, "s.jsonl");
    const rec = (o: object) => JSON.stringify({ sessionId: "s", cwd: root, timestamp: "2026-10-01T10:00:00.000Z", isSidechain: false, ...o });
    fs.writeFileSync(transcript, [
      rec({ type: "user", uuid: "u1", parentUuid: null, promptId: "p1", message: { role: "user", content: "run the tests" } }),
      rec({ type: "assistant", uuid: "a1", parentUuid: "u1", message: { role: "assistant", content: [
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test 2>&1 | tail -3" } },
        { type: "tool_use", id: "t2", name: "Bash", input: { command: `node ${HOOK_SCRIPT} note cause <<'NOTE'\nThe fixture path was relative.\nNOTE` } },
      ] } }),
    ].join("\n") + "\n");
    store.setRecordingState(pid, "recording");
    runHook({ hook_event_name: "SessionStart", session_id: "s", cwd: root, transcript_path: transcript, source: "startup", model: "claude-opus-5-5" });
    runHook({ hook_event_name: "PostToolUseFailure", session_id: "s", cwd: root, transcript_path: transcript, tool_name: "Bash", tool_use_id: "t1", error: "Exit code 1\nFAIL", duration_ms: 900 });
    runHook({ hook_event_name: "PostToolUse", session_id: "s", cwd: root, tool_name: "Write", tool_use_id: "ghost", tool_input: { file_path: `${root}/x.ts` } });
    runHook({ hook_event_name: "UserPromptSubmit", session_id: "s", cwd: root, prompt_id: "p-missing" });

    const r = await ingestHooks(store, pid, root, { final: true });
    expect(r).toMatchObject({ records: 4, transcriptsImported: 1, fallbacks: 1 });
    const ev = store.timeline(pid);
    const exit = ev.find((e) => e.sourceEventId === "hook:PostToolUseFailure:t1")!;
    expect(exit).toMatchObject({ eventType: "error_detected", payload: { exitCode: 1, durationMs: 900 } });
    expect(store.linksFor(exit.id)).toContainEqual(expect.objectContaining({ linkType: "result_of", otherId: ev.find((e) => e.sourceEventId === "tool:t1")!.id }));
    expect(ev.find((e) => e.eventType === "agent_note")).toMatchObject({ actor: "ai_agent", payload: { kind: "cause", text: "The fixture path was relative.", claimStatus: "agent_stated" } });
    expect(ev.find((e) => e.sourceEventId === "hook:tool:ghost")).toMatchObject({ captureConfidence: "partial" });
    expect(ev.some((e) => e.summary.startsWith("Claude Code session started (startup), model claude-opus-5-5"))).toBe(true);
    const gaps = store.gaps(pid).map((g) => g.reason);
    expect(gaps.some((g) => g.includes("ghost"))).toBe(true);
    expect(gaps.some((g) => g.includes("p-missing"))).toBe(true);
    expect(gaps.some((g) => g.includes("(p1)"))).toBe(false);

    expect((await ingestHooks(store, pid, root)).records).toBe(0); // cursor advanced
    fs.rmSync(tdir, { recursive: true, force: true });
  });

  it("leaves out the turns of a conversation that happened while paused", async () => {
    const tdir = fs.mkdtempSync(path.join(os.tmpdir(), "dena-tr-"));
    const transcript = path.join(tdir, "s.jsonl");
    const rec = (o: object, at: string) => JSON.stringify({ sessionId: "s", cwd: root, timestamp: at, isSidechain: false, ...o });
    fs.writeFileSync(transcript, [
      rec({ type: "user", uuid: "u1", parentUuid: null, promptId: "p1", message: { role: "user", content: "before the pause" } }, "2026-10-01T10:00:00.000Z"),
      rec({ type: "user", uuid: "u2", parentUuid: "u1", promptId: "p2", message: { role: "user", content: "a private question" } }, "2026-10-01T10:30:00.000Z"),
      rec({ type: "user", uuid: "u3", parentUuid: "u2", promptId: "p3", message: { role: "user", content: "after resuming" } }, "2026-10-01T11:30:00.000Z"),
    ].join("\n") + "\n");
    addPausedWindow(store, pid, { from: "2026-10-01T10:15:00.000Z", to: "2026-10-01T11:00:00.000Z" });
    store.setRecordingState(pid, "recording");
    runHook({ hook_event_name: "UserPromptSubmit", session_id: "s", cwd: root, transcript_path: transcript, prompt_id: "p3" });
    await ingestHooks(store, pid, root, { final: true });
    const prompts = store.timeline(pid).filter((e) => e.eventType === "prompt_submitted").map((e) => e.occurredAt);
    expect(prompts).toEqual(["2026-10-01T10:00:00.000Z", "2026-10-01T11:30:00.000Z"]);
    fs.rmSync(tdir, { recursive: true, force: true });
  });

  it("waits for the transcript to catch up instead of reporting a false gap (race seen in a real session)", async () => {
    const tdir = fs.mkdtempSync(path.join(os.tmpdir(), "dena-race-"));
    const transcript = path.join(tdir, "s.jsonl");
    const rec = (o: object) => JSON.stringify({ sessionId: "s", cwd: root, timestamp: "2026-10-01T10:00:00.000Z", isSidechain: false, ...o });
    const prompt = rec({ type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "write it" } });
    fs.writeFileSync(transcript, prompt + "\n"); // the tool_use line has not been flushed yet
    store.setRecordingState(pid, "recording");
    runHook({ hook_event_name: "PostToolUse", session_id: "s", cwd: root, transcript_path: transcript, tool_name: "Write", tool_use_id: "late", duration_ms: 5 });

    const first = await ingestHooks(store, pid, root);
    expect(first.fallbacks).toBe(0);
    expect(store.gaps(pid).some((g) => g.reason.includes("late"))).toBe(false);

    fs.appendFileSync(transcript, rec({ type: "assistant", uuid: "a1", parentUuid: "u1", message: { role: "assistant",
      content: [{ type: "tool_use", id: "late", name: "Write", input: { file_path: `${root}/x.js`, content: "1" } }] } }) + "\n");
    const second = await ingestHooks(store, pid, root);
    expect(second.fallbacks).toBe(0);
    expect(store.timeline(pid).find((e) => e.sourceEventId === "hook:PostToolUse:late")).toBeDefined();
    expect(store.timeline(pid).some((e) => e.sourceEventId === "hook:tool:late")).toBe(false);
    expect(store.gaps(pid).some((g) => g.reason.includes("reported by a hook"))).toBe(false);
    fs.rmSync(tdir, { recursive: true, force: true });
  });

  it("falls back after the grace period when the transcript never catches up", async () => {
    store.setRecordingState(pid, "recording");
    runHook({ hook_event_name: "PostToolUse", session_id: "s", cwd: root, tool_name: "Write", tool_use_id: "never", tool_input: { file_path: `${root}/y.js` } });
    expect((await ingestHooks(store, pid, root)).fallbacks).toBe(0);
    expect((await ingestHooks(store, pid, root, { now: Date.now() + 31_000 })).fallbacks).toBe(1);
  });
});

describe("hook installer", () => {
  it("merges into existing settings, is idempotent, backs up, and uninstalls cleanly", () => {
    const file = path.join(root, ".claude", "settings.local.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const original = { model: "opus", permissions: { allow: ["Bash(npm test:*)"] },
      hooks: { PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "prettier --write" }] }] } };
    fs.writeFileSync(file, JSON.stringify(original));

    const plan = planInstall("project", home, root);
    expect(plan.changed).toBe(true);
    const backup = applyPlan(plan);
    expect(backup && fs.existsSync(backup)).toBe(true);
    const after = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(after.model).toBe("opus");
    expect(after.permissions.allow).toContain("Bash(npm test:*)");
    expect(after.hooks.PostToolUse).toHaveLength(2); // user's hook kept, Dena's added
    expect(after.hooks.SessionStart[0].hooks[0]).toMatchObject({ type: "command", timeout: 5 });
    expect(after.hooks.SessionStart[0].hooks[0].async).toBeUndefined();
    expect(after.hooks.PostToolUse[1].hooks[0].async).toBe(true);
    expect(installedIn("project", root)).toBe(true);

    expect(planInstall("project", home, root).changed).toBe(false); // idempotent
    applyPlan(planUninstall("project", root));
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(original);
  });

  it("refuses to touch invalid JSON", () => {
    const file = path.join(root, ".claude", "settings.local.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ not json");
    expect(() => planInstall("project", home, root)).toThrow(/not valid JSON/);
  });
});

describe("transcriptsIn", () => {
  it("includes subagent transcripts", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "dena-sub-"));
    fs.writeFileSync(path.join(d, "s.jsonl"), "");
    fs.mkdirSync(path.join(d, "s", "subagents"), { recursive: true });
    fs.writeFileSync(path.join(d, "s", "subagents", "agent-1.jsonl"), "");
    fs.writeFileSync(path.join(d, "s", "custom-title.json"), "{}");
    expect(transcriptsIn(d).map((f) => path.relative(d, f).replace(/\\/g, "/")).sort()).toEqual(["s.jsonl", "s/subagents/agent-1.jsonl"]);
    fs.rmSync(d, { recursive: true, force: true });
  });
});

describe("a prompt the transcript never shows", () => {
  it("is recorded as a gap without stopping later hook calls", async () => {
    const spool = path.join(home, "spool", "hooks-2026-10-01.jsonl");
    fs.mkdirSync(path.dirname(spool), { recursive: true });
    const t0 = Date.parse("2026-10-01T10:00:00Z");
    const line = (o: object) => fs.appendFileSync(spool, JSON.stringify({ received_at: new Date(t0).toISOString(), cwd: root, ...o }) + "\n");
    line({ hook_event_name: "UserPromptSubmit", session_id: "unseen", prompt_id: "pr1" });
    await ingestHooks(store, pid, root, { now: t0 }); // inside the grace period: it waits
    line({ hook_event_name: "SessionStart", session_id: "later" });
    const r = await ingestHooks(store, pid, root, { now: t0 + 60_000 });
    expect(r.events).toBe(1);
    expect(store.gaps(pid).map((g) => g.reason)).toContain("A prompt (pr1) was submitted but is missing from the transcript");
    expect(JSON.parse(store.getCursor(pid, "claude_code.hooks", "pending")!)).toEqual([]);
  });
});
