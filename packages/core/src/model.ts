import { z } from "zod";

/**
 * L0 event model. Adapters translate their sources into these shapes; nothing
 * downstream should need to know which tool produced an event.
 */

export const EVENT_SCHEMA_VERSION = 1;

export const EventType = z.enum([
  "prompt_submitted",
  "ai_response_received",
  "tool_invoked",
  "tool_completed",
  "file_created",
  "file_modified",
  "file_deleted",
  "git_commit",
  "command_executed",
  "test_result",
  "error_detected",
  "artifact_generated",
  "agent_note", // rationale the agent stated about its own work; a claim, not a verified fact
  "user_note",
  "session_marker", // e.g. context compaction, session start/end
  "milestone_detected",
]);
export type EventType = z.infer<typeof EventType>;

/** Who performed the action. Never inferred from timing alone. */
export const Actor = z.enum(["user", "ai_agent", "automated_tool", "unknown"]);
export type Actor = z.infer<typeof Actor>;

/**
 * How the event reached us:
 * - observed: the source recorded this action directly (hook payload, transcript record, git object)
 * - derived:  computed deterministically from observed records (e.g. a test outcome from an exit status)
 * - partial:  observed, but the source is known to be missing part of it (e.g. truncated output)
 */
export const CaptureConfidence = z.enum(["observed", "derived", "partial"]);
export type CaptureConfidence = z.infer<typeof CaptureConfidence>;

export const NewEvent = z.object({
  sessionId: z.string().nullable(),
  source: z.string().min(1), // e.g. "claude_code.transcript", "git", "fs"
  sourceEventId: z.string().min(1), // stable id within the source; used for dedup
  eventType: EventType,
  occurredAt: z.string().datetime({ offset: true }),
  actor: Actor,
  summary: z.string(),
  payload: z.record(z.unknown()),
  captureConfidence: CaptureConfidence,
  /** Where in the source this came from, so normalized records can be audited. */
  rawRef: z.string().optional(),
});
export type NewEvent = z.infer<typeof NewEvent>;

/**
 * Link strength vocabulary:
 * - observed: the source itself records the relationship (tool_use_id, parentUuid)
 * - inferred: derived from multiple signals; must be labeled when it affects an explanation
 * - weak:     plausible only (e.g. temporal proximity); never presented as causation
 */
export const LinkStrength = z.enum(["observed", "inferred", "weak"]);
export type LinkStrength = z.infer<typeof LinkStrength>;

export const LinkType = z.enum([
  "result_of", // tool_completed -> tool_invoked
  "in_response_to", // ai activity -> prompt
  "modified_file", // tool event -> file event
  "verifies", // test_result -> change
  "follows_failure", // corrective change -> earlier failure
  "part_of", // -> milestone
]);
export type LinkType = z.infer<typeof LinkType>;

export interface NewLink {
  fromSourceEventId: string;
  toSourceEventId: string;
  source: string;
  linkType: LinkType;
  strength: LinkStrength;
  basis: string; // human-readable reason the link exists
}

export interface NewGap {
  sessionId: string | null;
  source: string;
  fromTime: string | null;
  toTime: string | null;
  reason: string;
}

export interface StoredEvent {
  id: number;
  projectId: string;
  sessionId: string | null;
  source: string;
  sourceEventId: string;
  eventType: EventType;
  occurredAt: string;
  observedAt: string;
  actor: Actor;
  summary: string;
  payload: Record<string, unknown>;
  captureConfidence: CaptureConfidence;
  contentHash: string;
  rawRef: string | null;
}
