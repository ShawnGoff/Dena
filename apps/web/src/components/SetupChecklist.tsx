import { useEffect, useState } from "react";
import { api } from "../api";

interface SetupStep { id: string; label: string; required: boolean; done: boolean; detail: string }

/**
 * The first-run checklist. It stays until the required steps are done; the optional capture step
 * stays listed after that only on the Overview, where capture sources are already shown.
 */
export function SetupChecklist() {
  const [setup, setSetup] = useState<{ steps: SetupStep[]; ready: boolean } | null>(null);
  useEffect(() => {
    api<{ steps: SetupStep[]; ready: boolean }>("setup").then(setSetup, () => setSetup(null));
  }, []);
  if (!setup || setup.ready) return null;
  return (
    <div className="card" style={{ maxWidth: 640, margin: "0 auto 16px" }}>
      <h2>First run</h2>
      <ol style={{ listStyle: "none", paddingLeft: 0, margin: 0 }}>
        {setup.steps.map((s) => (
          <li key={s.id} style={{ display: "flex", gap: 10, padding: "6px 0" }}>
            <span aria-hidden="true" style={{ width: 16, flexShrink: 0 }}>{s.done ? "✓" : s.required ? "○" : "·"}</span>
            <span>
              <b>{s.label}</b>{!s.required && <span className="faint"> (optional)</span>}
              <br /><span className="faint" style={{ fontSize: 12.5 }}>{s.done ? "Done. " : ""}{s.detail}</span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
