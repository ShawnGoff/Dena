import { useCallback, useEffect, useState } from "react";
import { api, type Claim, type Episode, type ExplanationInfo, type Step, type StoredExplanation } from "../api";
import { DocBar, type DocResponse } from "../components/DocBar";
import { HowBuilt } from "../components/HowBuilt";
import { useSettingsChanged } from "../components/ModelSettings";
import { AboutGuide } from "../components/AboutGuide";
import { ModelSettings } from "../components/ModelSettings";
import { BusyBar } from "../components/BusyBar";
import { Badge, Loading } from "../components/Bits";
import { StepView } from "../components/StepView";
import { tokenRange, when } from "../format";

const STRONGER = [
  { model: "sonnet", label: "Sonnet" },
  { model: "opus", label: "Opus" },
];

/**
 * The walkthrough: episodes in order on the left, the selected step on the right. Nothing is
 * generated until the reader asks, and every request shows what it will use first.
 */
export function Guide({ projectId, openEpisode, onEpisode, onEvent }: {
  projectId: string; openEpisode: string | null; onEpisode: (id: string) => void; onEvent: (id: number) => void;
}) {
  const [eps, setEps] = useState<Episode[] | null>(null);
  const [onlyChanges, setOnlyChanges] = useState(true);
  useEffect(() => {
    api<Episode[]>(`projects/${projectId}/episodes`).then(setEps, () => setEps([]));
  }, [projectId]);

  if (!eps) return <Loading />;
  if (!eps.length) return <div className="empty"><b>Nothing to explain yet</b>Record some work first.</div>;
  // Steps worth following change something; questions and "yes, go ahead" do not.
  const list = onlyChanges ? eps.filter((e) => e.stats.fileChanges || e.stats.commits || e.stats.tests || e.id === openEpisode) : eps;
  const current = eps.find((e) => e.id === openEpisode) ?? list[0] ?? eps[0]!;
  const markExplained = (id: string) => setEps((all) => all?.map((e) => (e.id === id ? { ...e, explained: true } : e)) ?? null);

  return (
    <div className="guide">
      <nav className="toc" aria-label="Walkthrough">
        <ModelSettings projectId={projectId} />
        <AboutGuide projectId={projectId} />
        <label className="toggle" style={{ padding: "0 8px 10px" }}>
          <input type="checkbox" checked={onlyChanges} onChange={(e) => setOnlyChanges(e.target.checked)} /> only steps that changed something
        </label>
        {list.map((e, i) => (
          <div key={e.id}>
            {e.chapter && e.chapter.key !== list[i - 1]?.chapter?.key && (
              <div className="chapter-head">
                <span>Chapter {chapterNo(list, i)} · {when(e.chapter.startedAt).replace(/,.*$/, "")}</span>
                {e.chapter.areas.length > 0 && <span className="mono faint">{e.chapter.areas.join(", ")}</span>}
              </div>
            )}
            <button className={`toc-item ${e.id === current.id ? "active" : ""}`} onClick={() => onEpisode(e.id)}>
              <span className="faint mono">#{e.position}</span>
              <span className="toc-title" title={e.stepTitle ? `You asked: ${e.title}` : undefined}>{e.stepTitle ?? e.title}</span>
              {e.explained && <span className="toc-done" style={e.instructions ? undefined : { color: "var(--text-faint)" }} title={e.instructions ? "Written as instructions" : "Explained as a story; open it to rewrite as instructions"}>●</span>}
            </button>
          </div>
        ))}
      </nav>
      <div className="guide-main">
        <EpisodeStep key={current.id} projectId={projectId} ep={current} onEvent={onEvent} onExplained={() => markExplained(current.id)} />
      </div>
    </div>
  );
}

/** Chapters are counted over the whole list shown, so numbers stay steady while you browse. */
function chapterNo(list: Episode[], i: number): number {
  let n = 0;
  for (let j = 0; j <= i; j++) if (list[j]!.chapter && list[j]!.chapter!.key !== list[j - 1]?.chapter?.key) n++;
  return n;
}

function EpisodeStep({ projectId, ep, onEvent, onExplained }: { projectId: string; ep: Episode; onEvent: (id: number) => void; onExplained: () => void }) {
  const [info, setInfo] = useState<ExplanationInfo | null>(null);
  const [doc, setDoc] = useState<DocResponse<Step> | null>(null);
  const [viewing, setViewing] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [i, d] = await Promise.all([
        api<ExplanationInfo>(`projects/${projectId}/episodes/${ep.id}/explanation`),
        api<DocResponse<Step>>(`projects/${projectId}/doc?type=step&key=${encodeURIComponent(ep.id)}`),
      ]);
      setInfo(i);
      setDoc(d);
    } catch (e) {
      setErr(String((e as Error).message));
    }
  }, [projectId, ep.id]);
  useEffect(() => {
    load();
  }, [load]);
  useSettingsChanged(load);

  const [stopping, setStopping] = useState(false);
  const stop = async () => {
    setStopping(true);
    await api(`projects/${projectId}/episodes/${ep.id}/stop`, { method: "POST", body: {} }).catch(() => {});
  };
  const explain = async (model?: string, force = false) => {
    setBusy(model ?? "default");
    setStopping(false);
    setErr(null);
    try {
      await api(`projects/${projectId}/episodes/${ep.id}/explain`, { method: "POST", body: { model, force } });
      onExplained();
      setViewing(null);
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const saveEdit = async (next: Step, note: string) => {
    if (!doc?.active) return;
    try {
      await api(`projects/${projectId}/doc/edit`, { method: "POST", body: { type: "step", key: ep.id, content: next, baseId: doc.active.id, note } });
    } catch (e) {
      setErr((e as Error).message);
    }
    await load();
  };
  const markIncorrect = (c: Claim, note: string) =>
    api(`projects/${projectId}/doc/note`, { method: "POST", body: { type: "step", key: ep.id, kind: "incorrect", target: c.text, text: note } }).catch((e) => setErr(String(e.message)));

  if (!info || !doc) return err ? <div className="error">{err}</div> : <Loading />;
  const est = info.estimate;
  const modelName = info.settings.model ?? "your default model";
  const cost = `${tokenRange(est.tokensLow, est.tokensHigh)} (the high end if the checks ask for a repair)`
    + `${est.estimatedUsd !== null ? ` (API-equivalent about $${est.estimatedUsd.toFixed(3)})` : ""}`;
  const s = ep.stats;
  // What to show: an older or proposed version the reader chose to look at, else the active one.
  const shownRev = viewing != null
    ? (doc.proposed?.id === viewing ? doc.proposed : null)
    : doc.active;
  const historical = viewing != null && !shownRev;
  const x = shownRev ? toExplanation(shownRev, doc.stale && shownRev === doc.active) : null;

  return (
    <div className="page" style={{ maxWidth: 820 }}>
      <div className="step-head">
        <span className="faint mono">Episode #{ep.position} · {when(ep.startedAt)}</span>
        <div className="episode-meta">
          {s.fileChanges > 0 && <Badge tone="ok">{plural(s.fileChanges, "file change")}</Badge>}
          {s.commits > 0 && <Badge tone="ok">{plural(s.commits, "commit")}</Badge>}
          {s.tests > 0 && <Badge tone={s.testFailures ? "bad" : "ok"}>{plural(s.tests, "test run")}{s.testFailures ? ` · ${s.testFailures} failed` : ""}</Badge>}
          {s.notes > 0 && <Badge tone="warn">{plural(s.notes, "agent note")}</Badge>}
        </div>
      </div>
      {busy && <BusyBar what={`Explaining${busy !== "default" ? ` with ${busy[0]!.toUpperCase() + busy.slice(1)}` : ""}`} onStop={stop} stopping={stopping} />}
      {err && <div className={err.startsWith("Stopped") ? "notice" : "error"}>{err}</div>}

      {!doc.active && (
        <div className="explain-card">
          <h2 className="step-title" style={{ marginTop: 0 }}>{ep.title}</h2>
          {est.factsOnly ? (
            <p className="muted">This episode changed nothing, so Dena can summarise it from the captured messages without using a model.</p>
          ) : (
            <p className="muted">Not explained yet. Dena will send this episode's evidence (secrets removed) to <b>{modelName}</b>: {cost}.
              <span className="faint small" style={{ display: "block", marginTop: 4 }}>Token estimate {est.tokensCalibrated ? "" : "uses "}{est.tokenBasis}.</span></p>
          )}
          <button className="btn primary" disabled={!!busy} onClick={() => explain()}>{busy ? "Explaining… this can take a minute" : est.factsOnly ? "Summarise" : "Explain this episode"}</button>
        </div>
      )}

      {doc.active && (
        <>
          <DocBar projectId={projectId} type="step" docKey={ep.id} doc={doc} onChanged={() => { onExplained(); load(); }} viewing={viewing} onView={setViewing} allowContext
            onRewrite={() => explain(undefined, true)} projectModel={info.settings.model} />
          {!viewing && x && x.step.generatedBy === "model" && !x.step.instructions?.length && !doc.proposed && (
            <div className="notice" style={{ marginBottom: 14 }}>
              This step was written as a story, before steps became instructions you can follow.{" "}
              <button className="btn" disabled={!!busy} onClick={() => explain(undefined, true)}>{busy ? "Rewriting…" : "Rewrite as instructions"}</button>
              <span className="faint small"> Uses about as many tokens as explaining it the first time. Your notes are used; your edits stay in the history.</span>
            </div>
          )}
          {historical && <HistoricalVersion projectId={projectId} docKey={ep.id} id={viewing!} onRef={onEvent} />}
          {x && <StepView x={x} onRef={onEvent} editable={!viewing} onChange={saveEdit} onMarkIncorrect={markIncorrect} />}
          {!viewing && <HowBuilt projectId={projectId} type="step" docKey={ep.id} onEvent={onEvent} />}
          {!viewing && x?.step.generatedBy !== "facts" && (
            <div className="explain-more">
              <span className="muted">Want a more precise explanation? Stronger models use more of your plan.</span>
              {STRONGER.map((m) => (
                <button key={m.model} className="btn" disabled={!!busy} onClick={() => explain(m.model, true)}>
                  {busy === m.model ? `Explaining with ${m.label}…` : `Explain with ${m.label}`}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Shapes a stored revision like an explanation, so the step view can render either. */
function toExplanation(r: { content: Step; meta: Record<string, any>; createdAt: string }, stale: boolean): StoredExplanation {
  const m = r.meta;
  return { unitId: "", step: r.content, validation: m.validation, evidence: m.evidence ?? {}, model: m.model ?? null, requestedModel: m.requestedModel ?? "",
    costUsd: m.costUsd ?? null, tokens: m.tokens ?? null, attempts: m.attempts ?? 1, batched: !!m.batched, depth: m.depth ?? "thorough", createdAt: r.createdAt, stale };
}

/** Read-only view of an older revision picked from the history. */
function HistoricalVersion({ projectId, docKey, id, onRef }: { projectId: string; docKey: string; id: number; onRef: (id: number) => void }) {
  const [rev, setRev] = useState<{ content: Step; meta: Record<string, any>; createdAt: string } | null>(null);
  useEffect(() => {
    api<{ revision: { content: Step; meta: Record<string, any>; createdAt: string } }>(`projects/${projectId}/doc/revision?type=step&key=${encodeURIComponent(docKey)}&id=${id}`)
      .then((r) => setRev(r.revision), () => setRev(null));
  }, [projectId, docKey, id]);
  return rev ? <StepView x={toExplanation(rev, false)} onRef={onRef} /> : <Loading />;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
