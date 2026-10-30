import { useState } from "react";

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

/**
 * Per-run model choice. It reads as the model that will be used ("Writes with Sonnet"); the
 * dropdown appears only when you choose to change it for this one run, so it does not look like
 * a second copy of the project setting.
 */
export function ModelChoice({ value, onChange, projectDefault }: { value: string; onChange: (m: string) => void; projectDefault: string | null }) {
  const [open, setOpen] = useState(false);
  const name = (m: string) => m[0]!.toUpperCase() + m.slice(1);
  if (!open && !value)
    return (
      <span className="model-choice faint small">
        Writes with <b className="model-name">{projectDefault ? name(projectDefault) : "your Claude Code default"}</b>
        {" · "}<button className="linkish small" onClick={() => setOpen(true)}>change for this run</button>
      </span>
    );
  return (
    <label className="model-choice">
      <span className="faint small">This run writes with</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} autoFocus={open && !value}>
        <option value="">{projectDefault ? `the project default (${name(projectDefault)})` : "the project default"}</option>
        <option value="haiku">Haiku (cheapest)</option>
        <option value="sonnet">Sonnet</option>
        <option value="opus">Opus (most precise)</option>
      </select>
      <button className="linkish small" onClick={() => { onChange(""); setOpen(false); }}>reset</button>
    </label>
  );
}
