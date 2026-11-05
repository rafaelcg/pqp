// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceState } from "@/hooks/use-voice";
import { TooltipProvider } from "@/components/ui/tooltip";
import { resetHideScreenPreviewForTests } from "@/lib/screen-preview-pref";

// The tiles bind a MediaStream to a <video>; jsdom has neither.
vi.mock("@/lib/remote-video-binding", () => ({
  bindRemoteVideo: () => () => {},
}));

// The desktop shell is a fact about the window; the test flips it.
const desktop = vi.hoisted(() => ({ app: false }));
vi.mock("@/lib/desktop", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/desktop")>()),
  isDesktopApp: () => desktop.app,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { CallStage } = await import("./call-stage");

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


const CHANNEL = "33333333-3333-4333-8333-333333333333";

/** A display capture whose video track reports `displaySurface` and `label`. */
function captureStream(displaySurface: string | undefined, label = ""): MediaStream {
  const track = {
    kind: "video",
    label,
    getSettings: () => (displaySurface ? { displaySurface } : {}),
  };
  return {
    ...(fakeStream() as unknown as object),
    getVideoTracks: () => [track],
  } as unknown as MediaStream;
}

function stateWith(shares: {
  self: boolean;
  friend: boolean;
  surface?: string;
  label?: string;
}): VoiceState {
  const friendStream = fakeStream();
  return {
    ...base,
    voiceChannelId: CHANNEL,
    peerId: "peer-me",
    isSharingScreen: shares.self,
    localScreenStream: shares.self
      ? captureStream(shares.surface, shares.label)
      : null,
    screenSharePeerIds: [
      ...(shares.friend ? ["peer-friend"] : []),
      ...(shares.self ? ["peer-me"] : []),
    ],
    remotePeers: [
      {
        peerId: "peer-friend",
        userId: "user-friend",
        displayName: "Amigo",
        avatarUrl: null,
        connectionState: "connected",
        cameraStream: null,
        screenStream: shares.friend ? friendStream : null,
        screenAudioStream: null,
      },
    ] as unknown as VoiceState["remotePeers"],
  };
}

let root: Root | null = null;
let host: HTMLElement | null = null;

function mount(voiceState: VoiceState) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <TooltipProvider>
        <CallStage
          channelId={CHANNEL}
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
        />
      </TooltipProvider>,
    );
  });
  return host;
}

const guard = (el: HTMLElement) =>
  el.querySelector("[data-self-mirror-guard]");
const liveVideos = (el: HTMLElement) => el.querySelectorAll("video");
const press = (el: HTMLElement, testId: string) => {
  const button = el.querySelector<HTMLButtonElement>(`[data-testid=${testId}]`);
  expect(button, testId).not.toBeNull();
  act(() => button!.click());
};

beforeEach(() => {
  localStorage.clear();
  resetHideScreenPreviewForTests();
  desktop.app = false;
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

/**
 * Feedback #130: a presenter sharing the whole screen clicked their own
 * preview, which fills the window, and the picture "started bugging": the
 * capture contains this window, this window shows the capture, so each frame
 * is a copy of a copy. The still card is what the enlarged tile shows instead.
 */
describe("own whole-screen share, enlarged", () => {
  it("keeps the live preview while the stage is not fullscreen", () => {
    const el = mount(stateWith({ self: true, friend: false, surface: "monitor" }));
    expect(guard(el)).toBeNull();
    expect(liveVideos(el).length).toBeGreaterThan(0);
  });

  it("swaps the live picture for a still card once it fills the window", () => {
    const el = mount(stateWith({ self: true, friend: false, surface: "monitor" }));
    press(el, "share-fullscreen");
    expect(guard(el)).not.toBeNull();
    expect(liveVideos(el)).toHaveLength(0);
    // The way out stays on screen.
    expect(el.querySelector("[data-testid=share-fullscreen]")).not.toBeNull();
  });

  it("shows the picture anyway on request, and asks again next time", () => {
    const el = mount(stateWith({ self: true, friend: false, surface: "monitor" }));
    press(el, "share-fullscreen");
    press(el, "share-mirror-show");
    expect(guard(el)).toBeNull();
    expect(liveVideos(el).length).toBeGreaterThan(0);
    press(el, "share-fullscreen");
    expect(guard(el)).toBeNull();
    press(el, "share-fullscreen");
    expect(guard(el)).not.toBeNull();
  });

  it("leaves a window or a tab share alone", () => {
    for (const surface of ["window", "browser"]) {
      const el = mount(stateWith({ self: true, friend: false, surface }));
      press(el, "share-fullscreen");
      expect(guard(el), surface).toBeNull();
      expect(liveVideos(el).length, surface).toBeGreaterThan(0);
      act(() => root?.unmount());
      host?.remove();
    }
  });

  it("treats a desktop-shell track with no surface as a possible screen", () => {
    desktop.app = true;
    const el = mount(stateWith({ self: true, friend: false }));
    press(el, "share-fullscreen");
    expect(guard(el)).not.toBeNull();
  });

  it("reads the shell's capturer id when the surface is missing", () => {
    desktop.app = true;
    const el = mount(
      stateWith({ self: true, friend: false, label: "window:1234:0" }),
    );
    press(el, "share-fullscreen");
    expect(guard(el)).toBeNull();
  });

  it("never touches a friend's share", () => {
    const el = mount(stateWith({ self: false, friend: true }));
    press(el, "share-fullscreen");
    expect(guard(el)).toBeNull();
  });
});

