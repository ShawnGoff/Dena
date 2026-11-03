/**
 * Secret redaction. Applied before anything is written to the event store, and
 * again before any content is sent to a model provider. It is pattern-based and
 * therefore best-effort: it lowers risk, it does not guarantee that nothing
 * sensitive remains. The UI and docs must say so.
 */

export const REDACTION_VERSION = 1;

interface Rule {
  kind: string;
  re: RegExp;
  /** Index of the capture group that holds the secret; 0 = whole match. */
  group?: number;
}

const SECRET_NAME = "(?:secret|token|passw(?:or)?d|passwd|api[_-]?key|access[_-]?key|private[_-]?key|auth)";

const RULES: Rule[] = [
  { kind: "private_key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { kind: "anthropic_key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: "openai_key", re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/g },
  { kind: "aws_access_key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "github_token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/g },
  { kind: "slack_token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { kind: "stripe_key", re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}/g },
  { kind: "google_api_key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { kind: "bearer_token", re: /\b(Bearer\s+)([A-Za-z0-9._~+/-]{20,}=*)/g, group: 2 },
  { kind: "url_credentials", re: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]+)(@)/gi, group: 2 },
  {
    // name = "literal" / "name": "literal" where the name looks secret-bearing. Only quoted
    // literals, so code like `tokenCount = items.length` is left alone.
    kind: "secret_assignment",
    re: new RegExp(String.raw`\b([A-Za-z0-9_.-]*${SECRET_NAME}[A-Za-z0-9_.-]*["']?\s*[:=]\s*)(["'])([^"'\s]{8,})(\2)`, "gi"),
    group: 3,
  },
  {
    // .env / shell style: NAME=value at the start of a line.
    kind: "secret_assignment",
    re: new RegExp(String.raw`^(\s*(?:export\s+)?[A-Za-z0-9_]*${SECRET_NAME}[A-Za-z0-9_]*=)([^\s"'#]{8,})`, "gim"),
    group: 2,
  },
];

export interface RedactionReport {
  count: number;
  kinds: Record<string, number>;
}

export function redactText(input: string, report?: RedactionReport): string {
  let out = input;
  for (const rule of RULES) {
    out = out.replace(rule.re, (...m: unknown[]) => {
      const match = m[0] as string;
      if (match.includes("[REDACTED:")) return match;
      if (report) {
        report.count++;
        report.kinds[rule.kind] = (report.kinds[rule.kind] ?? 0) + 1;
      }
      const tag = `[REDACTED:${rule.kind}]`;
      if (!rule.group) return tag;
      const groups = m.slice(1, -2) as (string | undefined)[];
      return groups.map((g, i) => (i + 1 === rule.group ? tag : (g ?? ""))).join("");
    });
  }
  return out;
}

/** Deep-redacts every string inside a JSON-like value. */
export function redactDeep<T>(value: T, report?: RedactionReport): T {
  if (typeof value === "string") return redactText(value, report) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, report)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, report);
    return out as T;
  }
  return value;
}

export const newReport = (): RedactionReport => ({ count: 0, kinds: {} });

/**
 * Files whose contents Dena never stores, even redacted. Their paths are still
 * recorded so the timeline can show that something happened to them.
 */
const SENSITIVE_PATH_PATTERNS: RegExp[] = [
  /(^|\/)\.env(\.[^/]*)?$/i,
  /(^|\/)\.envrc$/i,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /(^|\/)\.(npmrc|pypirc|netrc|pgpass)$/i,
  /(^|\/)\.aws\/credentials$/i,
  /(^|\/)\.ssh\//i,
  /(^|\/)(credentials|secrets?)(\.[a-z]+)?$/i,
  /(^|\/)\.git-credentials$/i,
];

/**
 * A project-relative path with forward slashes on every system. Dena stores and compares paths
 * this way (as git does); Windows would otherwise give "src\\app.ts".
 */
export const toPosix = (p: string): string => p.replace(/\\/g, "/");

export function isSensitivePath(p: string): boolean {
  p = toPosix(p);
  if (/\.env\.(example|sample|template)$/i.test(p)) return false;
  return SENSITIVE_PATH_PATTERNS.some((re) => re.test(p));
}

/** Default exclusions for filesystem capture (dependency, build and cache output). */
export const DEFAULT_EXCLUDED_DIRS = [
  "node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", ".turbo", ".cache",
  "coverage", "target", "__pycache__", ".venv", "venv", ".pytest_cache", ".DS_Store", ".dena",
];
