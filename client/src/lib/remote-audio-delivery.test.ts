import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUDIO_SILENCE_GRACE_MS,
  createRemoteAudioDelivery,
  remoteAudioPlan,
  sameAudioPlan,
  wantsRemoteAudio,
  type AudioDeliveryPublication,
  type RemoteAudioPlan,
} from "./remote-audio-delivery";
import { resolvePeerPlaybackVolume } from "@/components/voice/voice-audio-sinks";

/**
 * The rule that stops forwarding sound nobody is listening to.
 *
 * The dangerous failure here is not "we paid for a byte we did not need"; it
 * is a room where somebody has silently gone quiet. So the plan is asserted
 * against the same values `VoiceAudioSinks` reads, and the controller is
 * asserted on the exact sequence of `setEnabled` calls.
 */

function publication() {
  const calls: boolean[] = [];
  const pub: AudioDeliveryPublication & { calls: boolean[] } = {
    calls,
    setEnabled(enabled: boolean) {
      calls.push(enabled);
    },
  };
  return pub;
}

const peers = [
  { peerId: "p1", userId: "u1" },
  { peerId: "p2", userId: "u2" },
];

function planFor(overrides: Partial<Parameters<typeof remoteAudioPlan>[0]> = {}) {
  return remoteAudioPlan({
    peers,
    isDeafened: false,
    peerVolumes: {},
    screenVolumes: {},
    serverMutedPeerIds: [],
    audibleScreenPeerIds: ["p1", "p2"],
    ...overrides,
  });
}

describe("what the listener wants to hear", () => {
  it("wants everybody by default", () => {
    const plan = planFor();
    expect(plan.deafened).toBe(false);
    expect(plan.silentVoicePeerIds).toEqual([]);
    expect(plan.silentScreenPeerIds).toEqual([]);
    expect(wantsRemoteAudio(plan, "p1", "voice")).toBe(true);
    expect(wantsRemoteAudio(plan, "p1", "screen")).toBe(true);
  });

  it("wants nothing at all while deafened", () => {
    const plan = planFor({ isDeafened: true });
    expect(wantsRemoteAudio(plan, "p1", "voice")).toBe(false);
    expect(wantsRemoteAudio(plan, "p2", "screen")).toBe(false);
    // Even a peer nobody has an opinion about.
    expect(wantsRemoteAudio(plan, "stranger", "voice")).toBe(false);
  });

  it("drops the voice of somebody turned all the way down, and only theirs", () => {
    const plan = planFor({ peerVolumes: { u1: 0, u2: 0.4 } });
    expect(plan.silentVoicePeerIds).toEqual(["p1"]);
    expect(wantsRemoteAudio(plan, "p1", "voice")).toBe(false);
    expect(wantsRemoteAudio(plan, "p2", "voice")).toBe(true);
    // Turning a person's voice down says nothing about their share.
    expect(wantsRemoteAudio(plan, "p1", "screen")).toBe(true);
  });

  it("drops the voice of a peer a moderator muted for everyone", () => {
    const plan = planFor({ serverMutedPeerIds: ["p2"] });
    expect(plan.silentVoicePeerIds).toEqual(["p2"]);
    expect(wantsRemoteAudio(plan, "p2", "voice")).toBe(false);
    // The sanction is on the microphone, so their share is untouched.
    expect(wantsRemoteAudio(plan, "p2", "screen")).toBe(true);
  });

  it("drops a share's sound that is turned down, or that is not being played", () => {
    expect(
      planFor({ screenVolumes: { u1: 0 } }).silentScreenPeerIds,
    ).toEqual(["p1"]);
    expect(
      planFor({ audibleScreenPeerIds: ["p2"] }).silentScreenPeerIds,
    ).toEqual(["p1"]);
  });

  it("fails open for a peer it has never heard of", () => {
    const plan = planFor({ peerVolumes: { u1: 0 }, isDeafened: false });
    expect(wantsRemoteAudio(plan, "arrived-just-now", "voice")).toBe(true);
    expect(wantsRemoteAudio(plan, "arrived-just-now", "screen")).toBe(true);
  });
});

/**
 * The one property that must hold: a sound the plan stops is a sound the
 * `<audio>` element was already playing at zero. Asserted against the sink's
 * own arithmetic rather than a copy of it, so the day somebody changes the
 * sink this fails rather than drifting.
 */
describe("the plan and the audio sinks agree", () => {
  const cases: {
    name: string;
    volumes: Record<string, number>;
    muted: string[];
    deafened: boolean;
  }[] = [
    { name: "ordinary", volumes: {}, muted: [], deafened: false },
    { name: "turned down", volumes: { u1: 0 }, muted: [], deafened: false },
    { name: "server muted", volumes: {}, muted: ["p1"], deafened: false },
    { name: "deafened", volumes: {}, muted: [], deafened: true },
  ];

  for (const testCase of cases) {
    it(`matches the sink for ${testCase.name}`, () => {
      const plan = remoteAudioPlan({
        peers,
        isDeafened: testCase.deafened,
        peerVolumes: testCase.volumes,
        screenVolumes: {},
        serverMutedPeerIds: testCase.muted,
        audibleScreenPeerIds: ["p1", "p2"],
      });
      for (const peer of peers) {
        const sinkVolume = resolvePeerPlaybackVolume(
          testCase.volumes[peer.userId],
          testCase.muted.includes(peer.peerId),
        );
        const sinkIsSilent = testCase.deafened || sinkVolume === 0;
        expect(wantsRemoteAudio(plan, peer.peerId, "voice")).toBe(!sinkIsSilent);
      }
    });
  }
});

describe("comparing two plans", () => {
  const base: RemoteAudioPlan = {
    deafened: false,
    silentVoicePeerIds: ["p1"],
    silentScreenPeerIds: [],
  };
  it("is true for the same plan twice", () => {
    expect(sameAudioPlan(base, { ...base })).toBe(true);
  });
  it("notices deafen, and each list", () => {
    expect(sameAudioPlan(base, { ...base, deafened: true })).toBe(false);
    expect(
      sameAudioPlan(base, { ...base, silentVoicePeerIds: ["p2"] }),
    ).toBe(false);
    expect(
      sameAudioPlan(base, { ...base, silentScreenPeerIds: ["p1"] }),
    ).toBe(false);
  });
});

describe("stopping and starting the bytes", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("leaves a wanted track alone", () => {
    const delivery = createRemoteAudioDelivery();
    const pub = publication();
    delivery.setPlan(planFor());
    delivery.register(pub, "p1", "voice");
    vi.advanceTimersByTime(AUDIO_SILENCE_GRACE_MS * 3);
    expect(pub.calls).toEqual([]);
    expect(delivery.isPaused(pub)).toBe(false);
  });

  it("stops a silenced track after the grace, not before", () => {
    const delivery = createRemoteAudioDelivery();
    const pub = publication();
    delivery.register(pub, "p1", "voice");
    delivery.setPlan(planFor({ peerVolumes: { u1: 0 } }));
    vi.advanceTimersByTime(AUDIO_SILENCE_GRACE_MS - 1);
    expect(pub.calls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(pub.calls).toEqual([false]);
    expect(delivery.isPaused(pub)).toBe(true);
  });

  it("never stops a slider dragged through zero and back", () => {
    const delivery = createRemoteAudioDelivery();
    const pub = publication();
    delivery.register(pub, "p1", "voice");
    delivery.setPlan(planFor({ peerVolumes: { u1: 0 } }));
    vi.advanceTimersByTime(AUDIO_SILENCE_GRACE_MS / 2);
    delivery.setPlan(planFor({ peerVolumes: { u1: 0.3 } }));
    vi.advanceTimersByTime(AUDIO_SILENCE_GRACE_MS * 3);
    expect(pub.calls).toEqual([]);
  });

  it("starts a stopped track again the instant it is wanted", () => {
    const delivery = createRemoteAudioDelivery();
    const pub = publication();
    delivery.register(pub, "p1", "voice");
    delivery.setPlan(planFor({ isDeafened: true }));
    vi.advanceTimersByTime(AUDIO_SILENCE_GRACE_MS);
    expect(pub.calls).toEqual([false]);
    delivery.setPlan(planFor());
    expect(pub.calls).toEqual([false, true]);
    expect(delivery.isPaused(pub)).toBe(false);
  });

  it("stops a track that was already unwanted when it arrived", () => {
    const delivery = createRemoteAudioDelivery();
    const pub = publication();
    delivery.setPlan(planFor({ isDeafened: true }));
    delivery.register(pub, "p2", "screen");
    vi.advanceTimersByTime(AUDIO_SILENCE_GRACE_MS);
    expect(pub.calls).toEqual([false]);
  });

  it("keeps a peer's voice while only their share is silenced", () => {
    const delivery = createRemoteAudioDelivery();
    const voice = publication();
    const screen = publication();
    delivery.register(voice, "p1", "voice");
    delivery.register(screen, "p1", "screen");
    delivery.setPlan(planFor({ screenVolumes: { u1: 0 } }));
    vi.advanceTimersByTime(AUDIO_SILENCE_GRACE_MS);
    expect(voice.calls).toEqual([]);
    expect(screen.calls).toEqual([false]);
  });

  it("forgets an unregistered track rather than firing its timer at it", () => {
    const delivery = createRemoteAudioDelivery();
    const pub = publication();
    delivery.register(pub, "p1", "voice");
    delivery.setPlan(planFor({ isDeafened: true }));
    delivery.unregister(pub);
    vi.advanceTimersByTime(AUDIO_SILENCE_GRACE_MS * 3);
    expect(pub.calls).toEqual([]);
  });

  it("survives a publication whose setEnabled throws", () => {
    const delivery = createRemoteAudioDelivery();
    const angry: AudioDeliveryPublication = {
      setEnabled() {
        throw new Error("not subscribed");
      },
    };
    const calm = publication();
    delivery.register(angry, "p1", "voice");
    delivery.register(calm, "p2", "voice");
    delivery.setPlan(planFor({ isDeafened: true }));
    expect(() => vi.advanceTimersByTime(AUDIO_SILENCE_GRACE_MS)).not.toThrow();
    expect(calm.calls).toEqual([false]);
  });

  it("drops every timer on dispose without resuming anything", () => {
    const delivery = createRemoteAudioDelivery();
    const pub = publication();
    delivery.register(pub, "p1", "voice");
    delivery.setPlan(planFor({ isDeafened: true }));
    delivery.dispose();
    vi.advanceTimersByTime(AUDIO_SILENCE_GRACE_MS * 3);
    expect(pub.calls).toEqual([]);
  });
});
