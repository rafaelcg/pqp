// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VoiceState } from "@/hooks/use-voice";
import { TooltipProvider } from "@/components/ui/tooltip";

// A phone browser with no getDisplayMedia (Chrome for Android, iOS Safari).
vi.mock("@/components/voice/capabilities", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/voice/capabilities")>();
  return { ...actual, supportsScreenShare: () => false, canShareScreenAudio: () => false };
});
vi.mock("@/lib/desktop", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/desktop")>();
  return { ...actual, isDesktopApp: () => false };
});
vi.mock("@/lib/downloads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/downloads")>();
  return { ...actual, isAndroidDevice: () => true, isIOSDevice: () => false };
});
vi.mock("@/lib/screen-capture-cursor", () => ({
  useShareCursor: () => "show",
  setShareCursor: () => {},
  canControlShareCursor: () => false,
}));
vi.mock("@/lib/screen-preview-pref", () => ({
  useHideScreenPreview: () => false,
  setHideScreenPreview: () => {},
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
  sharePublishRecovering: false,
  incomingCalls: [],
  isCameraOn: false,
  localCameraStream: null,
  callDeclinedUserIds: [],
  liveStream: null,
  channelLive: {},
  channelMusic: {},
};

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <TooltipProvider>
        <CallControls
          voiceState={idle}
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

describe("share button on a phone browser without getDisplayMedia", () => {
  it("says why on tap and links the Google Play app", () => {
    const el = mount();
    expect(el.querySelector("[data-testid=share-unavailable-hint]")).toBeNull();
    const btn = el.querySelector<HTMLButtonElement>("button[aria-disabled=true]");
    expect(btn).not.toBeNull();
    act(() => btn!.click());
    const link = el.querySelector<HTMLAnchorElement>("[data-testid=share-get-app-link]");
    expect(link?.href).toContain("play.google.com/store/apps/details?id=gg.pqp.app");
    expect(el.querySelector("[data-testid=share-unavailable-hint]")?.textContent).toContain(
      "Screen sharing isn't supported by this browser.",
    );
  });
});
