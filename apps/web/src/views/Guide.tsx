import { useCallback, useEffect, useState } from "react";
import { api, type Episode, type ExplanationInfo } from "../api";
import { Badge, Loading } from "../components/Bits";
import { StepView } from "../components/StepView";
import { when } from "../format";

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
  const list = onlyChanges ? eps.filter((e) => e.stats.fileChanges || e.stats.commits || e.stats.tests || e.explained || e.id === openEpisode) : eps;
  const current = eps.find((e) => e.id === openEpisode) ?? list[0] ?? eps[0]!;
  const markExplained = (id: string) => setEps((all) => all?.map((e) => (e.id === id ? { ...e, explained: true } : e)) ?? null);

  return (
    <div className="guide">
      <nav className="toc" aria-label="Walkthrough">
        <ModelSettings projectId={projectId} />
        <label className="toggle" style={{ padding: "0 8px 10px" }}>
          <input type="checkbox" checked={onlyChanges} onChange={(e) => setOnlyChanges(e.target.checked)} /> only episodes that changed something
        </label>
        {list.map((e) => (
          <button key={e.id} className={`toc-item ${e.id === current.id ? "active" : ""}`} onClick={() => onEpisode(e.id)}>
            <span className="faint mono">#{e.position}</span>
            <span className="toc-title">{e.title}</span>
            {e.explained && <span className="toc-done" title="Explained">●</span>}
          </button>
        ))}
      </nav>
      <div className="guide-main">
        <EpisodeStep key={current.id} projectId={projectId} ep={current} onEvent={onEvent} onExplained={() => markExplained(current.id)} />
      </div>
    </div>
  );
}

function EpisodeStep({ projectId, ep, onEvent, onExplained }: { projectId: string; ep: Episode; onEvent: (id: number) => void; onExplained: () => void }) {
  const [info, setInfo] = useState<ExplanationInfo | null>(null);
  const [which, setWhich] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => api<ExplanationInfo>(`projects/${projectId}/episodes/${ep.id}/explanation`).then((i) => {
    setInfo(i);
    setWhich(0);
  }, (e) => setErr(String(e.message))), [projectId, ep.id]);
  useEffect(() => {
    load();
  }, [load]);

  const explain = async (model?: string, force = false) => {
    setBusy(model ?? "default");
    setErr(null);
    try {
      await api(`projects/${projectId}/episodes/${ep.id}/explain`, { method: "POST", body: { model, force } });
      onExplained();
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (!info) return err ? <div className="error">{err}</div> : <Loading />;
  const x = info.explanations[which];
  const est = info.estimate;
  const modelName = info.settings.model ?? "your default model";
  const cost = est.estimatedUsd !== null ? `about $${est.estimatedUsd.toFixed(3)} est. usage` : "usage estimate not available yet";
  const s = ep.stats;

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
      {err && <div className="error">{err}</div>}

      {!x && (
        <div className="explain-card">
          <h2 className="step-title" style={{ marginTop: 0 }}>{ep.title}</h2>
          {est.factsOnly ? (
            <p className="muted">This episode changed nothing, so Dena can summarise it from the captured messages without using a model.</p>
          ) : (
            <p className="muted">Not explained yet. Dena will send this episode's evidence (about {Math.round(est.inputChars / 1000)}k characters, secrets removed) to <b>{modelName}</b>: {cost}.</p>
          )}
          <button className="btn primary" disabled={!!busy} onClick={() => explain()}>{busy ? "Explaining… this can take a minute" : est.factsOnly ? "Summarise" : "Explain this episode"}</button>
        </div>
      )}

      {x && (
        <>
          {info.explanations.length > 1 && (
            <div className="versions">
              {info.explanations.map((v, i) => (
                <button key={i} className={`tab ${i === which ? "active" : ""}`} onClick={() => setWhich(i)}>
                  {v.step.generatedBy === "facts" ? "Facts" : v.model ?? v.requestedModel}{v.stale ? " · outdated" : ""}
                </button>
              ))}
            </div>
          )}
          <StepView x={x} onRef={onEvent} />
          {x.step.generatedBy !== "facts" && (
            <div className="explain-more">
              <span className="muted">Want a more precise explanation? Stronger models cost more usage.</span>
              {STRONGER.map((m) => (
                <button key={m.model} className="btn" disabled={!!busy} onClick={() => explain(m.model, true)}>
                  {busy === m.model ? `Explaining with ${m.label}…` : `Explain with ${m.label}`}
                </button>
              ))}
              {x.stale && <button className="btn primary" disabled={!!busy} onClick={() => explain(undefined, true)}>{busy === "default" ? "Explaining…" : "Update with new evidence"}</button>}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Which model writes new explanations, and how deep they go. Saved per project. */
type Settings = { model: string | null; depth: "concise" | "thorough"; auth: "account" | "api-key" };
type Auth = { found: boolean; loggedIn: boolean; method: string | null; detail: string };

function ModelSettings({ projectId }: { projectId: string }) {
  const [s, setS] = useState<Settings | null>(null);
  const [auth, setAuth] = useState<Auth | null>(null);
  const loadAuth = useCallback(() => api<Auth>(`projects/${projectId}/auth`).then(setAuth, () => {}), [projectId]);
  useEffect(() => {
    api<Settings>(`projects/${projectId}/settings`).then(setS, () => {});
    loadAuth();
  }, [projectId, loadAuth]);
  if (!s) return null;
  const save = (patch: Partial<Settings>) => api<Settings>(`projects/${projectId}/settings`, { method: "POST", body: patch }).then((n) => {
    setS(n);
    if ("auth" in patch) loadAuth();
  }, () => {});
  const known = ["haiku", "sonnet", "opus"];
  return (
    <div className="settings-box">
      <label>
        <span className="faint">Model</span>
        <select value={s.model ?? ""} onChange={(e) => save({ model: e.target.value || null })}>
          <option value="">Your Claude Code default</option>
          <option value="haiku">Haiku (cheapest)</option>
          <option value="sonnet">Sonnet</option>
          <option value="opus">Opus (most precise)</option>
          {s.model && !known.includes(s.model) && <option value={s.model}>{s.model}</option>}
        </select>
      </label>
      <label>
        <span className="faint">Depth</span>
        <select value={s.depth} onChange={(e) => save({ depth: e.target.value as "concise" | "thorough" })}>
          <option value="concise">Concise (less usage)</option>
          <option value="thorough">Thorough</option>
        </select>
      </label>
      <label>
        <span className="faint">Sign-in</span>
        <select value={s.auth} onChange={(e) => save({ auth: e.target.value as Settings["auth"] })}>
          <option value="account">Claude account (subscription)</option>
          <option value="api-key">API key (billed credits)</option>
        </select>
      </label>
      {auth && (
        <p className={auth.loggedIn && auth.method !== "api_key" ? "faint" : "auth-warn"} style={{ fontSize: 11.5, margin: "4px 0 0" }}>
          {auth.detail}
        </p>
      )}
    </div>
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
