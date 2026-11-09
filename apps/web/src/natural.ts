import { useCallback, useEffect, useState } from "react";
import { api, apiBlob } from "./api";

/** The optional natural voice, as the server reports it. */
export interface NaturalStatus {
  state: "off" | "installing" | "ready" | "error";
  step: string | null;
  percent: number | null;
  error: string | null;
  sizeBytes: number | null;
  dir: string;
  voices: Record<string, string>;
  approxMb: number;
}

/** Status of the natural voice plus the actions that change it; polls while it installs. */
export function useNaturalVoice() {
  const [status, setStatus] = useState<NaturalStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const refresh = useCallback(() => api<NaturalStatus>("voice").then(setStatus, () => setStatus(null)), []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (status?.state !== "installing") return;
    const t = setInterval(() => void refresh(), 1000);
    return () => clearInterval(t);
  }, [status?.state, refresh]);
  const act = useCallback((a: "install" | "cancel" | "remove") => {
    setErr(null);
    return api<NaturalStatus>(`voice/${a}`, { method: "POST", body: {} }).then(setStatus, (e) => setErr((e as Error).message));
  }, []);
  return { status, err, refresh, install: () => act("install"), cancel: () => act("cancel"), remove: () => act("remove") };
}

/** Speech for one piece of text, as an object URL the caller must revoke. */
export async function naturalClip(text: string, voice: string): Promise<string> {
  return URL.createObjectURL(await apiBlob("voice/speak", { text, voice }));
}
