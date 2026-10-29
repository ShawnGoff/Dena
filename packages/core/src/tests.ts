/**
 * Rules for recognising test runs and reading their outcomes from captured commands and output.
 * They live in core because their results are derived labels (see labels.ts): when these rules
 * improve, stored events are relabelled rather than left with the old answer.
 */

/** Bump when the rules below change, so existing labels are recomputed. */
export const TEST_RULES_VERSION = 2;

const TEST_RUNNER =
  /^(?:npx\s+|pnpm\s+(?:exec\s+|dlx\s+)?|yarn\s+|bunx?\s+|python3?\s+-m\s+|\.\/)?(vitest|jest|mocha|pytest|playwright test|cypress run|go test|cargo test|rspec|phpunit|(npm|pnpm|yarn|bun)( run)? test(:[\w-]+)?|xcodebuild\b.*\btest\b|swift test|dotnet test|mvn test|gradlew? test|node --test)\b/;

/**
 * True when one of the commands actually executed is a test runner. Heredoc bodies and
 * quoted strings are removed first: a script that merely mentions "vitest" is not a test run.
 */
export function isTestCommand(command: string): boolean {
  return commandSegments(command).some((seg) => TEST_RUNNER.test(seg));
}

function commandSegments(command: string): string[] {
  return command
    .replace(/<<-?\s*(['"]?)(\w+)\1[\s\S]*?\n\s*\2\b/g, "<<HEREDOC")
    .replace(/'[^']*'|"[^"]*"/g, "''")
    .split(/&&|\|\||;|\||\n/)
    .map((seg) => seg.trim().replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, ""))
    .filter(Boolean);
}

export interface TestOutcome {
  outcome: "passed" | "failed" | "unknown";
  passed?: number;
  failed?: number;
  basis: string;
}

/** Lines a test runner prints only for a failing test. Their presence settles the outcome even when the summary was cut off. */
const FAILURE_MARKERS: [RegExp, string][] = [
  [/^not ok \d+/m, "a TAP 'not ok' line"],
  [/ERR_TEST_FAILURE/, "node's ERR_TEST_FAILURE error"],
  [/^\s*(?:FAIL|✗|✕|×)\s+\S/m, "a runner's FAIL line"],
  [/^FAILED \S/m, "a pytest FAILED line"],
];

/**
 * Decides a test run's outcome without overclaiming, in this order:
 * 1. the runner's own summary line (counts);
 * 2. a line printed only for failing tests (so a cut-off summary still yields "failed");
 * 3. exit status, only when the test runner was the sole command (in `npm test | grep x` the
 *    exit status belongs to grep);
 * 4. otherwise unknown. Passing is never concluded from the absence of failure lines.
 */
export function testOutcome(command: string, output: string, isError: boolean, interrupted: boolean): TestOutcome {
  const num = (re: RegExp) => {
    const m = output.match(re);
    return m ? Number(m[1]) : undefined;
  };
  const summaries: [RegExp, RegExp, string][] = [
    [/^# pass\s+(\d+)/m, /^# fail\s+(\d+)/m, "TAP summary"],
    [/^ℹ pass (\d+)/m, /^ℹ fail (\d+)/m, "node test summary"],
    [/Tests?:?\s+.*?(\d+) passed/, /Tests?:?\s+.*?(\d+) failed/, "runner summary line"],
    [/(\d+) passed/, /(\d+) failed/, "pass/fail counts in output"],
  ];
  for (const [p, f, label] of summaries) {
    const passed = num(p);
    const failed = num(f);
    if (passed !== undefined || failed !== undefined) {
      const bad = (failed ?? 0) > 0;
      return { outcome: bad ? "failed" : "passed", passed, failed: failed ?? 0, basis: `parsed from ${label}` };
    }
  }
  for (const [re, label] of FAILURE_MARKERS)
    if (re.test(output)) {
      const count = (output.match(/^not ok \d+/gm) ?? []).length;
      return { outcome: "failed", failed: count || undefined, basis: `the output contains ${label} (no summary line was captured)` };
    }
  if (interrupted) return { outcome: "unknown", basis: "command was interrupted" };
  const segs = commandSegments(command).filter((s) => !/^cd\b/.test(s));
  if (segs.length === 1 && TEST_RUNNER.test(segs[0]!))
    return { outcome: isError ? "failed" : "passed", basis: "exit status of the test command" };
  return { outcome: "unknown", basis: "test ran inside a compound or piped command; exit status not attributable and no summary found" };
}
