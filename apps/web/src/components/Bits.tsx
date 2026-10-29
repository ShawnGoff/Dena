import type { ReactNode } from "react";
import type { EventLite } from "../api";
import { ACTOR_LABEL, CONFIDENCE_HELP, TYPE_LABEL, timeOnly, tone } from "../format";

export function Badge({ tone = "muted", children, title }: { tone?: string; children: ReactNode; title?: string }) {
  return (
    <span className={`badge ${tone}`} title={title}>
      {children}
    </span>
  );
}

export function EventRow({ e, selected, onClick, showDate }: { e: EventLite; selected?: boolean; onClick: () => void; showDate?: boolean }) {
  const t = tone(e);
  return (
    <div className={`ev ${selected ? "selected" : ""} ${e.notable ? "" : "dim"}`} onClick={onClick} role="button" tabIndex={0}
      onKeyDown={(k) => (k.key === "Enter" || k.key === " ") && onClick()}>
      <span className="t">{showDate ? new Date(e.at).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : timeOnly(e.at)}</span>
      <span className="type">
        <Badge tone={t}>{TYPE_LABEL[e.type] ?? e.type}</Badge>
      </span>
      <span className="s" title={e.summary}>
        {e.summary}
      </span>
      <span className="end">
        {e.confidence !== "observed" && (
          <Badge tone="warn" title={CONFIDENCE_HELP[e.confidence]}>
            {e.confidence}
          </Badge>
        )}{" "}
        <span className="faint" style={{ fontSize: 12 }}>
          {ACTOR_LABEL[e.actor] ?? e.actor}
        </span>
      </span>
    </div>
  );
}

export function Loading() {
  return <div className="empty">Loading…</div>;
}
