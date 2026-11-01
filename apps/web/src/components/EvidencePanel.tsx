import { useEffect, useState, type ReactNode } from "react";
import { api, type EventDetail } from "../api";
import { ACTOR_LABEL, CONFIDENCE_HELP, SOURCE_LABEL, STRENGTH_HELP, TYPE_LABEL, tone, when } from "../format";
import { Badge, Loading } from "./Bits";

/** Shows one event with everything that supports it: its text, diffs, output, and its links to other events. */
export function EvidencePanel({ projectId, eventId, onSelect, onClose, onEpisode }: {
  projectId: string; eventId: number; onSelect: (id: number) => void; onClose: () => void; onEpisode?: (episodeId: string) => void;
}) {
  const [d, setD] = useState<EventDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setD(null);
    setErr(null);
    api<EventDetail>(`projects/${projectId}/events/${eventId}`).then((x) => {
      setD(x);
      if (x.episode) onEpisode?.(x.episode); // lets the timeline open the episode this event belongs to
    }, (e) => setErr(String(e.message)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, eventId]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  if (err) return <aside className="panel"><div className="error">{err}</div></aside>;
  if (!d) return <aside className="panel"><Loading /></aside>;
  const e = d.event;
  const p = e.payload as Record<string, any>;
  const text: [string, string][] = [];
  if (typeof p.text === "string") text.push([e.eventType === "agent_note" ? "Note (the agent's own account, not verified)" : "Text", p.text]);
  if (typeof p.input?.command === "string") text.push(["Command", p.input.command]);
  if (typeof p.command === "string" && !p.input) text.push(["Command", p.command]);
  if (typeof p.message === "string") text.push(["Commit message", p.message]);
  if (typeof p.stdout === "string" && p.stdout) text.push(["Output", p.stdout]);
  if (typeof p.stderr === "string" && p.stderr) text.push(["Errors", p.stderr]);
  if (typeof p.output === "string" && p.output) text.push(["Output", p.output]);

  const facts: [string, ReactNode][] = [
    ["When", when(e.occurredAt)],
    ["Who", e.actor !== "unknown" ? ACTOR_LABEL[e.actor] ?? e.actor
      : d.likelyAuthor ? <span>{d.likelyAuthor.confidence === "likely" ? "Likely the AI" : "Possibly the AI"} <span className="faint">— inferred: {d.likelyAuthor.basis}. No source recorded the author.</span></span>
      : <span>Unknown <span className="faint">— no source recorded who made this, and nothing connects it to the AI.</span></span>],
    ["Source", SOURCE_LABEL[e.source] ?? e.source],
    ["Capture", <span title={CONFIDENCE_HELP[e.captureConfidence]}>{e.captureConfidence} — {CONFIDENCE_HELP[e.captureConfidence]?.toLowerCase()}</span>],
  ];
  if (p.file) facts.push(["File", <code>{String(p.file)}</code>]);
  // A test run's outcome is a derived label that can be re-read when Dena's rules improve.
  const label = (e as { labels?: Record<string, any> }).labels?.test as { outcome: string; passed?: number; failed?: number; basis: string } | undefined;
  const outcome = label?.outcome ?? p.outcome;
  if (outcome) facts.push(["Outcome", <Badge tone={tone({ type: e.eventType, outcome })}>{outcome}{(label?.passed ?? p.testsPassed) != null ? ` · ${label?.passed ?? p.testsPassed} passed, ${label?.failed ?? p.testsFailed ?? 0} failed` : ""}</Badge>]);
  if (label?.basis ?? p.outcomeBasis) facts.push(["How we know", String(label?.basis ?? p.outcomeBasis)]);
  if (label && p.outcome && label.outcome !== p.outcome) facts.push(["Re-read", `Recorded as "${p.outcome}" at capture; Dena's improved rules now read it as "${label.outcome}".`]);
  if (p.exitCode != null) facts.push(["Exit code", String(p.exitCode)]);
  if (p.durationMs != null) facts.push(["Duration", `${p.durationMs} ms`]);
  if (p.sha) facts.push(["Commit", <code>{String(p.sha).slice(0, 12)}</code>]);
  if (p.contentWithheld) facts.push(["Contents", "Withheld: sensitive file, never stored"]);
  if (p.diffUnavailable) facts.push(["Diff", String(p.diffUnavailable)]);
  if (p.timingNote) facts.push(["Timing", String(p.timingNote)]);
  if (p.aiCoAuthorTrailer) facts.push(["AI co-author", "The commit message says so (a claim, not proof)"]);
  if (e.rawRef) facts.push(["Raw record", <code>{e.rawRef}</code>]);

  return (
    <aside className="panel" aria-label="Source">
      <div className="panel-head">
        <Badge tone={tone({ type: e.eventType, outcome: outcome ?? p.status ?? null })}>{TYPE_LABEL[e.eventType] ?? e.eventType}</Badge>
        <h3>{e.summary}</h3>
        <button className="close" onClick={onClose} aria-label="Close">×</button>
      </div>
      <dl className="kv">
        {facts.map(([k, v]) => (
          <div key={k} style={{ display: "contents" }}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {text.map(([label, body], i) => (
        <div key={i}>
          <h4>{label}</h4>
          <div className={`textblock ${label === "Command" || label === "Output" || label === "Errors" ? "mono" : ""}`}>{body}</div>
        </div>
      ))}
      {d.artifacts.map((a, i) => (
        <div key={i}>
          <h4>{a.role === "diff" ? "Diff" : a.role === "content" ? "File contents" : a.role}{a.uriOrPath ? ` · ${a.uriOrPath}` : ""}</h4>
          {a.content === null ? <div className="faint">Not available</div> : a.artifactType === "diff" ? <Diff text={a.content} /> : <div className="textblock mono">{a.content}</div>}
          {a.truncated && <div className="faint" style={{ marginTop: 6 }}>Shortened for display.</div>}
        </div>
      ))}
      {d.links.length > 0 && (
        <>
          <h4>Connected events</h4>
          {d.links.map((l, i) => (
            <div key={i} className="link-row" onClick={() => onSelect(l.otherId)} title={`${l.basis}\n${STRENGTH_HELP[l.strength] ?? ""}`}>
              <Badge tone={l.strength === "observed" ? "ok" : l.strength === "inferred" ? "warn" : "muted"}>{l.strength}</Badge>
              <span className="faint" style={{ minWidth: 104 }}>{linkLabel(l.linkType, l.direction)}</span>
              <span className="s">{l.other?.summary ?? `event ${l.otherId}`}</span>
            </div>
          ))}
          <p className="faint" style={{ fontSize: 12 }}>Hover a connection to see what it is based on. Inferred and weak connections are not proof of cause.</p>
        </>
      )}
    </aside>
  );
}

function linkLabel(type: string, dir: "in" | "out"): string {
  const out: Record<string, string> = { result_of: "result of", in_response_to: "in response to", modified_file: "made by", same_change: "same change as",
    changed_during: "changed while", committed_in: "committed in", created_commit: "created" };
  const inn: Record<string, string> = { result_of: "result", in_response_to: "led to", modified_file: "changed file", same_change: "same change as",
    changed_during: "may have changed", committed_in: "contains", created_commit: "created by" };
  return (dir === "out" ? out : inn)[type] ?? type;
}

export function Diff({ text }: { text: string }) {
  return (
    <div className="diff">
      <pre>
        {text.split("\n").map((l, i) => (
          <span key={i} className={`l ${l.startsWith("@@") ? "hunk" : l.startsWith("+++") || l.startsWith("---") || l.startsWith("diff ") || l.startsWith("index ") ? "meta" : l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : ""}`}>
            {l || " "}
          </span>
        ))}
      </pre>
    </div>
  );
}
