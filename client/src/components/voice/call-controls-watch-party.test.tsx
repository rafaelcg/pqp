import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { VoiceState } from "@/hooks/use-voice";
import { TooltipProvider } from "@/components/ui/tooltip";

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

const { CallControls } = await import("./call-stage");

const idle: VoiceState = {
  status: "connected",
  peerId: "peer-me",
  remotePeers: [],
  isMuted: false,
  isDeafened: false,
  canSpeak: true,
  canStream: true,
  inputMode: "voice-activity",
  isTransmitting: false,
  error: null,
  errorKind: null,
  notice: null,
  voiceChannelId: "33333333-3333-4333-8333-333333333333",
  self: null,
  speakingPeerIds: [],
  serverMutedPeerIds: [],
  occupancy: {},
  peerVolumes: {},
  screenVolumes: {},
  usingSfu: false,
  transportFailure: null,
  roomTransport: "mesh",
  canPromoteTransport: false,
  isSharingScreen: false,
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
  incomingCalls: [],
  isCameraOn: false,
  localCameraStream: null,
  callDeclinedUserIds: [],
  liveStream: null,
  channelLive: {},
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
