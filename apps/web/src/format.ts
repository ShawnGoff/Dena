export const TYPE_LABEL: Record<string, string> = {
  prompt_submitted: "Prompt",
  ai_response_received: "AI reply",
  tool_invoked: "Tool call",
  tool_completed: "Tool result",
  file_created: "File created",
  file_modified: "File changed",
  file_deleted: "File deleted",
  git_commit: "Commit",
  branch_changed: "Branch",
  command_executed: "Command",
  test_result: "Tests",
  error_detected: "Error",
  agent_note: "Agent note",
  user_note: "Note",
  session_marker: "Session",
  milestone_detected: "Milestone",
};

export const ACTOR_LABEL: Record<string, string> = { user: "You", ai_agent: "AI", automated_tool: "Tool", unknown: "Unknown author" };

/** "Likely AI" / "Possibly AI" for unknown-author events with a supporting connection. */
export function authorLabel(actor: string, likely?: { confidence: "likely" | "possibly" } | null): string {
  if (actor !== "unknown") return ACTOR_LABEL[actor] ?? actor;
  if (!likely) return "Unknown author";
  return likely.confidence === "likely" ? "Likely AI" : "Possibly AI";
}

/** Matches text that only restates a project-wide limitation; those are shown once, in About this guide. */
export const isStandingLimitationText = (t: string) =>
  /outside (of )?claude code|not visible to (this|that) source|manual edits.{0,30}other terminals|older than the local reflog/i.test(t);

export const SOURCE_LABEL: Record<string, string> = {
  "claude_code.transcript": "Claude Code transcript",
  "claude_code.hooks": "Claude Code hook",
  git: "Git",
  fs: "File watcher",
  dena: "Dena",
};

export const CONFIDENCE_HELP: Record<string, string> = {
  observed: "Recorded directly by the source",
  derived: "Computed from recorded data (for example a test outcome read from output)",
  partial: "Recorded, but part of it is missing or its timing is approximate",
};

export const STRENGTH_HELP: Record<string, string> = {
  observed: "The source itself records this connection",
  inferred: "Concluded from several signals; plausible, not proven",
  weak: "Only happened around the same time; not evidence of cause",
};

/** 4300 → "4.3k", 14200 → "14k". */
export function tokens(n: number): string {
  return n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1_000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** "about 7–21k tokens" */
export function tokenRange(low: number, high: number): string {
  return `about ${tokens(low).replace(/k$/, "")}–${tokens(high)} tokens`;
}

export interface TokenUse { prompt: number; output: number; cacheRead: number }

/** "Used 14k tokens (9.8k from cache) · 2.1k written" */
export function tokenLine(t: TokenUse | null | undefined): string | null {
  if (!t || !t.prompt) return null;
  return `${tokens(t.prompt)} tokens sent${t.cacheRead ? ` (${tokens(t.cacheRead)} from cache)` : ""} · ${tokens(t.output)} written`;
}

export function when(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function timeOnly(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function tone(e: { type: string; outcome: string | null }): "ok" | "bad" | "warn" | "accent" | "muted" {
  if (e.type === "test_result") return e.outcome === "passed" ? "ok" : e.outcome === "failed" ? "bad" : "warn";
  if (e.type === "error_detected" || e.outcome === "error") return "bad";
  if (e.type === "prompt_submitted") return "accent";
  if (e.type === "agent_note") return "warn";
  if (e.type.startsWith("file_") || e.type === "git_commit") return "ok";
  return "muted";
}
