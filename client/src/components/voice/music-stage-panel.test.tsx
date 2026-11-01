// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MusicState, MusicTrack } from "@pqp/shared";
import type { VoiceState } from "@/hooks/use-voice";
import { TooltipProvider } from "@/components/ui/tooltip";
import { REDESIGN_STORAGE_KEY, resetRedesignForTests } from "@/lib/redesign";
import {
  getMusicSnapshot,
  receiveMusic,
  resetMusicStoreForTests,
  setMusicOpen,
  setMusicSession,
} from "@/lib/music-store";
import { resetMusicPrefsForTests, setMusicPlacement } from "@/lib/music-prefs";
import { MusicComposer } from "@/components/voice/music-composer";
import { rememberStageCollapsed } from "@/components/dm/call-stage-state";
import {
  claimStageMusicPanel,
  composerDrawsMusic,
  isStageMusicPanelDrawn,
  resetStageMusicPanelForTests,
  useStageMusicPanel,
} from "@/components/voice/music-stage-panel-store";

// The tiles bind a MediaStream to a <video>; jsdom has neither.
vi.mock("@/lib/remote-video-binding", () => ({
  bindRemoteVideo: () => () => {},
}));
// The room stage is a wide window's.
vi.mock("@/hooks/use-lg-up", () => ({ useLgUp: () => true }));
// No API here.
vi.mock("@/hooks/use-voice-config", () => ({ useVoiceConfig: () => ({}) }));
// The YouTube embed: the panel must never mount one.
const embedRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock("@/components/voice/music-player-embed", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/voice/music-player-embed")>();
  return {
    ...actual,
    MusicPlayer: () => {
      embedRenders.count += 1;
      return null;
    },
  };
});

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", FakeResizeObserver);
Element.prototype.scrollIntoView = () => {};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { CallStage } = await import("./call-stage");

const CHANNEL = "33333333-3333-4333-8333-333333333333";
const SERVER = "44444444-4444-4444-8444-444444444444";
const LONG_TITLE =
  "Racionais MC's - Diário de um Detento (Ao Vivo no Estúdio, Versão Completa)";

const fakeStream = () =>
  ({
    getTracks: () => [],
    getAudioTracks: () => [],
    getVideoTracks: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
  }) as unknown as MediaStream;

const base: VoiceState = {
  status: "connected",
  peerId: "peer-me",
  remotePeers: [],
  uplinkBps: null,
  isMuted: false,
  isDeafened: false,
  canSpeak: true,
  canStream: true,
  canManageMusic: true,
  canUseSoundboard: false,
  canManageSoundboard: false,
  isAudienceSeat: false,
  inputMode: "voice-activity",
  isTransmitting: false,
  error: null,
  errorKind: null,
  dismissedCameraPeerIds: [],
  notice: null,
  micFallback: null,
  audioHealthPrompt: null,
  voiceChannelId: "33333333-3333-4333-8333-333333333333",
  self: null,
  speakingPeerIds: [],
  serverMutedPeerIds: [],
  speakLockedPeerIds: [],
  speakReason: null,
  audience: null,
  audienceChange: null,
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
  shareCaptureHint: null,
  screenShareAudioFailed: false,
  screenShareError: null,
  watchPartyShareSilent: false,
  sharePublishRecovering: false,
  incomingCalls: [],
  isCameraOn: false,
  localCameraStream: null,
  callDeclinedUserIds: [],
  liveStream: null,
  channelLive: {},
  channelMusic: {},
};

const track = (id: string, title = `Track ${id}`): MusicTrack => ({
  id,
  provider: "youtube",
  videoId: id.padEnd(11, "a").slice(0, 11),
  title,
  sourceUrl: null,
  thumbnailUrl: "https://i.ytimg.com/vi/abc/hqdefault.jpg",
  durationMs: 180_000,
  addedByUserId: "22222222-2222-4222-8222-222222222222",
  addedByName: "Ana",
});

const musicState = (partial: Partial<MusicState> = {}): MusicState => ({
  current: track("now", LONG_TITLE),
  queue: [track("q1", "Daft Punk")],
  status: "playing",
  positionMs: 0,
  atMs: 1,
  rev: 1,
  actorId: "peer-me",
  openControls: false,
  repeat: "off",
  skipVotes: [],
  history: [],
  ...partial,
});

function voiceWith({ friendShares = false, alone = false } = {}): VoiceState {
  return {
    ...base,
    voiceChannelId: CHANNEL,
    self: {
      peerId: "peer-me",
      userId: "user-me",
      displayName: "Eu",
      avatarUrl: null,
    },
    screenSharePeerIds: friendShares ? ["peer-friend"] : [],
    remotePeers: (alone ? [] : [
      {
        peerId: "peer-friend",
        userId: "user-friend",
        displayName: "Amigo",
        avatarUrl: null,
        connectionState: "connected",
        cameraStream: null,
        screenStream: friendShares ? fakeStream() : null,
        screenAudioStream: null,
      },
    ]) as unknown as VoiceState["remotePeers"],
  } as VoiceState;
}

/**
 * App's half, in small: the composer's music bar, left out while the stage
 * says it draws the player for this call.
 */
function ComposerProbe({ voiceState }: { voiceState: VoiceState }) {
  const stageDraws = useStageMusicPanel(voiceState.voiceChannelId);
  return (
    <div data-chat-composer="">
      {composerDrawsMusic(true, stageDraws) ? (
        <MusicComposer voiceState={voiceState} />
      ) : null}
    </div>
  );
}

let root: Root | null = null;
let host: HTMLElement | null = null;

function mount(voiceState: VoiceState, { stageHidden = false } = {}) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <TooltipProvider>
        <CallStage
          channelId={CHANNEL}
          serverId={SERVER}
          title="Sala"
          currentUser={{ id: "user-me", displayName: "Eu", avatarUrl: null }}
          voiceState={voiceState}
          videoQuality="720p"
          onLeave={() => {}}
          onToggleMute={() => {}}
          onDismissMicFallbackNotice={() => {}}
          onToggleCamera={() => {}}
          onVideoQualityChange={() => {}}
          onStopScreenShare={() => {}}
          stageHidden={stageHidden}
          // A server room, not an outgoing ring (voice-channel-stage.tsx).
          ringWhenAlone={false}
        />
        <ComposerProbe voiceState={voiceState} />
      </TooltipProvider>,
    );
  });
  return host;
}

const panel = (el: HTMLElement) =>
  el.querySelector("[data-music-stage-panel]");
const composerBar = (el: HTMLElement) =>
  el.querySelector("[data-chat-composer] [data-music-now-playing]");

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(REDESIGN_STORAGE_KEY, "on");
  resetRedesignForTests();
  resetMusicStoreForTests();
  resetMusicPrefsForTests();
  resetStageMusicPanelForTests();
  embedRenders.count = 0;
  setMusicSession({
    channelId: CHANNEL,
    peerId: "peer-me",
    userId: "user-me",
    displayName: "Eu",
    send: () => {},
  });
});
afterEach(() => {
  rememberStageCollapsed(CHANNEL, false);
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("the music panel on the room stage", () => {
  it("takes the stage over the cards and the composer leaves its bar out", () => {
    receiveMusic(CHANNEL, musicState());
    const el = mount(voiceWith());
    const drawn = panel(el);
    expect(drawn).not.toBeNull();
    expect(el.querySelector("[data-testid=room-cards-stage]")?.contains(drawn)).toBe(true);
    expect(el.querySelector("[data-testid=stage-room-cards]")?.getAttribute("data-room-layout")).toBe("share");
    // The whole title, not a marquee.
    expect(drawn!.querySelector("[data-music-title]")?.textContent).toBe(LONG_TITLE);
    expect(drawn!.querySelector("img")?.getAttribute("src")).toContain("i.ytimg.com");
    expect(drawn!.querySelector("[data-music-play]")).not.toBeNull();
    expect(drawn!.textContent).toContain("Ana");
    expect(isStageMusicPanelDrawn(CHANNEL)).toBe(true);
    expect(composerBar(el)).toBeNull();
  });

  it("never mounts the YouTube embed", () => {
    receiveMusic(CHANNEL, musicState());
    act(() => setMusicOpen(true));
    const el = mount(voiceWith());
    expect(panel(el)).not.toBeNull();
    expect(embedRenders.count).toBe(0);
    expect(el.querySelector("iframe")).toBeNull();
  });

  it("opens the queue in the panel when something asks for it", () => {
    receiveMusic(CHANNEL, musicState());
    const el = mount(voiceWith());
    expect(panel(el)!.querySelector("[data-music-fila]")).toBeNull();
    act(() => setMusicOpen(true));
    const fila = panel(el)!.querySelector("[data-music-fila='sheet']");
    expect(fila).not.toBeNull();
    expect(fila!.querySelector("[data-music-search]")).not.toBeNull();
    expect(fila!.textContent).toContain("Daft Punk");
    expect(el.querySelectorAll("[data-music-fila]")).toHaveLength(1);
  });

  it("puts the queue beside the player on the usual stage", () => {
    receiveMusic(CHANNEL, musicState());
    act(() => setMusicOpen(true));
    const el = mount(voiceWith());
    expect(panel(el)?.getAttribute("data-music-stage-layout")).toBe("side");
    expect(panel(el)?.querySelector("[data-music-stage-compact]")).toBeNull();
  });

  it("stacks the queue under a thumbnail player on a narrow stage", () => {
    const rect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({ width: 480, height: 400 } as DOMRect);
    try {
      receiveMusic(CHANNEL, musicState());
      act(() => setMusicOpen(true));
      const el = mount(voiceWith());
      expect(panel(el)?.getAttribute("data-music-stage-layout")).toBe("stacked");
      const compact = panel(el)?.querySelector("[data-music-stage-compact]");
      expect(compact?.querySelector("[data-music-art] img")).not.toBeNull();
      expect(compact?.querySelector("[data-music-title]")?.textContent).toBe(LONG_TITLE);
      expect(panel(el)?.querySelector("[data-music-search]")).not.toBeNull();
    } finally {
      rect.mockRestore();
    }
  });

  // QA-016: the panel is a place on the stage, not a popover. Only its own
  // close button (or Escape) puts it away.
  it("stays open when something outside it is pressed", () => {
    receiveMusic(CHANNEL, musicState());
    act(() => setMusicOpen(true));
    const el = mount(voiceWith());
    const away = document.createElement("textarea");
    document.body.append(away);
    act(() => {
      away.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    expect(getMusicSnapshot().open).toBe(true);
    expect(panel(el)?.querySelector("[data-music-fila='sheet']")).not.toBeNull();
    away.remove();
  });

  it("closes from its own close button and from Escape", () => {
    receiveMusic(CHANNEL, musicState());
    act(() => setMusicOpen(true));
    const el = mount(voiceWith());
    act(() => {
      el.querySelector<HTMLElement>("[data-music-fila-close]")!.click();
    });
    expect(getMusicSnapshot().open).toBe(false);
    act(() => setMusicOpen(true));
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(getMusicSnapshot().open).toBe(false);
  });

  it("draws the queue alone when nothing is playing yet", () => {
    const el = mount(voiceWith());
    expect(panel(el)).toBeNull();
    expect(el.querySelector("[data-testid=room-cards-alone]")).toBeNull();
    act(() => setMusicOpen(true));
    expect(panel(el)?.querySelector("[data-music-fila='sheet']")).not.toBeNull();
    expect(composerBar(el)).toBeNull();
  });

  it("gives the stage back when the music goes", () => {
    receiveMusic(CHANNEL, musicState());
    const el = mount(voiceWith());
    expect(panel(el)).not.toBeNull();
    act(() => root!.unmount());
    root = null;
    expect(isStageMusicPanelDrawn(CHANNEL)).toBe(false);
    el.remove();
  });

  it("keeps the music in the composer bar while a share is on the stage", () => {
    receiveMusic(CHANNEL, musicState());
    const el = mount(voiceWith({ friendShares: true }));
    expect(panel(el)).toBeNull();
    expect(isStageMusicPanelDrawn(CHANNEL)).toBe(false);
    expect(composerBar(el)).not.toBeNull();
  });

  it("changes nothing under the old look", () => {
    localStorage.setItem(REDESIGN_STORAGE_KEY, "off");
    receiveMusic(CHANNEL, musicState());
    const el = mount(voiceWith());
    expect(panel(el)).toBeNull();
    expect(el.querySelector("[data-testid=stage-room-cards]")).toBeNull();
    expect(composerBar(el)).not.toBeNull();
  });

  it("opens from the alone card's music button", () => {
    const el = mount(voiceWith({ alone: true }));
    const button = el.querySelector<HTMLButtonElement>(
      "[data-testid=room-cards-music]",
    );
    expect(button).not.toBeNull();
    act(() => button!.click());
    expect(panel(el)?.querySelector("[data-music-fila='sheet']")).not.toBeNull();
    expect(el.querySelector("[data-testid=room-cards-alone]")).toBeNull();
  });

  it("stays in the composer while the call is hidden", () => {
    receiveMusic(CHANNEL, musicState());
    const el = mount(voiceWith(), { stageHidden: true });
    expect(panel(el)).toBeNull();
    expect(isStageMusicPanelDrawn(CHANNEL)).toBe(false);
    expect(composerBar(el)).not.toBeNull();
  });

  it("stays in the composer while the stage is collapsed", () => {
    rememberStageCollapsed(CHANNEL, true);
    receiveMusic(CHANNEL, musicState());
    const el = mount(voiceWith());
    expect(panel(el)).toBeNull();
    expect(isStageMusicPanelDrawn(CHANNEL)).toBe(false);
    expect(composerBar(el)).not.toBeNull();
  });

  it("leaves the stage to the clip with placement stage", () => {
    act(() => setMusicPlacement("stage"));
    receiveMusic(CHANNEL, musicState());
    const el = mount(voiceWith());
    expect(panel(el)).toBeNull();
    expect(isStageMusicPanelDrawn(CHANNEL)).toBe(false);
    expect(composerBar(el)).not.toBeNull();
  });
});

describe("the stage music panel store", () => {
  beforeEach(() => resetStageMusicPanelForTests());

  it("is held per channel until every claim lets go", () => {
    const first = claimStageMusicPanel(CHANNEL);
    const second = claimStageMusicPanel(CHANNEL);
    first();
    first();
    expect(isStageMusicPanelDrawn(CHANNEL)).toBe(true);
    expect(isStageMusicPanelDrawn("other")).toBe(false);
    second();
    expect(isStageMusicPanelDrawn(CHANNEL)).toBe(false);
    expect(isStageMusicPanelDrawn(null)).toBe(false);
  });

  it("leaves the composer bar alone unless the stage draws it", () => {
    expect(composerDrawsMusic(true, false)).toBe(true);
    expect(composerDrawsMusic(true, true)).toBe(false);
    expect(composerDrawsMusic(false, false)).toBe(false);
  });
});
