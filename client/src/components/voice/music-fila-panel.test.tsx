// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MusicState, MusicTrack } from "@pqp/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { VoiceState } from "@/hooks/use-voice";
import {
  getMusicSnapshot,
  receiveMusic,
  resetMusicStoreForTests,
  setMusicOpen,
  setMusicSession,
} from "@/lib/music-store";
import { resetMusicPrefsForTests } from "@/lib/music-prefs";
import { MusicFila } from "@/components/voice/music-fila";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

// jsdom has no ResizeObserver, and the seek slider's Radix thumb measures itself.
class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", FakeResizeObserver);

// jsdom has no layout, so the field's focus scroll is a no-op here.
Element.prototype.scrollIntoView = () => {};

const CHANNEL = "11111111-1111-4111-8111-111111111111";

const track = (id: string, title = `Track ${id}`): MusicTrack => ({
  id,
  provider: "youtube",
  videoId: id.padEnd(11, "a").slice(0, 11),
  title,
  sourceUrl: null,
  thumbnailUrl: null,
  durationMs: 180_000,
  addedByUserId: "22222222-2222-4222-8222-222222222222",
  addedByName: "Ana",
});

const state = (partial: Partial<MusicState> = {}): MusicState => ({
  current: track("now", "Tocando agora mesmo"),
  queue: [],
  status: "playing",
  positionMs: 0,
  atMs: 1,
  rev: 1,
  actorId: "peer-ana",
  openControls: false,
  repeat: "off",
  skipVotes: [],
  history: [],
  ...partial,
});

const voiceState = (): VoiceState =>
  ({
    status: "connected",
    peerId: "peer-me",
    canSpeak: true,
    canStream: true,
    canManageMusic: true,
    voiceChannelId: CHANNEL,
    self: {
      peerId: "peer-me",
      userId: "33333333-3333-4333-8333-333333333333",
      displayName: "Eu",
      avatarUrl: null,
    },
    occupancy: { [CHANNEL]: [] },
    speakingPeerIds: [],
    isDeafened: false,
    isTransmitting: false,
    channelMusic: {},
  }) as unknown as VoiceState;

let host: HTMLDivElement;
let root: Root;

function mount(variant: "sheet" | "drawer" = "sheet") {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root.render(
      <TooltipProvider>
        <MusicFila variant={variant} voiceState={voiceState()} />
      </TooltipProvider>,
    );
  });
}

describe("the Fila panel is one column", () => {
  beforeEach(() => {
    resetMusicStoreForTests();
    resetMusicPrefsForTests();
    setMusicSession({
      channelId: CHANNEL,
      peerId: "peer-me",
      userId: "33333333-3333-4333-8333-333333333333",
      displayName: "Eu",
      send: () => {},
    });
    receiveMusic(CHANNEL, state({ queue: [track("q1", "Daft Punk"), track("q2", "Racionais")] }));
    setMusicOpen(true);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("keeps the field mounted while a track plays, with nothing pressed", () => {
    mount();
    expect(host.querySelector("[data-music-search]")).not.toBeNull();
    expect(host.querySelector("input")).not.toBeNull();
  });

  it("shows the queue and the field at the same time", () => {
    mount();
    expect(host.querySelector("[data-music-search]")).not.toBeNull();
    expect(host.textContent).toContain("Daft Punk");
    expect(host.textContent).toContain("Racionais");
  });

  it("drops the header's add button, because the field is always there", () => {
    mount();
    expect(host.querySelector("[data-music-add]")).toBeNull();
  });

  it("closes the panel on Escape from an empty field", () => {
    mount();
    const field = host.querySelector("input") as HTMLInputElement;
    act(() => {
      field.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    expect(getMusicSnapshot().open).toBe(false);
  });

  it("puts the field above the queue in the drawer too", () => {
    mount("drawer");
    const search = host.querySelector("[data-music-search]");
    const queue = host.querySelector("[data-music-queue]");
    expect(search).not.toBeNull();
    expect(queue).not.toBeNull();
    expect(
      search!.compareDocumentPosition(queue!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
