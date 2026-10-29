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
