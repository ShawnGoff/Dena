import { useEffect, useState } from "react";
import { api } from "../api";

/** What is true for the whole project's guide, said once instead of on every page. */
export function AboutGuide({ projectId }: { projectId: string }) {
  const [limits, setLimits] = useState<string[] | null>(null);
  useEffect(() => {
    api<{ limitations: string[] }>(`projects/${projectId}/about`).then((r) => setLimits(r.limitations), () => setLimits([]));
  }, [projectId]);
  if (!limits) return null;
  return (
    <details className="about-guide">
      <summary>About this guide</summary>
      <ul className="plain small">
        <li>Written by AI from captured evidence; it can be wrong. Labeled statements are not directly shown by the evidence.</li>
        {limits.map((l) => <li key={l}>{l}</li>)}
        <li>The file watcher and git don't record who made a change. Where Dena connects a change to the AI, it is shown as likely, not certain.</li>
      </ul>
    </details>
  );
}
