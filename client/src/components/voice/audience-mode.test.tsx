// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VoiceParticipant } from "@pqp/shared";
import type { VoiceState } from "@/hooks/use-voice";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { AudienceModeHostControls } from "./audience-mode";

/*
 * AUDIENCE MODE IN THE CALL CONTROLS (`docs/plans/AUDIENCE_MODE.md`, (e) and
 * (f)): the mic says why it is locked and is never a silent no-op, the hand
 * becomes the primary control for the audience, a host gets one toggle with a
 * visible ON, a one-tap "Liberar o microfone" on every raised hand (on the
 * slim bar too), a "Silenciar" per person let in, and a warning naming
 * whoever the media server has not confirmed silenced.
 */
vi.mock("@/components/voice/capabilities", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/voice/capabilities")>();
  return { ...actual, supportsScreenShare: () => true, canShareScreenAudio: () => false };
});
vi.mock("@/lib/desktop", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/desktop")>();
  return { ...actual, isDesktopApp: () => false };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);
Element.prototype.scrollIntoView = () => {};

const { CallControls } = await import("./call-stage");

const CHANNEL = "33333333-3333-4333-8333-333333333333";
const HOST = "host-user";
const ALBERTO = "alberto-user";
const BIA = "bia-user";

function person(userId: string, name: string, extra: Partial<VoiceParticipant> = {}): VoiceParticipant {
  return {
    peerId: `peer-${userId}`,
    userId,
    displayName: name,
    avatarUrl: null,
    sharingScreen: false,
    muted: true,
    deafened: false,
    serverMuted: false,
    handRaisedAt: null,
    ...extra,
  };
}

const room = [
  person(HOST, "Host"),
  person(ALBERTO, "Alberto", { canSpeak: false, handRaisedAt: 100 }),
  person(BIA, "Bia", { canSpeak: true }),
];

function stateFor(overrides: Partial<VoiceState>): VoiceState {
  return {
    status: "connected",
    peerId: "peer-me",
    remotePeers: [],
    uplinkBps: null,
    isMuted: true,
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
    voiceChannelId: CHANNEL,
    self: null,
    speakingPeerIds: [],
    serverMutedPeerIds: [],
    speakLockedPeerIds: [],
    speakReason: null,
    audience: null,
    audienceChange: null,
    handRaisedAt: null,
    occupancy: { [CHANNEL]: room },
    peerVolumes: {},
    screenVolumes: {},
    usingSfu: true,
    transportFailure: null,
    roomTransport: "livekit",
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
    dismissedCameraPeerIds: [],
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
    ...overrides,
  };
}

const ON = { since: 1, byUserId: HOST, speakerUserIds: [] as string[], unenforcedUserIds: [] as string[] };

let host: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(
  voiceState: VoiceState,
  audienceHost: AudienceModeHostControls | null = null,
  collapsed = false,
) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <TooltipProvider>
        <CallControls
          voiceState={voiceState}
          collapsed={collapsed}
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
          onToggleRaisedHand={() => {}}
          canLowerHands={audienceHost !== null}
          onLowerHand={() => {}}
          audienceHost={audienceHost}
        />
      </TooltipProvider>,
    );
  });
  return host;
}

function hostControls(overrides: Partial<AudienceModeHostControls> = {}): AudienceModeHostControls {
  return {
    available: true,
    busy: false,
    onToggle: vi.fn(),
    onAllow: vi.fn(),
    onSilence: vi.fn(),
    enforcement: null,
    ...overrides,
  };
}

afterEach(() => {
  if (root) {
    act(() => root!.unmount());
  }
  host?.remove();
  host = null;
  root = null;
});

describe("the audience's side", () => {
  it("the mic is disabled and says why; the hand is the primary control", () => {
    const view = mount(
      stateFor({
        canSpeak: false,
        canStream: false,
        speakReason: "audience",
        audience: ON,
        self: person(ALBERTO, "Alberto", { canSpeak: false }),
      }),
    );
    const mic = view.querySelector<HTMLButtonElement>("[data-speak-locked]")!;
    expect(mic.disabled).toBe(true);
    expect(mic.dataset.speakLocked).toBe("audience");
    expect(mic.getAttribute("aria-label")).toBe("Audience mode: only the presenters talk");
    const hand = view.querySelector<HTMLButtonElement>("[data-raise-hand]")!;
    expect(hand.hasAttribute("data-primary")).toBe(true);
    expect(hand.getAttribute("aria-label")).toBe("Ask to talk");
    expect(view.querySelector("[data-audience-line]")?.getAttribute("data-audience-line")).toBe(
      "locked",
    );
    expect(view.textContent).toContain("Only the presenters talk. Raise your hand to ask.");
    // Nobody but a host gets the toggle or the allow buttons.
    expect(view.querySelector("[data-audience-toggle]")).toBeNull();
    expect(view.querySelector("[data-audience-allow]")).toBeNull();
  });

  it("a channel that denies SPEAK is still told it is the channel, not audience mode", () => {
    const view = mount(stateFor({ canSpeak: false, speakReason: "permission" }));
    const mic = view.querySelector<HTMLButtonElement>("[data-speak-locked]")!;
    expect(mic.dataset.speakLocked).toBe("permission");
    expect(mic.getAttribute("aria-label")).toContain("do not have permission");
  });

  it("the notice says who changed it, and nothing is drawn when it is off and quiet", () => {
    const quiet = mount(stateFor({}));
    expect(quiet.querySelector("[data-audience-strip]")).toBeNull();
    act(() => root!.unmount());
    host!.remove();
    const view = mount(
      stateFor({
        audience: ON,
        audienceChange: { kind: "on", byUserId: HOST, at: Date.now() },
      }),
    );
    expect(view.querySelector("[data-audience-notice]")?.textContent).toBe(
      "Host turned audience mode on",
    );
  });
});

describe("the host's side", () => {
  it("one toggle, off by default, that turns it on", () => {
    const controls = hostControls();
    const view = mount(stateFor({}), controls);
    const toggle = view.querySelector<HTMLButtonElement>("[data-audience-toggle]")!;
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    act(() => toggle.click());
    expect(controls.onToggle).toHaveBeenCalledTimes(1);
  });

  it("its ON state is visible, and the off switch stays even when the flag went off", () => {
    const view = mount(stateFor({ audience: ON }), hostControls({ available: false }));
    const toggle = view.querySelector<HTMLButtonElement>("[data-audience-toggle]")!;
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(toggle.dataset.audienceToggle).toBe("on");
  });

  it("is not offered at all where the flag is off and it is not on", () => {
    const view = mount(stateFor({}), hostControls({ available: false }));
    expect(view.querySelector("[data-audience-toggle]")).toBeNull();
  });

  it("every raised hand gets a one-tap Liberar o microfone", () => {
    const controls = hostControls();
    const view = mount(stateFor({ audience: ON }), controls);
    const allow = view.querySelector<HTMLButtonElement>(`[data-audience-allow="${ALBERTO}"]`)!;
    expect(allow.getAttribute("aria-label")).toBe("Let Alberto talk");
    act(() => allow.click());
    expect(controls.onAllow).toHaveBeenCalledWith(ALBERTO);
  });

  it("on the slim bar the first hand gets it too", () => {
    const controls = hostControls();
    // The slim bar's queue lives in the people cell the stage passes as
    // `leading`; here we only check the strip and toggle survive collapse.
    const view = mount(stateFor({ audience: ON }), controls, true);
    expect(view.querySelector("[data-audience-toggle]")).not.toBeNull();
    expect(view.querySelector("[data-audience-strip]")).not.toBeNull();
  });

  it("the people let in are listed with a Silenciar each", () => {
    const controls = hostControls();
    const view = mount(stateFor({ audience: { ...ON, speakerUserIds: [BIA] } }), controls);
    const silence = view.querySelector<HTMLButtonElement>(`[data-audience-silence="${BIA}"]`)!;
    expect(silence.getAttribute("aria-label")).toBe("Send Bia back to the audience");
    act(() => silence.click());
    expect(controls.onSilence).toHaveBeenCalledWith(BIA);
  });

  it("names whoever the media server has not confirmed silenced, instead of claiming it worked", () => {
    const view = mount(
      stateFor({ audience: { ...ON, unenforcedUserIds: [ALBERTO] } }),
      hostControls(),
    );
    const warning = view.querySelector("[data-audience-unenforced]")!;
    expect(warning.getAttribute("role")).toBe("alert");
    expect(warning.textContent).toBe("Still audible: Alberto. Trying again.");
  });

  it("says the voice server did not answer when it could not list the room", () => {
    const view = mount(
      stateFor({ audience: ON }),
      hostControls({
        enforcement: { transport: "livekit", pendingUserIds: [], unreachable: true },
      }),
    );
    expect(view.querySelector("[data-audience-unenforced]")?.textContent).toBe(
      "The voice server did not answer. Trying again.",
    );
  });
});
