import { useEffect, useState } from "react";
import type { NaturalStatus } from "../natural";

const mb = (n: number | null) => (n == null ? "" : n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`);

/**
 * Asks before anything is downloaded, says what will be stored and where, and shows progress.
 * Also where an installed voice is removed.
 */
export function NaturalVoiceDialog({ status, err, onInstall, onCancel, onRemove, onClose }: {
  status: NaturalStatus; err: string | null; onInstall: () => void; onCancel: () => void; onRemove: () => void; onClose: () => void;
}) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && status.state !== "installing" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [status.state, onClose]);
  const s = status.state;
  const [sure, setSure] = useState(false);
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Natural voice">
      <div className="modal">
        <h2>Natural voice</h2>
        {(s === "off" || s === "error") && (
          <>
            <p>A small speech model (Kokoro) that runs on this computer and sounds much more natural than the built-in voices.</p>
            <ul className="plain">
              <li>Downloads about <b>{status.approxMb} MB</b> once: the speech runtime from npm and the model from Hugging Face.</li>
              <li>Stored in <code>{status.dir}</code>. Removing it deletes that folder.</li>
              <li><b>Your text never leaves this computer.</b> Only the download uses the network.</li>
              <li>Uses your processor while it speaks, and starts a little slower than the built-in voices.</li>
            </ul>
            {(s === "error" ? status.error : err) && <div className="error">{s === "error" ? status.error : err}</div>}
            <div className="row modal-actions">
              <button className="btn primary" onClick={onInstall}>{s === "error" ? "Try again" : `Download ${status.approxMb} MB and turn on`}</button>
              <button className="btn" onClick={onClose}>Not now</button>
            </div>
          </>
        )}
        {s === "installing" && (
          <>
            <p>{status.step ?? "Working…"}{status.percent != null ? ` · ${status.percent}%` : ""}</p>
            <div className="progress" role="progressbar" aria-valuenow={status.percent ?? undefined} aria-valuemin={0} aria-valuemax={100}>
              <span style={{ width: `${status.percent ?? 8}%` }} className={status.percent == null ? "indeterminate" : undefined} />
            </div>
            <p className="faint small">The first step can take a minute or two. You can keep using Dena meanwhile; closing this window does not stop it.</p>
            <div className="row modal-actions">
              <button className="btn" onClick={onCancel}>Stop</button>
              <button className="btn" onClick={onClose}>Hide</button>
            </div>
          </>
        )}
        {s === "ready" && (
          <>
            <p>The natural voice is installed ({mb(status.sizeBytes)} in <code>{status.dir}</code>). Choose it in the player's Voice menu.</p>
            {err && <div className="error">{err}</div>}
            <div className="row modal-actions">
              <button className="btn" onClick={onClose}>Close</button>
              {sure
                ? <button className="btn danger" onClick={onRemove}>Yes, delete {mb(status.sizeBytes)}</button>
                : <button className="btn danger" onClick={() => setSure(true)}>Remove natural voice…</button>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
