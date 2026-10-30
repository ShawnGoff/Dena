import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { Badge, Loading } from "../components/Bits";
import { BusyBar, ModelChoice } from "../components/BusyBar";
import { ModelSettings, useSettingsChanged } from "../components/ModelSettings";
import { tokenLine, tokenRange, when } from "../format";

interface FileSummary { path: string; language: string; bytes: number; symbols: number; current: number; changed: number; new: number; fileDoc: "current" | "outdated" | "none" }
interface Concept { concept: string; explanation: string }
interface SymbolDoc { summary: string; how: string[]; learn: Concept[]; watch: string[] }
interface Sym {
  key: string; name: string; kind: string; parent?: string; startLine: number; endLine: number; ranges: [number, number][];
  status: "current" | "changed" | "new"; doc: SymbolDoc | null; docModel: string | null; docAt: string | null; aiEdits: number; editEventIds: number[];
}
interface HistoryEntry { at: string; kind: string; who: string; text: string; detail?: string; symbols: string[]; eventIds: number[] }
interface Page {
  file: { path: string; language: string };
  text: string;
  lines: number;
  symbols: Sym[];
  fileDoc: { doc: { purpose: string; fitsIn: string[]; learn: Concept[]; readingOrder: string[] }; current: boolean; model: string | null; createdAt: string } | null;
  links: { imports: { local: string[]; packages: string[] }; importedBy: string[] };
  history: { created: { at: string; who: string } | null; aiEdits: number; sessions: number; commits: number; entries: HistoryEntry[] };
  pending: { symbols: number; fileDoc: boolean; chars: number; calls: number; estimate: { low: number; high: number; calibrated: boolean; basis: string } | null };
  usage: { calls: number; tokens: { prompt: number; output: number; cacheRead: number } };
  settings: { model: string | null };
  busy: boolean;
}

const KIND_LABEL: Record<string, string> = { function: "function", class: "class", method: "method", type: "type", value: "value", setup: "imports & top-level code", part: "part" };
const WHO: Record<string, string> = { you: "You", ai: "AI", subagent: "Helper agent", unknown: "" }; // no author recorded: say nothing rather than guess
const symId = (key: string) => `sym-${key.replace(/[^\w-]/g, "_")}`;

/**
 * Code explainers: a page per source file, explained function by function. Only new and changed
 * functions are sent to the model again; "How the AI built this" is counted from captured events.
 */
export function Code({ projectId, file, onFile, onEvent }: { projectId: string; file: string | null; onFile: (path: string) => void; onEvent: (id: number) => void }) {
  const [files, setFiles] = useState<FileSummary[] | null>(null);
  const [filter, setFilter] = useState("");
  const load = useCallback(() => api<{ files: FileSummary[] }>(`projects/${projectId}/code`).then((r) => setFiles(r.files), () => setFiles([])), [projectId]);
  useEffect(() => {
    load();
  }, [load]);
  useSettingsChanged(load);
  const groups = useMemo(() => {
    const m = new Map<string, FileSummary[]>();
    for (const f of files ?? []) {
      if (filter && !f.path.toLowerCase().includes(filter.toLowerCase())) continue;
      const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "(project root)";
      m.set(dir, [...(m.get(dir) ?? []), f]);
    }
    return [...m.entries()];
  }, [files, filter]);
  if (!files) return <Loading />;
  const explained = files.filter((f) => f.current > 0 || f.fileDoc !== "none").length;
  const outdated = files.filter((f) => f.changed > 0 || f.fileDoc === "outdated").length;
  const current = file && files.some((f) => f.path === file) ? file : null;

  return (
    <div className="guide">
      <nav className="toc" aria-label="Source files">
        <ModelSettings projectId={projectId} />
        <div className="side-label">Files</div>
        <p className="faint small" style={{ margin: "0 8px 8px" }}>{explained} of {files.length} explained{outdated ? ` · ${outdated} changed since` : ""}</p>
        <input className="code-filter" placeholder="Filter files" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter files" />
        {groups.map(([dir, fs]) => (
          <div key={dir}>
            <div className="code-dir mono">{dir}</div>
            {fs.map((f) => {
              const state = f.changed > 0 || f.fileDoc === "outdated" ? "outdated" : f.current > 0 ? (f.new > 0 ? "partial" : "done") : "none";
              return (
                <button key={f.path} className={`toc-item ${f.path === current ? "active" : ""}`} onClick={() => onFile(f.path)} style={{ gridTemplateColumns: "1fr auto" }}>
                  <span className="toc-title mono small">{f.path.split("/").pop()}</span>
                  {state !== "none" && <span className="toc-done" style={{ color: state === "done" ? "var(--ok)" : "var(--warn)" }}
                    title={state === "done" ? "Explained" : state === "partial" ? `${f.new} not explained yet` : "Changed since it was explained"}>●</span>}
                </button>
              );
            })}
          </div>
        ))}
        {!groups.length && <p className="faint small" style={{ padding: "0 8px" }}>No matching files.</p>}
      </nav>
      <div className="guide-main">
        {current ? <FilePage key={current} projectId={projectId} file={current} onFile={onFile} onEvent={onEvent} onChanged={load} known={new Set(files.map((f) => f.path))} />
          : (
            <div className="page" style={{ maxWidth: 760 }}>
              <h2 className="step-title">Code explainers</h2>
              <p className="muted">Pick a file to read what each function does, how it works, and what you can learn from it, plus how the AI built it.</p>
              <ul className="plain muted">
                <li>Each function, class and method is explained on its own. When code changes, only the changed functions are explained again; the rest keep their explanations.</li>
                <li>Explanations are an AI's reading of the code and can be wrong. The code is shown next to them so you can check.</li>
                <li>"How the AI built this" is not written by AI: it lists the captured prompts, edits, commits and notes that touched the file.</li>
              </ul>
            </div>
          )}
      </div>
    </div>
  );
}

function FilePage({ projectId, file, onFile, onEvent, onChanged, known }: { projectId: string; file: string; onFile: (p: string) => void; onEvent: (id: number) => void; onChanged: () => void; known: Set<string> }) {
  const [p, setP] = useState<Page | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [runModel, setRunModel] = useState("");
  const q = `projects/${projectId}/code/file?path=${encodeURIComponent(file)}`;
  const load = useCallback(() => api<Page>(q).then(setP, (e) => setErr(String(e.message))), [q]);
  useEffect(() => {
    load();
  }, [load]);
  useSettingsChanged(load);
  const lines = useMemo(() => p?.text.split("\n") ?? [], [p?.text]);

  const explain = async (force = false) => {
    setBusy(true);
    setStopping(false);
    setErr(null);
    try {
      await api(`projects/${projectId}/code/explain`, { method: "POST", body: { path: file, model: runModel || undefined, force } });
      await load();
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const stop = async () => {
    setStopping(true);
    await api(`projects/${projectId}/code/stop`, { method: "POST", body: { path: file } }).catch(() => {});
  };
  const exportMd = async () => {
    const r = await api<{ filename: string; markdown: string }>(`projects/${projectId}/code/export?path=${encodeURIComponent(file)}`);
    const url = URL.createObjectURL(new Blob([r.markdown], { type: "text/markdown;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = r.filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const goSym = (key: string) => document.getElementById(symId(key))?.scrollIntoView({ block: "start", behavior: "smooth" });

  if (!p) return err ? <div className="error">{err}</div> : <Loading />;
  const changed = p.symbols.filter((s) => s.status === "changed").length;
  const fresh = p.symbols.filter((s) => s.status === "new").length;
  const anyDoc = p.symbols.some((s) => s.doc) || p.fileDoc;
  const fileLink = (f: string) => (known.has(f) ? <button key={f} className="chip" onClick={() => onFile(f)}>{f}</button> : <code key={f}>{f}</code>);

  return (
    <div className="page" style={{ maxWidth: 900 }}>
      {busy && <BusyBar what={`Explaining ${p.pending.symbols} ${p.pending.symbols === 1 ? "symbol" : "symbols"}${p.pending.fileDoc ? " and the file page" : ""}`} onStop={stop} stopping={stopping} />}
      {err && <div className={err.startsWith("Stopped") ? "notice" : "error"}>{err}</div>}
      <h2 className="step-title mono" style={{ fontSize: 20 }}>{p.file.path}</h2>
      <p className="faint small" style={{ marginTop: -6 }}>{p.file.language} · {p.lines} lines · {p.symbols.length} parts</p>

      {p.pending.calls > 0 && (
        <div className="explain-card" style={{ marginBottom: 18 }}>
          <p className="muted" style={{ marginTop: 0 }}>
            {!anyDoc ? <>Not explained yet. Dena will send this file's {p.pending.symbols} {p.pending.symbols === 1 ? "part" : "parts"}</>
              : <>{changed ? `${changed} changed` : ""}{changed && fresh ? " and " : ""}{fresh ? `${fresh} new` : ""}{changed || fresh ? ` ${changed + fresh === 1 ? "part" : "parts"} since the last explanation` : "The file's outline changed"}. Only {p.pending.symbols ? "those" : "the file page"} will be sent{p.pending.symbols && p.pending.fileDoc ? ", plus the file page" : ""}</>}
            {p.pending.estimate && <>: {tokenRange(p.pending.estimate.low, p.pending.estimate.high)}{p.pending.calls > 1 ? ` in ${p.pending.calls} calls` : ""}.</>}
            {p.pending.estimate && <span className="faint small" style={{ display: "block", marginTop: 4 }}>Token estimate {p.pending.estimate.calibrated ? "" : "uses "}{p.pending.estimate.basis}.</span>}
          </p>
          <span className="row">
            <ModelChoice value={runModel} onChange={setRunModel} projectDefault={p.settings.model} />
            <button className="btn primary" disabled={busy} onClick={() => explain()}>{anyDoc ? `Explain ${p.pending.symbols ? `${p.pending.symbols} ${p.pending.symbols === 1 ? "change" : "changes"}` : "the file page"}` : "Explain this file"}</button>
          </span>
        </div>
      )}

      {anyDoc && (
        <div className="ai-notice"><b>AI-written reading of the code. It can be wrong.</b> Each explanation sits next to the code it describes so you can check it.
          "How the AI built this" is counted from captured events, not written by AI.</div>
      )}

      {p.fileDoc && (
        <>
          {!p.fileDoc.current && <div className="notice" style={{ marginBottom: 12 }}>This overview was written for an earlier version of the file.</div>}
          <p className="step-summary">{p.fileDoc.doc.purpose}</p>
          <section className="step-section">
            <h3>How it fits in</h3>
            <ul className="plain">{p.fileDoc.doc.fitsIn.map((x, i) => <li key={i}>{x}</li>)}</ul>
            <div className="code-links">
              {p.links.importedBy.length > 0 && <div><span className="faint small">Used by</span> {p.links.importedBy.map(fileLink)}</div>}
              {p.links.imports.local.length > 0 && <div><span className="faint small">Uses</span> {p.links.imports.local.map(fileLink)}</div>}
              {p.links.imports.packages.length > 0 && <div><span className="faint small">Packages</span> {p.links.imports.packages.map((x) => <code key={x}>{x}</code>)}</div>}
            </div>
          </section>
          {p.fileDoc.doc.learn.length > 0 && (
            <section className="step-section">
              <h3>What you can learn here</h3>
              <div className="concepts">{p.fileDoc.doc.learn.map((c) => <div key={c.concept} className="concept"><b>{c.concept}</b><span>{c.explanation}</span></div>)}</div>
              <p className="faint small">General programming knowledge, not claims about this project.</p>
            </section>
          )}
          {p.fileDoc.doc.readingOrder.length > 0 && (
            <section className="step-section">
              <h3>Where to start reading</h3>
              <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>{p.fileDoc.doc.readingOrder.map((k, i) => <button key={k} className="chip" onClick={() => goSym(k)}>{i + 1}. {k}</button>)}</div>
            </section>
          )}
        </>
      )}

      <section className="step-section">
        <h3>Inside the file</h3>
        {p.symbols.map((s) => <SymbolCard key={s.key} s={s} lines={lines} onEvent={onEvent} />)}
      </section>

      <section className="step-section">
        <h3>How the AI built this</h3>
        {p.history.entries.length === 0 ? <p className="muted">No captured activity touched this file. It may predate recording, or was changed while Dena was not recording.</p> : (
          <>
            <p className="muted small" style={{ marginTop: 0 }}>
              {p.history.created ? `${p.history.created.who === "ai" ? "The AI created it" : "Created"} ${when(p.history.created.at)}. ` : "Created before Dena started recording. "}
              {p.history.aiEdits} AI {p.history.aiEdits === 1 ? "edit" : "edits"} in {p.history.sessions} {p.history.sessions === 1 ? "session" : "sessions"} · {p.history.commits} {p.history.commits === 1 ? "commit" : "commits"}
            </p>
            <ol className="activity">
              {p.history.entries.map((e, i) => (
                <li key={i} className={`act ${e.kind}`} role="button" tabIndex={0} onClick={() => onEvent(e.eventIds[0]!)} onKeyDown={(k) => (k.key === "Enter" || k.key === " ") && onEvent(e.eventIds[0]!)}>
                  <span className="act-time mono">{when(e.at)}</span>
                  <span className="act-icon" aria-hidden>{e.kind === "prompt" ? "›" : e.kind === "edit" ? "✎" : e.kind === "commit" ? "◆" : e.kind === "note" ? "✱" : "·"}</span>
                  <span className="act-body"><span className="act-who">{WHO[e.who] ?? e.who}</span> {e.text}{e.detail && <span className="act-detail">{e.detail}</span>}</span>
                </li>
              ))}
            </ol>
          </>
        )}
      </section>

      <footer className="step-foot">
        {p.usage.calls > 0 ? `${p.usage.calls} model ${p.usage.calls === 1 ? "call" : "calls"} for this file${tokenLine(p.usage.tokens) ? ` · ${tokenLine(p.usage.tokens)}` : ""}` : "No model calls for this file yet"}
        {p.fileDoc?.model ? ` · overview by ${p.fileDoc.model}` : ""}
      </footer>
      {anyDoc && (
        <div className="explain-more">
          <span className="muted">Explain the whole file again. Stronger models are more careful and use more of your plan.</span>
          <ModelChoice value={runModel} onChange={setRunModel} projectDefault={p.settings.model} />
          <button className="btn" disabled={busy} onClick={() => explain(true)}>Re-explain all</button>
          <button className="btn" onClick={exportMd}>Export (.md)</button>
        </div>
      )}
    </div>
  );
}

function SymbolCard({ s, lines, onEvent }: { s: Sym; lines: string[]; onEvent: (id: number) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <article id={symId(s.key)} className={`sym ${s.status}`}>
      <header className="sym-head">
        <span className="mono sym-name">{s.key}</span>
        <Badge>{KIND_LABEL[s.kind] ?? s.kind}</Badge>
        <span className="faint small">{s.ranges.length > 1 ? `${s.ranges.length} places` : s.startLine === s.endLine ? `line ${s.startLine}` : `lines ${s.startLine}–${s.endLine}`}</span>
        {s.status === "changed" && <Badge tone="warn" title="The code changed after this was written; the explanation below is for the earlier version">changed since explained</Badge>}
        {s.status === "new" && <Badge tone="muted">not explained yet</Badge>}
        {s.aiEdits > 0 && <button className="linkish small" onClick={() => onEvent(s.editEventIds[0]!)} title="Open the first captured edit">edited {s.aiEdits}× by the AI</button>}
      </header>
      {s.doc && (
        <div className={s.status === "changed" ? "sym-old" : undefined}>
          <p className="sym-summary">{s.doc.summary}</p>
          {s.doc.how.length > 0 && <ol className="sym-how">{s.doc.how.map((x, i) => <li key={i}>{x}</li>)}</ol>}
          {s.doc.watch.length > 0 && <ul className="sym-watch">{s.doc.watch.map((x, i) => <li key={i}>{x}</li>)}</ul>}
          {s.doc.learn.length > 0 && <div className="concepts">{s.doc.learn.map((c) => <div key={c.concept} className="concept"><b>📘 {c.concept}</b><span>{c.explanation}</span></div>)}</div>}
        </div>
      )}
      <button className="linkish small" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? "Hide code" : "Show code"}</button>
      {open && (
        <pre className="code-view">
          {s.ranges.map(([a, b], ri) => (
            <div key={ri} className="code-range">
              {lines.slice(a - 1, b).map((l, i) => <div key={i} className="code-line"><span className="ln">{a + i}</span><span>{l || " "}</span></div>)}
            </div>
          ))}
        </pre>
      )}
    </article>
  );
}
