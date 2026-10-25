// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceState } from "@/hooks/use-voice";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  resetHideScreenPreviewForTests,
  setHideScreenPreview,
} from "@/lib/screen-preview-pref";

// The tiles bind a MediaStream to a <video>; jsdom has neither.
vi.mock("@/lib/remote-video-binding", () => ({
  bindRemoteVideo: () => () => {},
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

function stateWith(shares: { self: boolean; friend: boolean }): VoiceState {
  const friendStream = fakeStream();
  return {
    ...base,
    voiceChannelId: CHANNEL,
    peerId: "peer-me",
    isSharingScreen: shares.self,
    localScreenStream: shares.self ? fakeStream() : null,
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

const strip = (el: HTMLElement) =>
  el.querySelector("[data-testid=own-share-strip]");
const gridTiles = (el: HTMLElement) =>
  el.querySelectorAll("[data-testid=stage-grid] > li");

beforeEach(() => {
  localStorage.clear();
  resetHideScreenPreviewForTests();
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("own share with its preview hidden", () => {
  it("is not a tile: the grid lays out the friend's screen alone", () => {
    setHideScreenPreview(true);
    const el = mount(stateWith({ self: true, friend: true }));
    expect(gridTiles(el)).toHaveLength(1);
    expect(el.querySelector("[data-self-preview-hidden]")).toBeNull();
    expect(strip(el)).not.toBeNull();
  });

  it("still draws both shares while the preview is shown, and no strip", () => {
    const el = mount(stateWith({ self: true, friend: true }));
    expect(gridTiles(el)).toHaveLength(2);
    expect(strip(el)).toBeNull();
  });

  it("brings the preview back from the strip, and stores it per device", () => {
    setHideScreenPreview(true);
    const el = mount(stateWith({ self: true, friend: true }));
    const show = el.querySelector<HTMLButtonElement>(
      "[data-testid=own-share-strip-show]",
    );
    expect(show?.textContent).toBe("Show preview");
    act(() => show!.click());
    expect(gridTiles(el)).toHaveLength(2);
    expect(strip(el)).toBeNull();
    expect(localStorage.getItem("pqp:hide-screen-preview")).toBe("0");
  });

  it("leaves no empty stage when the person is the only sharer", () => {
    setHideScreenPreview(true);
    const el = mount(stateWith({ self: true, friend: false }));
    expect(el.querySelector("[data-testid=stage-grid]")).toBeNull();
    expect(strip(el)).not.toBeNull();
  });

  it("leaves no stale strip once the share stops or somebody else starts", () => {
    setHideScreenPreview(true);
    const el = mount(stateWith({ self: false, friend: true }));
    expect(strip(el)).toBeNull();
    expect(gridTiles(el)).toHaveLength(1);
  });
});
