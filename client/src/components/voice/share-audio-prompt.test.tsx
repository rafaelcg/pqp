// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ShareAudioPrompt } from "./share-audio-prompt";
import { ShareSoundIndicator } from "./share-sound-indicator";

/**
 * The share-sound row the page draws itself (the shell's picker draws its own,
 * `electron/picker/audio-state.js`): on by default, off says what it means.
 * And the presenter's own indicator once the share is running.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mount(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<TooltipProvider>{node}</TooltipProvider>);
  });
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = "";
});

const toggle = () => document.querySelector<HTMLButtonElement>('[role="switch"]')!;
const row = () => document.querySelector<HTMLElement>('[data-testid="share-audio-row"]')!;
const note = () => document.querySelector<HTMLElement>('[data-testid="share-audio-off-note"]')!;

async function click(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("ShareAudioPrompt", () => {
  it("starts with the sound ON, and says nothing about an off state that is not there", async () => {
    await mount(<ShareAudioPrompt open onConfirm={() => {}} onClose={() => {}} />);
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    expect(row().getAttribute("data-state")).toBe("on");
    expect(note().textContent).toBe("");
  });

  it("names the choice and what it does, inside one control", async () => {
    await mount(<ShareAudioPrompt open onConfirm={() => {}} onClose={() => {}} />);
    expect(toggle().textContent).toContain("Share this computer's audio");
    expect(toggle().textContent).toContain("Viewers hear whatever is playing, without the call.");
  });

  it("says what the viewers get once it is turned off, in a live region", async () => {
    await mount(<ShareAudioPrompt open onConfirm={() => {}} onClose={() => {}} />);
    await click(toggle());
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(row().getAttribute("data-state")).toBe("off");
    expect(note().textContent).toBe("No sound: viewers only see the screen.");
    expect(note().getAttribute("role")).toBe("status");
  });

  it("confirms with the sound on by default, and with whatever was chosen after an untick", async () => {
    const onConfirm = vi.fn();
    await mount(<ShareAudioPrompt open onConfirm={onConfirm} onClose={() => {}} />);
    const confirm = () =>
      [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
        b.textContent?.includes("Choose what to share"),
      )!;
    await click(confirm());
    expect(onConfirm).toHaveBeenLastCalledWith(true);

    await click(toggle());
    await click(confirm());
    expect(onConfirm).toHaveBeenLastCalledWith(false);
  });

  it("starts on again the next time it opens: an untick counts for that share only", async () => {
    await mount(<ShareAudioPrompt open onConfirm={() => {}} onClose={() => {}} />);
    await click(toggle());
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    await act(async () => {
      root!.render(
        <TooltipProvider>
          <ShareAudioPrompt open={false} onConfirm={() => {}} onClose={() => {}} />
        </TooltipProvider>,
      );
    });
    await act(async () => {
      root!.render(
        <TooltipProvider>
          <ShareAudioPrompt open onConfirm={() => {}} onClose={() => {}} />
        </TooltipProvider>,
      );
    });
    expect(toggle().getAttribute("aria-checked")).toBe("true");
  });
});

describe("ShareSoundIndicator (the presenter's own stage)", () => {
  const indicator = () => document.querySelector<HTMLElement>('[data-testid="share-sound-indicator"]')!;

  it("says the sound is going out", async () => {
    await mount(<ShareSoundIndicator on />);
    expect(indicator().getAttribute("data-state")).toBe("on");
    expect(indicator().textContent).toBe("Sound shared: on");
    expect(indicator().getAttribute("role")).toBe("status");
    expect(indicator().querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("says plainly that there is no sound, and what to do, for a screen reader and on hover", async () => {
    await mount(<ShareSoundIndicator on={false} />);
    expect(indicator().getAttribute("data-state")).toBe("off");
    expect(indicator().textContent).toContain("No sound");
    expect(indicator().querySelector(".sr-only")?.textContent).toMatch(/stop sharing and share again/);
    expect(indicator().getAttribute("title")).toMatch(/share again with the sound on/);
  });
});
