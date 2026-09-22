// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MusicResolved } from "@pqp/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  getMusicSnapshot,
  resetMusicStoreForTests,
  setMusicSession,
} from "@/lib/music-store";
import {
  LIVE_SEARCH_DEBOUNCE_MS,
  LIVE_SEARCH_MIN_CHARS,
  MusicSearchPicker,
} from "@/components/voice/music-search-picker";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", FakeResizeObserver);
Element.prototype.scrollIntoView = () => {};

const searched: string[] = [];
const resolved: string[] = [];

const hit = (title: string): MusicResolved => ({
  provider: "youtube",
  videoId: "aaaaaaaaaaa",
  title,
  sourceUrl: null,
  thumbnailUrl: null,
  durationMs: 180_000,
});

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    searchMusic: async (query: string) => {
      searched.push(query);
      return { tracks: [hit(`Result for ${query}`)] };
    },
    resolveMusic: async (query: string) => {
      resolved.push(query);
      const track = hit("Pasted link");
      return { track, tracks: [track] };
    },
  };
});

const CHANNEL = "11111111-1111-4111-8111-111111111111";

let host: HTMLDivElement;
let root: Root;

function mount() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root.render(
      <TooltipProvider>
        <MusicSearchPicker compact canManage />
      </TooltipProvider>,
    );
  });
  return host.querySelector("input") as HTMLInputElement;
}

/** Types into the controlled field the way React sees a real keystroke. */
function typeInto(field: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  act(() => {
    setter?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function settle(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("the music field searches as you type", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    searched.length = 0;
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
    vi.useRealTimers();
  });

  it("waits for the typing to stop, then asks once", async () => {
    const field = mount();
    typeInto(field, "daf");
    typeInto(field, "daft");
    typeInto(field, "daft punk");
    expect(searched).toEqual([]);
    await settle(LIVE_SEARCH_DEBOUNCE_MS + 10);
    expect(searched).toEqual(["daft punk"]);
    expect(host.textContent).toContain("Result for daft punk");
  });

  it("stays quiet under the floor, because a letter is not a search", async () => {
    const field = mount();
    typeInto(field, "a".repeat(LIVE_SEARCH_MIN_CHARS - 1));
    await settle(LIVE_SEARCH_DEBOUNCE_MS + 10);
    expect(searched).toEqual([]);
  });

  it("does not ask twice for a query it already ran", async () => {
    const field = mount();
    typeInto(field, "racionais");
    await settle(LIVE_SEARCH_DEBOUNCE_MS + 10);
    typeInto(field, "racionais ");
    typeInto(field, "racionais");
    await settle(LIVE_SEARCH_DEBOUNCE_MS + 10);
    expect(searched).toEqual(["racionais"]);
  });

  it("never live-searches a link, which is a resolve and not a search", async () => {
    const field = mount();
    typeInto(field, "https://youtu.be/dQw4w9WgXcQ");
    await settle(LIVE_SEARCH_DEBOUNCE_MS + 10);
    expect(searched).toEqual([]);
    expect(resolved).toEqual([]);
  });

  it("resolves a pasted link at once, with no Enter", async () => {
    const field = mount();
    act(() => {
      const paste = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(paste, "clipboardData", {
        value: { getData: () => "https://youtu.be/dQw4w9WgXcQ" },
      });
      field.dispatchEvent(paste);
    });
    await settle(10);
    expect(resolved).toEqual(["https://youtu.be/dQw4w9WgXcQ"]);
    expect(getMusicSnapshot().state?.current?.title).toBe("Pasted link");
  });
});
