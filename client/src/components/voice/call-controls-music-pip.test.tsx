// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceState } from "@/hooks/use-voice";
import { TooltipProvider } from "@/components/ui/tooltip";
import { HINTS_PERSIST_OVERRIDE_KEY } from "@/lib/hints";
import {
  MUSIC_PIP_KEY,
  rememberMusicPip,
  resetMusicPipForTests,
} from "@/lib/music-pip";
import {
  receiveMusic,
  resetMusicStoreForTests,
  setMusicSession,
} from "@/lib/music-store";

/*
 * THE NOVO PIP ON THE MUSICA TILE.
 *
 * A pip is not a card: it arbitrates with nothing, so the only things that
 * can be wrong about it are when it draws and what spends it. Both are here
 * because both are wiring, and the predicate that decides them is already
 * pinned in `lib/music-pip.test.ts`.
 */
vi.mock("@/components/voice/capabilities", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/voice/capabilities")>();
  return {
    ...actual,
    supportsScreenShare: () => true,
    canShareScreenAudio: () => false,
  };
});
vi.mock("@/lib/desktop", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/desktop")>();
  return { ...actual, isDesktopApp: () => false };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", FakeResizeObserver);
Element.prototype.scrollIntoView = () => {};

const { CallControls } = await import("./call-stage");

const idle: VoiceState = {
  status: "connected",
  peerId: "peer-me",
  remotePeers: [],
  uplinkBps: null,
  isMuted: false,
  isDeafened: false,
  canSpeak: true,
  canStream: true,
  canManageMusic: true,
  isAudienceSeat: false,
  inputMode: "voice-activity",
  isTransmitting: false,
  error: null,
  errorKind: null,
  notice: null,
  micFallback: null,
  voiceChannelId: "33333333-3333-4333-8333-333333333333",
  self: null,
  speakingPeerIds: [],
  serverMutedPeerIds: [],
  handRaisedAt: null,
  occupancy: {},
  peerVolumes: {},
  screenVolumes: {},
  usingSfu: false,
  transportFailure: null,
  roomTransport: "mesh",
  canPromoteTransport: false,
  capacityRoseFrom: null,
  isSharingScreen: false,
  isSharingMic: false,
  micInStream: true,
  voiceTrackMode: "junto",
  screenSharePeerIds: [],
  cameraPeerIds: [],
  focusedScreenPeerId: null,
  dismissedSharePeerIds: [],
  audibleScreenPeerIds: [],
  localScreenStream: null,
  isSharingScreenAudio: false,
  isSharingSystemAudio: false,
  isShareCursorVisible: false,
  screenShareAudioFailed: false,
  sharePublishRecovering: false,
  incomingCalls: [],
  isCameraOn: false,
  localCameraStream: null,
  callDeclinedUserIds: [],
  liveStream: null,
  channelLive: {},
  channelMusic: {},
};

let host: HTMLDivElement;
let root: Root;

function mount(voiceState: VoiceState) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root.render(
      <TooltipProvider>
        <CallControls
          voiceState={voiceState}
          collapsed={false}
          canExpand={false}
          userCollapsed={false}
          fullscreenAvailable={false}
          isFullscreen={false}
          onToggleFullscreen={() => {}}
          onToggleMute={() => {}}
          onToggleCamera={() => {}}
          videoQuality="720p"
          onVideoQualityChange={() => {}}
          qualityMenuOpen={false}
          onQualityMenuOpenChange={() => {}}
          onStartScreenShare={() => {}}
          onStopScreenShare={() => {}}
          onToggleCollapsed={() => {}}
          onLeave={() => {}}
        />
      </TooltipProvider>,
    );
  });
  return host;
}

const CHANNEL = "33333333-3333-4333-8333-333333333333";

function playSomething() {
  setMusicSession({
    channelId: CHANNEL,
    peerId: "peer-me",
    userId: "u1",
    displayName: "Eu",
    send: () => {},
  });
  receiveMusic(CHANNEL, {
    current: {
      id: "t1",
      provider: "youtube",
      videoId: "dQw4w9WgXcQ",
      title: "Track",
      sourceUrl: null,
      thumbnailUrl: null,
      durationMs: 180_000,
      addedByUserId: "u1",
      addedByName: "Eu",
    },
    queue: [],
    status: "playing",
    positionMs: 0,
    atMs: Date.now(),
    rev: 1,
    actorId: "peer-me",
    openControls: false,
    repeat: "off",
    skipVotes: [],
    history: [],
  });
}

describe("the NOVO pip on the call dock's Musica tile", () => {
  beforeEach(() => {
    resetMusicStoreForTests();
    resetMusicPipForTests();
    window.localStorage.clear();
    // jsdom answers localhost, where `lib/hints.ts` deliberately remembers
    // nothing so a developer sees every card on every reload. The override
    // is how that host is asked to behave like production.
    window.localStorage.setItem(HINTS_PERSIST_OVERRIDE_KEY, "1");
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("marks the tile for somebody who has never opened the panel", () => {
    expect(mount(idle).querySelector("[data-music-pip]")).not.toBeNull();
  });

  it("says nothing to a listener who could not add a track", () => {
    expect(
      mount({ ...idle, canSpeak: false }).querySelector("[data-music-pip]"),
    ).toBeNull();
  });

  it("steps aside once the bar is the announcement", () => {
    playSomething();
    expect(mount(idle).querySelector("[data-music-pip]")).toBeNull();
  });

  /*
   * The panel spends the mark, from wherever it was opened, and the tile
   * hears about it without waiting for a remount. It used to read storage
   * once at mount and clear itself on its own click, so a queue opened from
   * the sidebar radio or the bar left the tile still saying NOVO.
   */
  it("clears the moment the panel spends it, and does not come back", () => {
    mount(idle);
    expect(host.querySelector("[data-music-pip]")).not.toBeNull();
    act(() => rememberMusicPip());
    expect(host.querySelector("[data-music-pip]")).toBeNull();
    expect(window.localStorage.getItem(MUSIC_PIP_KEY)).toBe("1");

    // Closing the panel is not a second chance.
    act(() => rememberMusicPip());
    expect(host.querySelector("[data-music-pip]")).toBeNull();
  });

  it("still opens the queue when the tile is pressed", () => {
    const tile = mount(idle).querySelector(
      "[data-music-dock]",
    ) as HTMLButtonElement;
    expect(tile.getAttribute("aria-pressed")).toBe("false");
    act(() => tile.click());
    expect(
      (host.querySelector("[data-music-dock]") as HTMLButtonElement)
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });
});
