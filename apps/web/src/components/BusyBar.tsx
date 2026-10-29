/**
 * Shown while a model is writing. Stop ends the model call itself; nothing from it is saved.
 * Tokens the call already used are not reported back, so they won't appear in usage figures.
 */
export function BusyBar({ what, onStop, stopping }: { what: string; onStop: () => void; stopping: boolean }) {
  return (
    <div className="notice busy-bar" role="status">
      <span className="spinner" aria-hidden /> {what}… this can take a minute.
      <button className="btn danger" disabled={stopping} onClick={onStop}>{stopping ? "Stopping…" : "Stop"}</button>
    </div>
  );
}

/** Per-run model choice: the project's default, or a specific model for just this run. */
export function ModelChoice({ value, onChange, projectDefault }: { value: string; onChange: (m: string) => void; projectDefault: string | null }) {
  return (
    <label className="model-choice">
      <span className="faint small">Write with</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{projectDefault ? `Project default (${projectDefault})` : "Project default"}</option>
        <option value="haiku">Haiku (cheapest)</option>
        <option value="sonnet">Sonnet</option>
        <option value="opus">Opus (most precise)</option>
      </select>
    </label>
  );
}
