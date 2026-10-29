import type { StoredEvent } from "./model.ts";
import { TEST_RULES_VERSION, testOutcome, type TestOutcome } from "./tests.ts";

/**
 * Derived labels: conclusions computed from immutable events by rules that can improve.
 * The event keeps what was captured; the label holds today's best reading of it, plus the
 * rule version that produced it. Consumers read labels first and fall back to the payload.
 */

export interface TestLabel extends TestOutcome {
  rulesVersion: number;
}

/** Everything the label rules need to know about a stored test-run event. */
export interface TestInput {
  command: string;
  output: string;
  isError: boolean;
  interrupted: boolean;
}

/**
 * Re-reads a test run with the current rules. A re-read never knows less than the capture did:
 * the stored output can be shorter than what the importer saw, so a known captured outcome is
 * kept when the re-read comes back unknown, and captured counts fill in when both agree. Only a
 * real disagreement (newer rules reading the same output differently) replaces the captured result.
 */
export function labelTestRun(input: TestInput, captured?: { outcome?: string; passed?: number; failed?: number; basis?: string }): TestLabel {
  const fresh = testOutcome(input.command, input.output, input.isError, input.interrupted);
  const known = captured?.outcome === "passed" || captured?.outcome === "failed";
  if (fresh.outcome === "unknown" && known)
    return { outcome: captured!.outcome as "passed" | "failed", passed: captured!.passed, failed: captured!.failed, basis: captured!.basis ?? "recorded at capture", rulesVersion: TEST_RULES_VERSION };
  if (known && fresh.outcome === captured!.outcome)
    return { ...fresh, passed: fresh.passed ?? captured!.passed, failed: fresh.failed ?? captured!.failed, rulesVersion: TEST_RULES_VERSION };
  return { ...fresh, rulesVersion: TEST_RULES_VERSION };
}

/** A test run's outcome: the current label when there is one, else what was recorded at capture. */
export function effectiveTest(e: StoredEvent): { outcome: string | null; passed: number | null; failed: number | null; basis: string | null; relabelled: boolean } {
  const l = e.labels?.test as TestLabel | undefined;
  const p = e.payload as Record<string, any>;
  if (l) return { outcome: l.outcome, passed: l.passed ?? null, failed: l.failed ?? null, basis: l.basis, relabelled: l.outcome !== p.outcome };
  return { outcome: p.outcome ?? null, passed: p.testsPassed ?? null, failed: p.testsFailed ?? null, basis: p.outcomeBasis ?? null, relabelled: false };
}

/** The line to show for an event, reflecting current labels rather than the wording stored at capture. */
export function displaySummary(e: StoredEvent): string {
  if (e.eventType !== "test_result" || !e.labels?.test) return e.summary;
  const t = effectiveTest(e);
  const counts = t.passed != null || t.failed ? ` (${t.passed ?? "?"} passed, ${t.failed ?? 0} failed)` : "";
  return `Tests ${t.outcome === "unknown" ? "ran, outcome unknown" : t.outcome}${counts}`;
}
