import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, beforeEach, vi } from "vitest";
import type { VoiceState } from "@/hooks/use-voice";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  receiveMusic,
  resetMusicStoreForTests,
  setListening,
  setMusicOpen,
  setMusicSession,
} from "@/lib/music-store";

// A browser that can share, outside Electron: the only shape in which the
// Watch party button exists at all, so the test is about the grant and not
// about the platform.
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
// `useSyncExternalStore` has no server snapshot in the cursor store, and this
// test renders through react-dom/server.
vi.mock("@/lib/screen-capture-cursor", () => ({
  useShareCursor: () => "show",
  setShareCursor: () => {},
  canControlShareCursor: () => false,
}));
vi.mock("@/lib/screen-preview-pref", () => ({
  useHideScreenPreview: () => false,
  setHideScreenPreview: () => {},
}));

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

function render(voiceState: VoiceState) {
  return renderToStaticMarkup(
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
}

/**
 * In a watch_party room the welcome's `canStream` comes from
 * START_WATCH_PARTY, not STREAM. The audience gets false, and with it neither
 * the share button nor the Watch party button: the server would refuse the
 * share anyway, and a button that opens a picker and then fails is worse than
 * no button.
 */
describe("CallControls in a watch party room", () => {
  it("hides the Watch party button from the audience (canStream false)", () => {
    const html = render({ ...idle, canStream: false });
    expect(html).not.toContain("lucide-monitor-play");
    expect(html).not.toContain("lucide-screen-share");
  });

  it("shows the Watch party button to the presenter (canStream true)", () => {
    const html = render({ ...idle, canStream: true });
    expect(html).toContain("lucide-monitor-play");
    expect(html).toContain("lucide-screen-share");
  });
});

describe("CallControls collapsed push-to-talk", () => {
  it("puts hold-to-talk in the control row, not a yellow warning", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <CallControls
          voiceState={{ ...idle, inputMode: "push-to-talk" }}
          collapsed
          canExpand={false}
          userCollapsed
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
          pushToTalk
          isTransmitting={false}
          pushToTalkKeyLabel="`"
          windowFocused={false}
        />
      </TooltipProvider>,
    );
    expect(html).toContain("lucide-mic-off");
    expect(html).not.toContain("text-warning");
    expect(html).toContain("opacity-50");
  });
});

describe("CallControls music tile", () => {
  beforeEach(() => {
    resetMusicStoreForTests();
  });

  it("shows the tile collapsed and expanded, never hiding under 22rem", () => {
    const expanded = render(idle);
    expect(expanded).toContain('data-music-dock="idle"');
    expect(expanded).toContain("aria-pressed=\"false\"");
    expect(expanded).not.toMatch(/data-music-dock="idle"[^>]*@min-\[22rem\]/);

    const collapsed = renderToStaticMarkup(
      <TooltipProvider>
        <CallControls
          voiceState={idle}
          collapsed
          canExpand={false}
          userCollapsed
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
    expect(collapsed).toContain('data-music-dock="idle"');
    expect(collapsed).not.toMatch(/data-music-dock="idle"[^>]*@min-\[22rem\]/);
  });

  it("presses when Fila is open and marks playing when a track is on", () => {
    setMusicOpen(true);
    expect(render(idle)).toContain("aria-pressed=\"true\"");
    setMusicOpen(false);
    setMusicSession({
      channelId: idle.voiceChannelId ?? "33333333-3333-4333-8333-333333333333",
      peerId: "peer-me",
      userId: "u1",
      displayName: "Eu",
      send: () => {},
    });
    receiveMusic(idle.voiceChannelId ?? "33333333-3333-4333-8333-333333333333", {
      current: {
        id: "t1",
        provider: "youtube",
        videoId: "aaaaaaaaaaa",
        title: "A",
        sourceUrl: null,
        thumbnailUrl: null,
        durationMs: 1,
        addedByUserId: "u1",
        addedByName: "Eu",
      },
      queue: [],
      status: "playing",
      positionMs: 0,
      atMs: 1,
      rev: 1,
      actorId: "peer-me",
      openControls: false,
      repeat: "off",
      skipVotes: [],
      history: [],
    });
    expect(render(idle)).toContain('data-music-dock="playing"');
  });

  /* The one thing the tile can say when the panel is shut and the bar is
     not this channel's: the room has music and you are not hearing it. */
  it("carries a dot once this machine has stopped listening", () => {
    const channelId = idle.voiceChannelId ?? "33333333-3333-4333-8333-333333333333";
    setMusicSession({
      channelId,
      peerId: "peer-me",
      userId: "u1",
      displayName: "Eu",
      send: () => {},
    });
    receiveMusic(channelId, {
      current: {
        id: "t1",
        provider: "youtube",
        videoId: "aaaaaaaaaaa",
        title: "A",
        sourceUrl: null,
        thumbnailUrl: null,
        durationMs: 1,
        addedByUserId: "u1",
        addedByName: "Eu",
      },
      queue: [],
      status: "playing",
      positionMs: 0,
      atMs: 1,
      rev: 1,
      actorId: "peer-me",
      openControls: false,
      repeat: "off",
      skipVotes: [],
      history: [],
    });
    expect(render(idle)).not.toContain("data-music-dock-dot");
    setListening(false);
    expect(render(idle)).toContain("data-music-dock-dot");
    setListening(true);
    expect(render(idle)).not.toContain("data-music-dock-dot");
  });
});
