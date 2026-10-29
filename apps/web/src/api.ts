/**
 * API client. The launch token arrives in the URL fragment (#t=…), which browsers never send to
 * servers or put in referrers. It is kept in sessionStorage for this tab only and removed from
 * the address bar.
 */

const KEY = "dena.token";

function readToken(): string | null {
  const m = location.hash.match(/[#&]t=([\w-]+)/);
  if (m) {
    try {
      sessionStorage.setItem(KEY, m[1]!);
    } catch {}
    history.replaceState(null, "", location.pathname + location.search);
    return m[1]!;
  }
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

const token = readToken();
export const hasToken = () => !!token;

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api/${path}`, {
    method: init.method ?? "GET",
    headers: { "x-dena-token": token ?? "", ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

export interface Project {
  id: string;
  name: string;
  rootPath: string;
  recordingState: "recording" | "paused" | "stopped";
  recorderRunning: boolean;
  recorderHere?: boolean;
  recorderElsewherePid?: number | null;
  stats?: Stats;
}
export interface Stats {
  sessions: number;
  byType: { type: string; n: number }[];
  byActor: { actor: string; n: number }[];
  links: number;
  artifacts: number;
  gaps: number;
}
export interface EventLite {
  id: number;
  type: string;
  actor: string;
  source: string;
  summary: string;
  at: string;
  confidence: string;
  notable: boolean;
  outcome: string | null;
  snippet?: string;
  /** For changes no source attributed: who most likely made them, and why Dena thinks so. */
  likelyAuthor?: LikelyAuthor | null;
}
export interface LikelyAuthor { who: "ai"; confidence: "likely" | "possibly"; basis: string }

export interface Episode {
  id: string;
  position: number;
  title: string;
  startedAt: string;
  endedAt: string;
  explained: boolean;
  stats: { prompts: number; fileChanges: number; commits: number; tests: number; testFailures: number; notes: number; commands: number };
}
export interface Gap {
  id: number;
  source: string;
  fromTime: string | null;
  toTime: string | null;
  reason: string;
}
export interface Overview {
  project: Project;
  settings: { model?: string; depth: string; exclude: string[] };
  stats: Stats;
  sources: { git: boolean; hooksProject: boolean; hooksUser: boolean };
  gaps: Gap[];
  recent: EventLite[];
  authors: { unknown: number; likelyAi: number; possiblyAi: number; unclear: number };
  episodes: { total: number; explained: number; latest: Omit<Episode, "explained">[] };
}
export interface EventDetail {
  event: {
    id: number;
    eventType: string;
    actor: string;
    source: string;
    sourceEventId: string;
    summary: string;
    occurredAt: string;
    observedAt: string;
    captureConfidence: string;
    payload: Record<string, unknown>;
    rawRef: string | null;
  };
  episode: string | null;
  links: { direction: "in" | "out"; otherId: number; linkType: string; strength: string; basis: string; other: EventLite | null }[];
  likelyAuthor: LikelyAuthor | null;
  artifacts: { role: string; artifactType: string; uriOrPath: string | null; sizeBytes: number; content: string | null; truncated: boolean }[];
}

export type ClaimKind = "observed" | "inferred" | "agent_stated" | "owner_stated" | "background";
export interface Claim {
  text: string;
  kind: ClaimKind;
  evidence: string[];
  edited?: boolean;
  flagged?: "incorrect";
}
export interface Step {
  title: string;
  summary: string;
  whatHappened: Claim[];
  whyItMattered: Claim[];
  howItWorks: Claim[];
  whatChanged: Claim[];
  decisions: Claim[];
  verification: Claim[];
  concepts: { term: string; explanation: string }[];
  uncertainty: string[];
  generatedBy: "model" | "facts";
}
export interface StoredExplanation {
  unitId: string;
  step: Step;
  validation: { ok: boolean; issues: { severity: "error" | "warning"; section: string; claim?: string; message: string }[]; counts: Record<ClaimKind, number>; citedShare: number;
    autoFixes?: string[] };
  evidence: Record<string, { eventIds: number[]; kind: string; at: string }>;
  model: string | null;
  requestedModel: string;
  costUsd: number | null;
  tokens?: { prompt: number; output: number; cacheRead: number } | null;
  attempts: number;
  batched: boolean;
  depth: "concise" | "thorough";
  createdAt: string;
  stale: boolean;
}
export interface ExplanationInfo {
  explanations: StoredExplanation[];
  estimate: { episodes: number; cached: number; factsOnly: number; modelCalls: number; inputChars: number; estimatedUsd: number | null; basis: string;
    promptTokens: number; outputTokens: number; tokensLow: number; tokensHigh: number; tokenBasis: string; tokensCalibrated: boolean };
  settings: { model: string | null; depth: "concise" | "thorough" };
  busy: boolean;
}
