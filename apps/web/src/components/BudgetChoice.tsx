import { useEffect, useState } from "react";
import { api } from "../api";

const BUDGETS = [50_000, 100_000, 200_000, 500_000];

/**
 * How much one big job may spend before it stops (explaining many steps or a folder, the update
 * queue). Shown where such a job starts, not in the general settings. The choice is saved as the
 * project's default, so the next big job and the command line use it too.
 */
export function BudgetChoice({ projectId, onChange }: { projectId: string; onChange?: (tokens: number | null) => void }) {
  const [value, setValue] = useState<number | null | undefined>(undefined);
  useEffect(() => {
    api<{ maxTokensPerRun: number | null }>(`projects/${projectId}/settings`).then((s) => {
      setValue(s.maxTokensPerRun);
      onChange?.(s.maxTokensPerRun);
    }, () => setValue(null));
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (value === undefined) return null;
  const save = (v: number | null) => {
    setValue(v);
    onChange?.(v);
    void api(`projects/${projectId}/settings`, { method: "POST", body: { maxTokensPerRun: v } }).catch(() => {});
  };
  return (
    <label className="model-choice" title="Saved as this project's default for big jobs. Each finished step is kept; what is left waits for the next run.">
      <span className="faint small">Stop at about</span>
      <select value={value ?? ""} onChange={(e) => save(e.target.value ? Number(e.target.value) : null)}>
        <option value="">no limit</option>
        {BUDGETS.map((b) => <option key={b} value={b}>{b / 1000}k tokens</option>)}
        {value != null && !BUDGETS.includes(value) && <option value={value}>{Math.round(value / 1000)}k tokens</option>}
      </select>
    </label>
  );
}
