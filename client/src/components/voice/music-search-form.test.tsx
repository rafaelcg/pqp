// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { resetMusicStoreForTests, setMusicSession } from "@/lib/music-store";
import { MusicSearchPicker } from "@/components/voice/music-search-picker";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", FakeResizeObserver);
Element.prototype.scrollIntoView = () => {};

const resolved: string[] = [];
vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    resolveMusic: async (query: string) => {
      resolved.push(query);
      const track = {
        provider: "youtube" as const,
        videoId: "dQw4w9WgXcQ",
        title: "Added by the plus",
        sourceUrl: null,
        thumbnailUrl: null,
        durationMs: 1000,
      };
      return { track, tracks: [track] };
    },
  };
});

const CHANNEL = "11111111-1111-4111-8111-111111111111";

let host: HTMLDivElement;
let root: Root;

/**
 * The composer wraps its whole well in a form, and the music panel renders
 * inside it. A form here would be a form inside a form, which is invalid
 * HTML and navigates the page on submit.
 */
function mountInsideAForm() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root.render(
      <TooltipProvider>
        <form onSubmit={(event) => event.preventDefault()}>
          <MusicSearchPicker compact canManage />
        </form>
      </TooltipProvider>,
    );
  });
}

describe("the music field inside the composer's form", () => {
  beforeEach(() => {
    resolved.length = 0;
    resetMusicStoreForTests();
    setMusicSession({
      channelId: CHANNEL,
      peerId: "peer-me",
      userId: "33333333-3333-4333-8333-333333333333",
      displayName: "Eu",
      send: () => {},
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("nests no form of its own", () => {
    mountInsideAForm();
    expect(host.querySelectorAll("form").length).toBe(1);
    expect(host.querySelector("[data-music-search]")?.tagName).not.toBe("FORM");
  });

  it("has no submit button, which is what navigated the page", () => {
    mountInsideAForm();
    const buttons = [...host.querySelectorAll("button")];
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      expect(button.getAttribute("type")).toBe("button");
    }
  });

  it("still adds what the field holds when the plus is pressed", async () => {
    mountInsideAForm();
    const field = host.querySelector("input") as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    act(() => {
      setter?.call(field, "https://youtu.be/dQw4w9WgXcQ");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const plus = [...host.querySelectorAll("button")].at(-1) as HTMLButtonElement;
    await act(async () => {
      plus.click();
      await Promise.resolve();
    });
    expect(resolved).toEqual(["https://youtu.be/dQw4w9WgXcQ"]);
  });
});
