// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LivePreviewStartResult } from "@/lib/api";
import { PREVIEW_AGE_OK_KEY } from "@/lib/live-preview";
import { devLivePreviewAuth } from "./live-preview-auth";
import { LivePreviewPanel, type LivePreviewCommunity } from "./live-preview-panel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CHANNEL = "2b7c1d1e-7a1f-4f6e-9a55-0c1f2a3b4c5d";

const api = vi.hoisted(() => ({
  starts: [] as Array<(result: LivePreviewStartResult) => void>,
  failures: [] as Array<(error: Error) => void>,
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchLivePreviewListing: vi.fn(async () => ({
      livePreview: {
        channels: [{ id: CHANNEL, name: "cinema", title: "Sessão" }],
        seconds: 300,
        upcoming: [],
      },
    })),
    startLivePreview: vi.fn(
      () =>
        new Promise<LivePreviewStartResult>((resolve, reject) => {
          api.starts.push(resolve);
          api.failures.push(reject);
        }),
    ),
  };
});

/** The real player needs hls.js and media; this one exposes its callbacks. */
const player = vi.hoisted(() => ({
  unavailable: null as null | (() => void),
  playing: null as null | (() => void),
}));

vi.mock("./live-preview-player", () => ({
  LivePreviewPlayer: (props: { onUnavailable: () => void; onPlaying?: () => void }) => {
    player.unavailable = props.onUnavailable;
    player.playing = props.onPlaying ?? null;
    return <div data-test-player="" />;
  },
}));

const COMMUNITY: LivePreviewCommunity = {
  name: "Sala do Rafa",
  slug: "sala-do-rafa",
  tagline: null,
  category: null,
  memberCount: null,
  iconUrl: null,
  bannerUrl: null,
  hue: 200,
};

function okResult(): LivePreviewStartResult {
  return {
    kind: "ok",
    body: {
      stream: { hlsUrl: `/api/voice/hls-playlist/${CHANNEL}/1?t=x`, startedAt: 1 },
      channel: { id: CHANNEL, name: "cinema" },
      ticket: "ticket",
      expiresAt: Date.now() + 300_000,
      remainingMs: 300_000,
    },
  };
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let siteRoot: HTMLElement | null = null;

beforeEach(() => {
  api.starts.length = 0;
  api.failures.length = 0;
  player.unavailable = null;
  player.playing = null;
  window.sessionStorage.setItem(PREVIEW_AGE_OK_KEY, "1");
  siteRoot = document.createElement("div");
  siteRoot.id = "root";
  document.body.append(siteRoot);
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  siteRoot?.remove();
  root = null;
  host = null;
  siteRoot = null;
  window.sessionStorage.clear();
  window.localStorage.clear();
});

async function mount() {
  host = document.createElement("div");
  siteRoot!.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <MemoryRouter>
        <LivePreviewPanel
          source={{ kind: "community", slug: COMMUNITY.slug! }}
          landing="/c/sala-do-rafa"
          surface="community"
          community={COMMUNITY}
          auth={devLivePreviewAuth(() => {})}
        />
      </MemoryRouter>,
    );
  });
}

/** The full-screen live page, portalled to <body>; null while only the entry card shows. */
function page(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-live-preview]:not([data-live-preview="idle"])');
}

async function watchNow() {
  const button = host!.querySelector<HTMLButtonElement>("button[aria-label]");
  expect(button).not.toBeNull();
  await act(async () => button!.click());
}

async function answerStart(index: number, result: LivePreviewStartResult) {
  await act(async () => api.starts[index]!(result));
}

describe("LivePreviewPanel", () => {
  it("drops a start answer that comes back after the visitor left the page", async () => {
    await mount();
    await watchNow();
    expect(page()?.dataset.livePreview).toBe("starting");
    expect(siteRoot!.inert).toBe(true);

    const back = document.querySelector<HTMLButtonElement>(
      '[data-live-preview="starting"] header button[aria-label]',
    );
    await act(async () => back!.click());
    expect(page()).toBeNull();
    expect(siteRoot!.inert).toBe(false);

    // The late answer must not bring the page back over the site.
    await answerStart(0, okResult());
    expect(page()).toBeNull();
    expect(siteRoot!.inert).toBe(false);
  });

  it("does not count two player failures as in a row when the picture played between them", async () => {
    await mount();
    await watchNow();
    await answerStart(0, okResult());
    expect(page()?.dataset.livePreview).toBe("watching");

    for (let round = 1; round <= 3; round += 1) {
      // The presenter restarts: the playlist refuses and the panel asks again.
      await act(async () => player.unavailable!());
      await answerStart(round, okResult());
      expect(page()?.dataset.livePreview).toBe("watching");
      // And the picture moves again before the next one.
      await act(async () => player.playing!());
    }
  });

  it("shows the error after failures with no picture in between", async () => {
    await mount();
    await watchNow();
    await answerStart(0, okResult());
    await act(async () => player.unavailable!());
    await answerStart(1, okResult());
    await act(async () => player.unavailable!());
    await answerStart(2, okResult());
    await act(async () => player.unavailable!());
    expect(page()?.dataset.livePreview).toBe("error");
  });

  it("shows the retry, not an endless skeleton, when a start throws", async () => {
    await mount();
    await watchNow();
    expect(page()?.dataset.livePreview).toBe("starting");
    await act(async () => api.failures[0]!(new Error("boom")));
    expect(page()?.dataset.livePreview).toBe("error");
  });
});
