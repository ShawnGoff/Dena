import { useEffect, useState } from "react";
import { api } from "../api";
import { when } from "../format";

interface Entry { at: string; kind: string; who: string; text: string; detail?: string; status?: string; eventIds: number[] }
interface HowBuiltData {
  scope: string;
  stats: { sessions: number; prompts: number; aiEdits: number; commands: number; tests: number; testFailures: number; commits: number; notes: number };
  entries: Entry[];
  more: number;
}

const ICON: Record<string, string> = { prompt: "›", edit: "✎", command: "$", test: "▣", commit: "◆", note: "✱", question: "?", error: "!", file: "·", search: "⌕", read: "≡", browser: "◎" };
const WHO: Record<string, string> = { you: "You", ai: "AI", subagent: "Helper agent", tool: "Tool", unknown: "" };

/** "How the AI built this": the process behind a step or page, counted and told from captured events. */
export function HowBuilt({ projectId, type, docKey, onEvent }: { projectId: string; type: "step" | "wiki"; docKey: string; onEvent: (id: number) => void }) {
  const [h, setH] = useState<HowBuiltData | null>(null);
  const [open, setOpen] = useState(type === "step");
  useEffect(() => {
    api<HowBuiltData>(`projects/${projectId}/how-built?type=${type}&key=${encodeURIComponent(docKey)}`).then(setH, () => setH(null));
  }, [projectId, type, docKey]);
  if (!h) return null;
  const s = h.stats;
  const chips = [
    s.sessions > 0 && `${s.sessions} session${s.sessions === 1 ? "" : "s"}`, s.prompts > 0 && `${s.prompts} request${s.prompts === 1 ? "" : "s"} from you`,
    s.aiEdits > 0 && `${s.aiEdits} AI edit${s.aiEdits === 1 ? "" : "s"}`, s.commands > 0 && `${s.commands} command${s.commands === 1 ? "" : "s"}`,
    s.tests > 0 && `${s.tests} test run${s.tests === 1 ? "" : "s"}${s.testFailures ? ` · ${s.testFailures} failed` : ""}`,
    s.commits > 0 && `${s.commits} commit${s.commits === 1 ? "" : "s"}`, s.notes > 0 && `${s.notes} AI note${s.notes === 1 ? "" : "s"}`,
  ].filter(Boolean) as string[];
  return (
    <section className="step-section">
      <h3>How the AI built this</h3>
      <p className="muted small" style={{ marginTop: 0 }}>Across {h.scope}, counted from captured events (not written by AI).</p>
      <div className="row" style={{ flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
        {chips.length ? chips.map((c) => <span key={c} className="badge">{c}</span>) : <span className="faint small">No captured activity.</span>}
      </div>
      {h.entries.length > 0 && (
        <>
          <button className="linkish small" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? "Hide" : "Show"} {type === "step" ? "what happened, step by step" : "the requests, commits and AI notes"} ({h.entries.length}{h.more ? ` of ${h.entries.length + h.more}` : ""})
          </button>
          {open && (
            <ol className="activity" style={{ marginTop: 6 }}>
              {h.entries.map((e, i) => (
                <li key={i} className={`act ${e.kind}`} role="button" tabIndex={0} onClick={() => onEvent(e.eventIds[0]!)} onKeyDown={(k) => (k.key === "Enter" || k.key === " ") && onEvent(e.eventIds[0]!)}>
                  <span className="act-time mono">{when(e.at)}</span>
                  <span className="act-icon" aria-hidden>{ICON[e.kind] ?? "·"}</span>
                  <span className="act-body"><span className="act-who">{WHO[e.who] ?? ""}</span> {e.text}{e.status === "failed" && <span className="badge bad" style={{ marginLeft: 6 }}>failed</span>}{e.detail && <span className="act-detail">{e.detail}</span>}</span>
                </li>
              ))}
            </ol>
          )}
          {open && h.more > 0 && <p className="faint small">{h.more} more are left out; they are spread evenly through the period shown.</p>}
        </>
      )}
    </section>
  );
}
