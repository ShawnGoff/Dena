import { useEffect, useRef, useState } from "react";
import { api, type EventLite } from "../api";
import { EventRow } from "../components/Bits";

export function Search({ projectId, selectedEvent, onEvent }: { projectId: string; selectedEvent: number | null; onEvent: (id: number) => void }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<EventLite[] | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  useEffect(() => {
    if (q.trim().length < 2) {
      setHits(null);
      return;
    }
    const t = setTimeout(() => {
      setBusy(true);
      api<EventLite[]>(`projects/${projectId}/search?q=${encodeURIComponent(q)}`).then(setHits, () => setHits([])).finally(() => setBusy(false));
    }, 220);
    return () => clearTimeout(t);
  }, [q, projectId]);

  return (
    <div className="page">
      <div className="search-box">
        <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search prompts, replies, commands, commit messages, file names…" aria-label="Search" />
      </div>
      {busy && <div className="faint">Searching…</div>}
      {hits && !busy && hits.length === 0 && <div className="empty"><b>No matches</b>Try fewer or different words.</div>}
      {hits?.map((h) => (
        <div key={h.id} style={{ marginBottom: 4 }}>
          <EventRow e={{ ...h, notable: true }} selected={h.id === selectedEvent} onClick={() => onEvent(h.id)} showDate />
          {h.snippet && <p className="snippet" style={{ paddingLeft: 200 }} dangerouslySetInnerHTML={{ __html: highlight(h.snippet) }} />}
        </div>
      ))}
    </div>
  );
}

/** Escapes the snippet, then turns the index's [match] markers into <mark>. */
function highlight(s: string): string {
  const esc = s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return esc.replace(/\[([^\]]*)\]/g, "<mark>$1</mark>");
}
