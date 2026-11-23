// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceState } from "@/hooks/use-voice";
import type { RemotePeer } from "@/lib/peer-connection-manager";

// The popout binds a MediaStream to a <video>; jsdom has neither.
vi.mock("@/lib/remote-video-binding", () => ({
  bindRemoteVideo: () => () => {},
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { SharePopout } = await import("./share-popout");
const { dispatchShareView, resetShareViewForTests, shareViewMode } = await import(
  "@/lib/share-view-store"
);

const fakeStream = () =>
  ({
    getTracks: () => [],
    getAudioTracks: () => [],
    getVideoTracks: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
  }) as unknown as MediaStream;

const sharer = (peerId: string, displayName: string): RemotePeer =>
  ({
    peerId,
    displayName,
    connectionState: "connected",
    stream: null,
    screenStream: fakeStream(),
    cameraStream: null,
    screenAudioStream: null,
  }) as RemotePeer;

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
  shareInvitePeerIds: [],
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

function state(over: Partial<VoiceState>): VoiceState {
  return { ...base, ...over };
}

describe("SharePopout", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    resetShareViewForTests();
  });

  const twoSharers = state({
    remotePeers: [sharer("p2", "Ana"), sharer("p3", "Bia")],
    screenSharePeerIds: ["p2", "p3"],
    focusedScreenPeerId: "p3",
  });

  function render(voiceState: VoiceState, over: Partial<Parameters<typeof SharePopout>[0]> = {}) {
    const props = {
      voiceState,
      enabled: true,
      call: { name: "Geral", serverName: "QG" },
      viewingCallChannel: false,
      onGoToCall: vi.fn(),
      onFocusShare: vi.fn(),
      onDismissShare: vi.fn(),
      ...over,
    };
    act(() => root.render(<SharePopout {...props} />));
    return props;
  }

  const popout = () => container.querySelector<HTMLElement>("[data-testid='share-popout']");

  it("draws nothing while the popout does not apply to the call", () => {
    render(twoSharers, { enabled: false });
    expect(popout()).toBeNull();
  });

  it("draws nothing while every share waits for Assistir", () => {
    render(state({ ...twoSharers, dismissedSharePeerIds: ["p2", "p3"] }));
    expect(popout()).toBeNull();
  });

  it("shows the focused share and names the call", () => {
    render(twoSharers);
    expect(popout()?.getAttribute("data-share-popout")).toBe("p3");
    expect(container.querySelector("[data-testid='share-popout-call']")?.textContent).toContain(
      "Geral · QG",
    );
  });

  it("switches to the share picked in the switcher and makes it the one heard", () => {
    const props = render(twoSharers);
    const select = container.querySelector<HTMLSelectElement>("[data-testid='share-popout-switch']")!;
    act(() => {
      select.value = "p2";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(popout()?.getAttribute("data-share-popout")).toBe("p2");
    expect(props.onFocusShare).toHaveBeenCalledWith("p2");
  });

  it("close moves to the other share still watched instead of hiding", () => {
    const props = render(twoSharers);
    act(() => container.querySelector<HTMLButtonElement>("[data-testid='share-popout-close']")!.click());
    expect(props.onDismissShare).toHaveBeenCalledWith("p3");
    // The voice state now has p3 dismissed: p2 takes the popout.
    render(state({ ...twoSharers, dismissedSharePeerIds: ["p3"] }));
    expect(popout()?.getAttribute("data-share-popout")).toBe("p2");
  });

  it("close on the last watched share hides the popout and it stays closed", () => {
    const one = state({ ...twoSharers, dismissedSharePeerIds: ["p2"] });
    const props = render(one);
    act(() => container.querySelector<HTMLButtonElement>("[data-testid='share-popout-close']")!.click());
    expect(props.onDismissShare).toHaveBeenCalledWith("p3");
    render(state({ ...twoSharers, dismissedSharePeerIds: ["p2", "p3"] }));
    expect(popout()).toBeNull();
  });

  it("comes back with the share the person chooses to watch", () => {
    render(state({ ...twoSharers, dismissedSharePeerIds: ["p2", "p3"] }));
    expect(popout()).toBeNull();
    render(state({ ...twoSharers, dismissedSharePeerIds: ["p3"] }));
    expect(popout()?.getAttribute("data-share-popout")).toBe("p2");
  });

  it("goes back to the call from another channel", () => {
    const props = render(twoSharers);
    act(() => container.querySelector<HTMLButtonElement>("[data-testid='share-popout-call']")!.click());
    expect(props.onGoToCall).toHaveBeenCalled();
  });

  it("maximizes from another channel by going back to the call", () => {
    const props = render(twoSharers);
    act(() => container.querySelector<HTMLButtonElement>("[data-testid='share-popout-maximize']")!.click());
    expect(shareViewMode()).toBe("theater");
    expect(props.onGoToCall).toHaveBeenCalled();
    // Still elsewhere: the picture keeps floating until the call is on screen.
    expect(popout()).not.toBeNull();
  });

  it("gives the call's own channel to the theater and floats nothing over it", () => {
    render(twoSharers, { viewingCallChannel: true });
    act(() => dispatchShareView({ type: "maximize" }));
    render(twoSharers, { viewingCallChannel: true });
    expect(popout()).toBeNull();
    act(() => dispatchShareView({ type: "minimize" }));
    render(twoSharers, { viewingCallChannel: true });
    expect(popout()).not.toBeNull();
  });

  it("leaves the audio alone in the theater and follows the share chosen there", () => {
    const onFocusShare = vi.fn();
    render(twoSharers, { viewingCallChannel: true, onFocusShare });
    expect(popout()?.getAttribute("data-share-popout")).toBe("p3");
    act(() => dispatchShareView({ type: "maximize" }));
    onFocusShare.mockClear();
    // A tile put in fullscreen in the theater focuses p2.
    render(state({ ...twoSharers, focusedScreenPeerId: "p2" }), {
      viewingCallChannel: true,
      onFocusShare,
    });
    expect(onFocusShare).not.toHaveBeenCalled();
    // Minimized, the popout shows the share they were watching.
    act(() => dispatchShareView({ type: "minimize" }));
    render(state({ ...twoSharers, focusedScreenPeerId: "p2" }), {
      viewingCallChannel: true,
      onFocusShare,
    });
    expect(popout()?.getAttribute("data-share-popout")).toBe("p2");
    expect(onFocusShare).not.toHaveBeenCalledWith("p3");
  });
});
