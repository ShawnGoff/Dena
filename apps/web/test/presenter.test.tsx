// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Presenter } from "../src/components/Presenter";

/** A fake speech engine: records what is spoken and lets the test finish each utterance. */
class FakeUtterance { onend: (() => void) | null = null; onerror: (() => void) | null = null; rate = 1; voice: unknown = null; lang = ""; constructor(public text: string) {} }
let spoken: FakeUtterance[];
let synth: { speak: any; cancel: any; pause: any; resume: any; getVoices: any; addEventListener: any; removeEventListener: any };

beforeEach(() => {
  spoken = [];
  synth = { speak: vi.fn((u: FakeUtterance) => spoken.push(u)), cancel: vi.fn(), pause: vi.fn(), resume: vi.fn(), getVoices: () => [], addEventListener: vi.fn(), removeEventListener: vi.fn() };
  (window as any).speechSynthesis = synth;
  (window as any).SpeechSynthesisUtterance = FakeUtterance;
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  delete (window as any).speechSynthesis;
  delete (window as any).SpeechSynthesisUtterance;
});

const segments = [
  { text: "Title.", anchor: "title" }, { text: "First.", anchor: "a" }, { text: "Second.", anchor: "a" }, { text: "Third.", anchor: "b" },
];
const end = (u: FakeUtterance) => act(() => { u.onend!(); });
const page = () => render(<><div data-narr="a" data-testid="a" /><Presenter segments={segments} /></>);

describe("Presenter", () => {
  it("renders nothing when the browser has no speech engine", () => {
    delete (window as any).speechSynthesis;
    const { container } = render(<Presenter segments={segments} />);
    expect(container.textContent).toBe("");
  });

  it("reads segments in order, highlights the current part, and stops at the end", () => {
    page();
    fireEvent.click(screen.getByText(/Listen/));
    expect(spoken.map((u) => u.text)).toEqual(["Title."]);
    end(spoken[0]!);
    expect(spoken.map((u) => u.text)).toEqual(["Title.", "First."]);
    expect(screen.getByTestId("a").classList.contains("narrating")).toBe(true);
    end(spoken[1]!); end(spoken[2]!); end(spoken[3]!);
    expect(screen.queryByRole("region")).toBeNull(); // back to the idle button
    expect(screen.getByTestId("a").classList.contains("narrating")).toBe(false);
  });

  it("next skips to the following part and previous restarts the current one", () => {
    page();
    fireEvent.click(screen.getByText(/Listen/));
    fireEvent.click(screen.getByLabelText("Next part"));
    expect(spoken.at(-1)!.text).toBe("First.");
    end(spoken.at(-1)!); // now on "Second."
    fireEvent.click(screen.getByLabelText("Previous part"));
    expect(spoken.at(-1)!.text).toBe("First."); // start of this part
    fireEvent.click(screen.getByLabelText("Next part"));
    expect(spoken.at(-1)!.text).toBe("Third.");
  });

  it("ignores the end-event that cancelling an utterance causes", () => {
    page();
    fireEvent.click(screen.getByText(/Listen/));
    const first = spoken[0]!;
    fireEvent.click(screen.getByLabelText("Next part")); // cancels the first
    const n = spoken.length;
    end(first); // a late end-event from the cancelled one
    expect(spoken.length).toBe(n);
  });

  it("pauses, resumes, and stops speech when unmounted", () => {
    const { unmount } = page();
    fireEvent.click(screen.getByText(/Listen/));
    fireEvent.click(screen.getByLabelText("Pause"));
    expect(synth.pause).toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("Resume"));
    expect(synth.resume).toHaveBeenCalled();
    synth.cancel.mockClear();
    unmount();
    expect(synth.cancel).toHaveBeenCalled();
  });

  it("changing speed restarts the current part at the new rate", () => {
    page();
    fireEvent.click(screen.getByText(/Listen/));
    fireEvent.change(screen.getByLabelText("Speed"), { target: { value: "1.5" } });
    expect(spoken.at(-1)!.text).toBe("Title.");
    expect(spoken.at(-1)!.rate).toBe(1.5);
  });
});
