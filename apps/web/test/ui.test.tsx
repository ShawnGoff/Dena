// @vitest-environment jsdom
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Store } from "@dena/core";
import { startServer, type RunningServer } from "../../../packages/server/src/server.ts";
import type { GenerateResult, Provider } from "@dena/engine";
import { Guide } from "../src/views/Guide";
import { Recording } from "../src/App";
import type { Project } from "../src/api";

/**
 * The web app against a real Dena server and store (with a fake model), so these clicks exercise
 * the same requests and state refreshes the owner's do.
 */

class FakeProvider implements Provider {
  name = "fake";
  async generate(): Promise<GenerateResult> {
    return { json: { title: "Added a quaternion helper", summary: "s", whatHappened: [{ text: "The user asked for it.", kind: "observed", evidence: ["E1"] }],
      whyItMattered: [], howItWorks: [], decisions: [], concepts: [], uncertainty: [] }, model: "fake", costUsd: 0, durationMs: 1 };
  }
}

let home: string;
let root: string;
let claudeHome: string;
let store: Store;
let srv: RunningServer;
let pid: string;
let ep: string;
const realFetch = globalThis.fetch;
const post = (p: string, body: unknown, project = pid) =>
  realFetch(`http://127.0.0.1:${srv.port}/api/projects/${project}/${p}`, { method: "POST", headers: { "x-dena-token": srv.token, "content-type": "application/json" }, body: JSON.stringify(body) })
    .then((r) => r.json());
const get = (p: string) => realFetch(`http://127.0.0.1:${srv.port}/api/projects/${pid}/${p}`, { headers: { "x-dena-token": srv.token } }).then((r) => r.json());

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "dena-ui-"));
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dena-ui-root-")));
  claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), "dena-ui-claude-")); // keep away from real transcripts
  store = new Store(home);
  pid = store.createProject("demo", "/nonexistent/demo").id;
  store.ingest(pid, {
    sessions: [], artifacts: [], gaps: [], links: [],
    events: [
      { sessionId: null, source: "t", sourceEventId: "p1", eventType: "prompt_submitted", occurredAt: "2026-10-01T10:00:00Z", actor: "user", summary: "Add a quaternion helper", payload: { text: "Add a quaternion helper" }, captureConfidence: "observed" },
      { sessionId: null, source: "t", sourceEventId: "f1", eventType: "file_modified", occurredAt: "2026-10-01T10:01:00Z", actor: "ai_agent", summary: "Modified src/math.ts", payload: { file: "src/math.ts" }, captureConfidence: "observed" },
    ],
  });
  srv = await startServer(store, { port: 0, provider: new FakeProvider(), recorder: { claudeHome, transcriptScope: "own" } });
  // The page calls "/api/…" on its own origin; send those to the test server with its key.
  globalThis.fetch = ((url: string, init: RequestInit = {}) =>
    realFetch(`http://127.0.0.1:${srv.port}${url}`, { ...init, headers: { ...(init.headers as Record<string, string>), "x-dena-token": srv.token } })) as typeof fetch;
  ep = (await get("episodes"))[0].id;
  await post(`episodes/${ep}/explain`, {});
});
afterEach(cleanup);
afterAll(async () => {
  globalThis.fetch = realFetch;
  await srv.close();
  store.close();
  for (const d of [home, root, claudeHome]) fs.rmSync(d, { recursive: true, force: true });
});

const toc = () => screen.getByRole("navigation", { name: "Walkthrough" });
const renderGuide = () => render(<Guide projectId={pid} openEpisode={ep} onEpisode={() => {}} onEvent={() => {}} />);

describe("the Guide after changes to a step", () => {
  it("shows a restored version's title in the step list, and shows it as the current version", async () => {
    const doc = await get(`doc?type=step&key=${ep}`);
    await post("doc/edit", { type: "step", key: ep, baseId: doc.active.id, content: { ...doc.active.content, title: "My own title" } });
    renderGuide();
    await waitFor(() => expect(within(toc()).getByText("My own title")).toBeTruthy());

    fireEvent.click(await screen.findByText(/Show history/));
    const original = screen.getAllByText(/^AI$/)[0]!.closest(".history-row") as HTMLElement;
    fireEvent.click(within(original).getByText("View"));
    fireEvent.click(within(original).getByText("Restore"));
    await waitFor(() => expect(within(toc()).getByText("Added a quaternion helper")).toBeTruthy());
    await waitFor(() => expect(screen.getByText(/what happened, step by step/)).toBeTruthy()); // back on the current version, not the old one
  });

  it("leaves the AI update's preview once it is adopted", async () => {
    const doc = await get(`doc?type=step&key=${ep}`);
    await post("doc/edit", { type: "step", key: ep, baseId: doc.active.id, content: { ...doc.active.content, title: "Edited again" } });
    await post(`episodes/${ep}/explain`, { force: true }); // lands as a proposal: the step holds the owner's edit
    renderGuide();
    fireEvent.click(await screen.findByText("Show the AI update"));
    await waitFor(() => expect(screen.queryByText(/what happened, step by step/)).toBeNull());
    fireEvent.click(screen.getByText("Use the AI update"));
    await waitFor(() => expect(screen.queryByText("Use the AI update")).toBeNull());
    await waitFor(() => expect(screen.getByText(/what happened, step by step/)).toBeTruthy());
    await waitFor(() => expect(within(toc()).getByText("Added a quaternion helper")).toBeTruthy());
  });
});

describe("pausing", () => {
  it("is private from the click: the server records when the pause began", async () => {
    const live = store.createProject("live", root).id;
    await post("recording", { action: "start" }, live);
    const project = { id: live, name: "live", rootPath: root, recordingState: "recording", recorderRunning: true, recorderHere: true } as unknown as Project;
    let changed = 0;
    render(<Recording project={project} onChange={() => changed++} />);
    const before = new Date().toISOString();
    fireEvent.click(screen.getByText("Pause"));
    await screen.findByText(/Paused\. Nothing is captured/);
    expect(changed).toBe(1);
    expect(store.getProject(live)!.recordingState).toBe("paused");
    expect(store.getCursor(live, "dena", "paused_at")! >= before).toBe(true);
    await post("recording", { action: "stop" }, live);
  });
});
