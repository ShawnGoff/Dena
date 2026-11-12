import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isSensitivePath, newReport, redactText, type IngestBatch, type NewEvent, type RedactionReport } from "@dena/core";

/**
 * Git adapter. Git is evidence of *what* changed and when it was committed. It is not
 * evidence of who wrote a change or why: the author field names whoever made the commit,
 * so the actor stays "unknown" unless a stronger source says otherwise.
 */

export const SOURCE = "git";
const DIFF_LIMIT = 200_000; // chars of patch stored per commit
const LOCKFILE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|Gemfile\.lock|composer\.lock|go\.sum)$/;
const AI_TRAILER = /^Co-Authored-By:.*(claude|anthropic|copilot|cursor|codex|gemini|openai)/im;

function git(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
}

export function isGitRepo(root: string): boolean {
  try {
    return git(root, ["rev-parse", "--is-inside-work-tree"]).trim() === "true";
  } catch {
    return false;
  }
}

const gitDirs = new Map<string, string | null>();

/**
 * Where git keeps this folder's HEAD and its log: "<root>/.git" for an ordinary repository, the
 * repository's own folder when the project is a subfolder of it, and the worktree's private folder
 * for a linked worktree. Null when the folder is not in a repository.
 */
export function gitDir(root: string): string | null {
  const known = gitDirs.get(root);
  if (known && fs.existsSync(path.join(known, "HEAD"))) return known;
  let dir: string | null = null;
  try {
    dir = path.resolve(root, git(root, ["rev-parse", "--git-dir"]).trim());
  } catch {
    /* not a repository */
  }
  gitDirs.set(root, dir);
  return dir;
}

export interface FileStat {
  path: string;
  previousPath?: string;
  added: number | null; // null for binary
  removed: number | null;
}

/** Parses one numstat line, including rename forms "a => b" and "dir/{a => b}/f". */
export function parseNumstat(line: string): FileStat | null {
  const m = line.match(/^(-|\d+)\t(-|\d+)\t(.+)$/);
  if (!m) return null;
  const [, a, r, spec] = m as unknown as [string, string, string, string];
  const num = (s: string) => (s === "-" ? null : Number(s));
  const brace = spec.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
  if (brace) {
    const [, pre, from, to, post] = brace as unknown as [string, string, string, string, string];
    const join = (mid: string) => `${pre}${mid}${post}`.replace(/\/\//g, "/");
    return { path: join(to), previousPath: join(from), added: num(a), removed: num(r) };
  }
  const plain = spec.match(/^(.*) => (.*)$/);
  if (plain) return { path: plain[2]!, previousPath: plain[1]!, added: num(a), removed: num(r) };
  return { path: spec, added: num(a), removed: num(r) };
}

export interface GitImportReport {
  commits: number;
  branchChanges: number;
  redactions: RedactionReport;
  diffsTruncated: number;
  filesWithheld: number;
}

export function importGit(root: string, opts: { maxCommits?: number } = {}): { batch: IngestBatch; report: GitImportReport } {
  const batch: IngestBatch = { sessions: [], events: [], artifacts: [], links: [], gaps: [] };
  const report: GitImportReport = { commits: 0, branchChanges: 0, redactions: newReport(), diffsTruncated: 0, filesWithheld: 0 };
  if (!isGitRepo(root)) return { batch, report };

  const RS = "\x1e", US = "\x1f";
  let log = "";
  try {
    log = git(root, [
      // --relative: file paths as the project sees them, and only its own files, when the project is a subfolder of the repository.
      "log", "--branches", "--date-order", "--numstat", "-M", "--relative",
      ...(opts.maxCommits ? [`-n${opts.maxCommits}`] : []),
      `--format=${RS}%H${US}%P${US}%an${US}%aI${US}%cI${US}%D${US}%B${US}`,
    ]);
  } catch {
    return { batch, report }; // repository without commits
  }

  for (const chunk of log.split(RS).slice(1)) {
    const parts = chunk.split(US);
    const [sha, parents, author, authoredAt, committedAt, refs, message, rest] = parts as string[];
    if (!sha || !committedAt) continue;
    const files = (rest ?? "").split("\n").map(parseNumstat).filter((f): f is FileStat => f !== null);
    const withheld = files.filter((f) => isSensitivePath(f.path));
    report.filesWithheld += withheld.length;
    const subject = (message ?? "").split("\n")[0]!.trim();
    const sid = `commit:${sha}`;
    const event: NewEvent = {
      sessionId: null,
      source: SOURCE,
      sourceEventId: sid,
      eventType: "git_commit",
      occurredAt: committedAt,
      actor: "unknown",
      summary: `Commit ${sha.slice(0, 7)}: ${redactText(subject, report.redactions)}`,
      payload: {
        sha,
        parents: parents ? parents.split(" ").filter(Boolean) : [],
        refs: refs || null,
        author: author ?? null,
        authoredAt,
        message: redactText((message ?? "").trim(), report.redactions),
        aiCoAuthorTrailer: AI_TRAILER.test(message ?? ""),
        aiCoAuthorBasis: "Co-Authored-By trailer in the commit message; a claim made by whoever wrote the message",
        files: files.map((f) => ({ ...f, contentWithheld: isSensitivePath(f.path) || undefined })),
        linesAdded: files.reduce((n, f) => n + (f.added ?? 0), 0),
        linesRemoved: files.reduce((n, f) => n + (f.removed ?? 0), 0),
      },
      captureConfidence: "observed",
      rawRef: sha,
    };
    batch.events.push(event);
    report.commits++;

    // Patch body, minus secrets-bearing files and lockfile noise (both still listed in `files`).
    const excludes = files
      .filter((f) => isSensitivePath(f.path) || LOCKFILE.test(f.path))
      .map((f) => `:(exclude,literal)${f.path}`);
    try {
      let patch = git(root, ["show", "--format=", "--patch", "-M", "--relative", sha, "--", ".", ...excludes]);
      if (patch.length > DIFF_LIMIT) {
        patch = `${patch.slice(0, DIFF_LIMIT)}\n… [diff truncated by Dena at ${DIFF_LIMIT} chars]\n`;
        report.diffsTruncated++;
      }
      if (patch.trim()) batch.artifacts.push({ sourceEventId: sid, role: "diff", artifactType: "diff", content: redactText(patch, report.redactions) });
    } catch {
      batch.gaps.push({ sessionId: null, source: SOURCE, fromTime: committedAt, toTime: committedAt, reason: `Could not read diff for ${sha}` });
    }
  }

  // Branch switches come from the reflog: local-only and pruned by git after ~90 days.
  try {
    const reflog = git(root, ["reflog", "show", "--date=iso-strict", `--format=%H${US}%gd${US}%gs`, "HEAD"]);
    for (const line of reflog.split("\n")) {
      const [sha, selector, subject] = line.split(US);
      const m = subject?.match(/^checkout: moving from (\S+) to (\S+)$/);
      const at = selector?.match(/\{(.+)\}/)?.[1];
      if (!m || !at || !sha) continue;
      batch.events.push({
        sessionId: null, source: SOURCE, sourceEventId: `reflog:${at}:${sha}`, eventType: "branch_changed",
        occurredAt: new Date(at).toISOString(), actor: "unknown", summary: `Switched branch ${m[1]} → ${m[2]}`,
        payload: { from: m[1], to: m[2], sha }, captureConfidence: "observed", rawRef: selector,
      });
      report.branchChanges++;
    }
  } catch {
    /* no reflog */
  }
  batch.gaps.push({ sessionId: null, source: SOURCE, fromTime: null, toTime: null,
    reason: "Branch switches older than the local reflog (default ~90 days) are not recoverable" });
  return { batch, report };
}

export function repoRoot(dir: string): string | null {
  try {
    return path.resolve(git(dir, ["rev-parse", "--show-toplevel"]).trim());
  } catch {
    return null;
  }
}
