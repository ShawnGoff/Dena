import { useCallback, useEffect, useState } from "react";
import { api } from "../api";

type Settings = { model: string | null; depth: "concise" | "thorough"; auth: "account" | "api-key" };
type Auth = { found: boolean; loggedIn: boolean; method: string | null; detail: string };

const CHANGED = "dena:settings-changed";

/** Runs `reload` when the project's model settings change, so an open page shows the model and estimate that will really be used. */
export function useSettingsChanged(reload: () => void) {
  useEffect(() => {
    const h = () => reload();
    window.addEventListener(CHANGED, h);
    return () => window.removeEventListener(CHANGED, h);
  }, [reload]);
}

/** Which model writes new explanations and pages, how deep they go, and how Dena signs in. Saved per project. */
export function ModelSettings({ projectId }: { projectId: string }) {
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
    window.dispatchEvent(new Event(CHANGED));
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
          <option value="account">Claude account (plan)</option>
          <option value="api-key">API key (credits)</option>
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

