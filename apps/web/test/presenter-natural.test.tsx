// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Presenter } from "../src/components/Presenter";

/** Fakes for the speech engine, the audio element and the server's /api/voice calls. */
class FakeUtterance { onend: (() => void) | null = null; onerror: (() => void) | null = null; constructor(public text: string) {} }
class FakeAudio {
  static all: FakeAudio[] = [];
  src = ""; playbackRate = 1; onended: (() => void) | null = null; onerror: (() => void) | null = null;
  played: string[] = [];
  constructor() { FakeAudio.all.push(this); }
  play() { this.played.push(this.src); return Promise.resolve(); }
  pause() {}
  removeAttribute() { this.src = ""; }
}

const status = (over: object = {}) => ({ state: "ready", step: null, percent: null, error: null, sizeBytes: 100e6, dir: "/home/x/.dena/voice", voices: { af_heart: "Heart (US, female)", bf_emma: "Emma (UK, female)" }, approxMb: 420, ...over });
let current: any;
let speakBodies: any[];
let posts: string[];
let speakFails: boolean;

beforeEach(() => {
  FakeAudio.all = [];
  speakBodies = [];
  posts = [];
  speakFails = false;
  current = status();
  (window as any).speechSynthesis = { speak: vi.fn(), cancel: vi.fn(), pause: vi.fn(), resume: vi.fn(), getVoices: () => [], addEventListener: vi.fn(), removeEventListener: vi.fn() };
  (window as any).SpeechSynthesisUtterance = FakeUtterance;
  (globalThis as any).Audio = FakeAudio;
  (URL as any).createObjectURL = vi.fn(() => `blob:${Math.random()}`);
  (URL as any).revokeObjectURL = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  globalThis.fetch = vi.fn(async (url: any, init: any) => {
    const u = String(url);
    const json = (b: unknown) => ({ ok: true, status: 200, json: async () => b });
    if (u === "/api/voice/speak") {
      speakBodies.push(JSON.parse(init.body));
      return speakFails ? { ok: false, status: 500, json: async () => ({ error: "boom" }) } : { ok: true, status: 200, blob: async () => new Blob(["wav"]) };
    }
    if (u === "/api/voice/install") { posts.push("install"); current = status({ state: "installing", step: "Downloading the voice model", percent: 40 }); return json(current); }
    if (u === "/api/voice/remove") { posts.push("remove"); current = status({ state: "off", sizeBytes: null }); return json(current); }
    if (u === "/api/voice") return json(current);
    throw new Error(`unexpected ${u}`);
  }) as any;
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  delete (window as any).speechSynthesis;
  delete (globalThis as any).Audio;
});

const segments = [{ text: "Title.", anchor: "title" }, { text: "First.", anchor: "a" }, { text: "Second.", anchor: "b" }];
const listen = async () => {
  render(<Presenter segments={segments} />);
  await waitFor(() => expect(screen.getByText(/Natural voice|Get a natural voice/)).toBeTruthy());
  fireEvent.click(screen.getByText(/Listen/));
};

describe("Presenter with the natural voice", () => {
  it("speaks through the server, prepares the next piece while one plays, and moves on when it ends", async () => {
    localStorage.setItem("dena.presenter.engine", "natural");
    await listen();
    await waitFor(() => expect(FakeAudio.all[0]?.played.length).toBe(1));
    expect(speakBodies.map((b) => b.text)).toEqual(["Title.", "First."]); // the next is already being prepared
    expect((window as any).speechSynthesis.speak).not.toHaveBeenCalled();
    await act(async () => { FakeAudio.all[0]!.onended!(); });
    await waitFor(() => expect(FakeAudio.all[0]!.played.length).toBe(2));
    expect(speakBodies.map((b) => b.text)).toEqual(["Title.", "First.", "Second."]);
    expect(speakBodies.every((b) => b.voice === "af_heart")).toBe(true);
  });

  it("changes speed on the playing clip without asking the server again", async () => {
    localStorage.setItem("dena.presenter.engine", "natural");
    await listen();
    await waitFor(() => expect(FakeAudio.all[0]?.played.length).toBe(1));
    const n = speakBodies.length;
    fireEvent.change(screen.getByLabelText("Speed"), { target: { value: "1.5" } });
    expect(FakeAudio.all[0]!.playbackRate).toBe(1.5);
    expect(speakBodies.length).toBe(n);
  });

  it("shows a problem and returns to the Listen button when the server fails", async () => {
    localStorage.setItem("dena.presenter.engine", "natural");
    speakFails = true;
    await listen();
    await waitFor(() => expect(screen.getByText(/The natural voice stopped: boom/)).toBeTruthy());
    expect(screen.getByText(/Listen/)).toBeTruthy();
  });

  it("uses the browser voice when the natural voice is not installed, even if it was chosen before", async () => {
    localStorage.setItem("dena.presenter.engine", "natural");
    current = status({ state: "off", sizeBytes: null });
    await listen();
    expect((window as any).speechSynthesis.speak).toHaveBeenCalled();
    expect(speakBodies).toEqual([]);
  });
});

describe("Asking before downloading", () => {
  it("explains what will be downloaded and stored, and installs only after the owner agrees", async () => {
    current = status({ state: "off", sizeBytes: null });
    render(<Presenter segments={segments} />);
    await waitFor(() => expect(screen.getByText("Get a natural voice…")).toBeTruthy());
    fireEvent.click(screen.getByText("Get a natural voice…"));
    expect(screen.getByText(/Your text never leaves this computer/)).toBeTruthy();
    expect(screen.getByText(/420 MB/, { selector: "b" })).toBeTruthy();
    expect(screen.getByText("/home/x/.dena/voice")).toBeTruthy();
    expect(posts).toEqual([]); // nothing yet
    fireEvent.click(screen.getByText(/Download 420 MB/));
    await waitFor(() => expect(posts).toEqual(["install"]));
    await waitFor(() => expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("40"));
  });

  it("asks twice before deleting an installed voice", async () => {
    render(<Presenter segments={segments} />);
    await waitFor(() => expect(screen.getByText("Natural voice")).toBeTruthy());
    fireEvent.click(screen.getByText("Natural voice"));
    fireEvent.click(screen.getByText(/Remove natural voice/));
    expect(posts).toEqual([]);
    fireEvent.click(screen.getByText(/Yes, delete/));
    await waitFor(() => expect(posts).toEqual(["remove"]));
  });
});

describe("Show presenter", () => {
  it("is off until chosen, and the choice is remembered", async () => {
    localStorage.setItem("dena.presenter.engine", "natural");
    await listen();
    await waitFor(() => expect(FakeAudio.all[0]?.played.length).toBe(1));
    const box = screen.getByLabelText("Show presenter") as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(document.querySelector(".avatar")).toBeNull();
    fireEvent.click(box);
    expect(localStorage.getItem("dena.presenter.avatar")).toBe("on");
  });
});

describe("Avatar without a model", () => {
  it("asks for the owner's bust and carries on quietly when there is none", async () => {
    const { Avatar } = await import("../src/components/Avatar");
    const loadModel = vi.fn(async () => null);
    render(<Avatar speaking={false} getLevel={() => null} loadModel={loadModel} />);
    await waitFor(() => expect(loadModel).toHaveBeenCalled());
  });
});
