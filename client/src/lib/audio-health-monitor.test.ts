import { describe, expect, it, vi } from "vitest";
import {
  createAudioHealthMonitor,
  currentAudioHealthSummary,
  registerAudioHealthSummary,
  type AudioHealthActions,
  type AudioHealthReport,
  type AudioHealthView,
} from "./audio-health-monitor";
import type { AudioHealthPrompt } from "./audio-health";
import type { AudioStatsSample } from "./voice-stats-probe";

function view(extra: Partial<AudioHealthView> = {}): AudioHealthView {
  return {
    connected: true,
    usingSfu: false,
    expectSending: true,
    micTrack: { id: "mic-1", readyState: "live" },
    micUnavailable: false,
    sharingScreen: false,
    sfuMissingPublication: false,
    deafened: false,
    peers: [{ peerId: "bob", connected: true, expectAudio: true, micTrackId: "bob-mic" }],
    ...extra,
  };
}

function actions(extra: Partial<AudioHealthActions> = {}): AudioHealthActions {
  return {
    reattachMic: vi.fn(async () => {}),
    reopenMic: vi.fn(async () => {}),
    publishMic: vi.fn(async () => {}),
    rejoinWithMic: vi.fn(async () => {}),
    restartInbound: vi.fn(async () => {}),
    replayPlayback: vi.fn(async () => true),
    stuckPlayback: vi.fn(() => 0),
    takeOutputMissing: vi.fn(() => 0),
    ...extra,
  };
}

/** Our mic reaches bob; bob's voice reaches us. */
function healthyAudio(): AudioStatsSample {
  return {
    senders: [{ peerId: "bob", trackId: "mic-1", packetsDelta: 100, audioLevel: 0.1, energyDelta: 0.003 }],
    receivers: [{ peerId: "bob", trackId: "bob-mic", packetsDelta: 100, audioLevel: 0.05 }],
  };
}

function setup(options: { view?: () => AudioHealthView; actions?: AudioHealthActions } = {}) {
  let clock = 0;
  const prompts: (AudioHealthPrompt | null)[] = [];
  const reports: AudioHealthReport[] = [];
  const acts = options.actions ?? actions();
  const monitor = createAudioHealthMonitor({
    view: options.view ?? (() => view()),
    actions: acts,
    now: () => clock,
    onPrompt: (prompt) => prompts.push(prompt),
    report: (event) => reports.push(event),
  });
  return {
    monitor,
    acts,
    prompts,
    reports,
    async tick(audio: AudioStatsSample, speaking = true) {
      clock += 2_000;
      if (speaking) {
        monitor.noteLocalSpeaking();
      }
      await monitor.sample(audio);
    },
    advance(ms: number) {
      clock += ms;
    },
  };
}

describe("createAudioHealthMonitor: our voice", () => {
  const silentMic: AudioStatsSample = {
    ...healthyAudio(),
    senders: [{ peerId: "bob", trackId: "mic-1", packetsDelta: 100, audioLevel: 0, energyDelta: 0 }],
  };

  it("re-attaches, then reopens, then asks, then reopens on the tap", async () => {
    const t = setup();
    for (let i = 0; i < 3; i += 1) {
      await t.tick(silentMic);
    }
    expect(t.acts.reattachMic).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 3; i += 1) {
      await t.tick(silentMic);
    }
    expect(t.acts.reopenMic).toHaveBeenCalledTimes(1);
    expect(t.prompts).toEqual([]);
    for (let i = 0; i < 3; i += 1) {
      await t.tick(silentMic);
    }
    expect(t.prompts).toEqual(["mic"]);
    expect(t.monitor.prompt()).toBe("mic");

    await t.monitor.repair();
    expect(t.acts.reopenMic).toHaveBeenCalledTimes(2);
    expect(t.prompts).toEqual(["mic", null]);
    // Healthy for the verify window: the tap worked.
    for (let i = 0; i < 16; i += 1) {
      await t.tick(healthyAudio());
    }
    expect(t.monitor.summary()).toEqual({
      micNotSending: { detected: 1, autoFixed: 0, asked: 1, manualFixed: 1, unresolved: 0 },
    });
    expect(t.reports.map((r) => r.outcome)).toEqual([
      "detected",
      "auto-repair",
      "auto-repair",
      "asked",
      "manual-repair",
      "manual-fixed",
    ]);
    expect(t.reports[0]).toMatchObject({ kind: "micNotSending", transport: "mesh", reason: "silent-source" });
  });

  it("a quiet re-attach that holds is an auto fix and never shows a card", async () => {
    const t = setup();
    for (let i = 0; i < 3; i += 1) {
      await t.tick(silentMic);
    }
    for (let i = 0; i < 16; i += 1) {
      await t.tick(healthyAudio());
    }
    expect(t.prompts).toEqual([]);
    expect(t.monitor.summary().micNotSending).toMatchObject({ detected: 1, autoFixed: 1 });
  });

  it("a mesh sender left on an old track is caught when it is the only one", async () => {
    const stale: AudioStatsSample = {
      ...healthyAudio(),
      senders: [{ peerId: "bob", trackId: "mic-0", packetsDelta: 100, audioLevel: 0.1, energyDelta: 0.003 }],
    };
    const t = setup();
    for (let i = 0; i < 3; i += 1) {
      await t.tick(stale);
    }
    expect(t.reports[0]).toMatchObject({ reason: "stale-track" });
    // With a share up the other sender may be the share's audio: no verdict.
    const sharing = setup({ view: () => view({ sharingScreen: true }) });
    for (let i = 0; i < 6; i += 1) {
      await sharing.tick(stale);
    }
    expect(sharing.reports).toEqual([]);
  });

  it("nothing is judged while the person is not talking, or not meant to be heard", async () => {
    const quiet = setup();
    for (let i = 0; i < 8; i += 1) {
      await quiet.tick(silentMic, false);
    }
    expect(quiet.reports).toEqual([]);
    const muted = setup({ view: () => view({ expectSending: false }) });
    for (let i = 0; i < 8; i += 1) {
      await muted.tick(silentMic);
    }
    expect(muted.reports).toEqual([]);
  });

  it("SFU: a missing publication is published, and a clone's id is never called stale", async () => {
    const t = setup({ view: () => view({ usingSfu: true, sfuMissingPublication: true }) });
    for (let i = 0; i < 3; i += 1) {
      await t.tick({ senders: [], receivers: [] });
    }
    expect(t.acts.publishMic).toHaveBeenCalledTimes(1);
    const clone = setup({ view: () => view({ usingSfu: true }) });
    const cloned: AudioStatsSample = {
      senders: [{ peerId: "me", trackId: "clone-9", packetsDelta: 100, audioLevel: 0.1, energyDelta: 0.003 }],
      receivers: [],
    };
    for (let i = 0; i < 6; i += 1) {
      await clone.tick(cloned);
    }
    expect(clone.reports).toEqual([]);
  });
});

describe("createAudioHealthMonitor: their voices", () => {
  it("SFU: resubscribes the peer the server hears and we do not, then asks", async () => {
    const t = setup({ view: () => view({ usingSfu: true }) });
    const deaf: AudioStatsSample = {
      senders: [],
      receivers: [{ peerId: "bob", trackId: null, packetsDelta: 0, audioLevel: null, remoteSpeaking: true }],
    };
    await t.tick(deaf, false);
    await t.tick(deaf, false);
    expect(t.acts.restartInbound).toHaveBeenCalledWith("bob");
    await t.tick(deaf, false);
    await t.tick(deaf, false);
    expect(t.acts.restartInbound).toHaveBeenCalledTimes(2);
    await t.tick(deaf, false);
    await t.tick(deaf, false);
    expect(t.prompts).toEqual(["hearing"]);
    await t.monitor.repair();
    expect(t.acts.replayPlayback).toHaveBeenCalled();
    expect(t.acts.restartInbound).toHaveBeenCalledTimes(3);
  });

  it("mesh: restarts a path that has carried nothing for ten seconds", async () => {
    const t = setup();
    const nothing: AudioStatsSample = {
      ...healthyAudio(),
      receivers: [{ peerId: "bob", trackId: "bob-mic", packetsDelta: 0, audioLevel: null }],
    };
    for (let i = 0; i < 5; i += 1) {
      await t.tick(nothing, false);
    }
    expect(t.acts.restartInbound).toHaveBeenCalledWith("bob");
  });

  it("mesh: a peer muted on the roster or a share's audio row is never judged", async () => {
    const muted = setup({
      view: () =>
        view({ peers: [{ peerId: "bob", connected: true, expectAudio: false, micTrackId: "bob-mic" }] }),
    });
    const nothing: AudioStatsSample = {
      ...healthyAudio(),
      receivers: [{ peerId: "bob", trackId: "bob-mic", packetsDelta: 0, audioLevel: null }],
    };
    for (let i = 0; i < 8; i += 1) {
      await muted.tick(nothing, false);
    }
    const shareOnly = setup();
    const shareRow: AudioStatsSample = {
      ...healthyAudio(),
      receivers: [{ peerId: "bob", trackId: "bob-share", packetsDelta: 0, audioLevel: null }],
    };
    for (let i = 0; i < 8; i += 1) {
      await shareOnly.tick(shareRow, false);
    }
    expect(muted.acts.restartInbound).not.toHaveBeenCalled();
    expect(shareOnly.acts.restartInbound).not.toHaveBeenCalled();
  });
});

describe("createAudioHealthMonitor: playback, microphone, output", () => {
  it("a stuck element is replayed, and asks when the browser still refuses", async () => {
    let stuck = 1;
    const acts = actions({
      stuckPlayback: vi.fn(() => stuck),
      replayPlayback: vi.fn(async () => false),
    });
    const t = setup({ actions: acts });
    await t.tick(healthyAudio(), false);
    expect(acts.replayPlayback).toHaveBeenCalledTimes(1);
    await t.tick(healthyAudio(), false);
    expect(t.prompts).toEqual(["hearing"]);
    // A press anywhere played it: the card goes, counted as fixed by the tap
    // being taken elsewhere.
    stuck = 0;
    await t.tick(healthyAudio(), false);
    expect(t.prompts).toEqual(["hearing", null]);
    expect(t.monitor.summary().playbackBlocked).toMatchObject({ detected: 1, asked: 1, autoFixed: 1 });
  });

  it("a deafened listener's elements are never judged", async () => {
    const acts = actions({ stuckPlayback: vi.fn(() => 2) });
    const t = setup({ actions: acts, view: () => view({ deafened: true }) });
    await t.tick(healthyAudio(), false);
    await t.tick(healthyAudio(), false);
    expect(acts.replayPlayback).not.toHaveBeenCalled();
  });

  it("no microphone asks at once and rejoins on the tap, and the tally survives the rejoin", async () => {
    let unavailable = true;
    const t = setup({ view: () => view({ micUnavailable: unavailable, micTrack: unavailable ? null : { id: "m", readyState: "live" } }) });
    await t.tick(healthyAudio(), false);
    expect(t.prompts).toEqual(["micUnavailable"]);
    await t.monitor.repair();
    expect(t.acts.rejoinWithMic).toHaveBeenCalledTimes(1);
    unavailable = false;
    await t.tick(healthyAudio(), false);
    expect(t.monitor.summary().micUnavailable).toMatchObject({ asked: 1, manualFixed: 1 });
  });

  it("closing the card keeps it closed for the call", async () => {
    const t = setup({ view: () => view({ micUnavailable: true, micTrack: null }) });
    await t.tick(healthyAudio(), false);
    t.monitor.dismiss();
    await t.tick(healthyAudio(), false);
    await t.tick(healthyAudio(), false);
    expect(t.prompts).toEqual(["micUnavailable", null]);
  });

  it("a missing output found by the sinks is counted as found and fixed", async () => {
    const acts = actions({ takeOutputMissing: vi.fn().mockReturnValueOnce(1).mockReturnValue(0) });
    const t = setup({ actions: acts });
    await t.tick(healthyAudio(), false);
    expect(t.monitor.summary().outputMissing).toEqual({
      detected: 1,
      autoFixed: 1,
      asked: 0,
      manualFixed: 0,
      unresolved: 0,
    });
    expect(t.prompts).toEqual([]);
  });

  it("does nothing outside a connected call, and reset starts a new tally", async () => {
    const t = setup({ view: () => view({ connected: false, micUnavailable: true, micTrack: null }) });
    await t.tick(healthyAudio(), false);
    expect(t.reports).toEqual([]);
    const u = setup({ view: () => view({ micUnavailable: true, micTrack: null }) });
    await u.tick(healthyAudio(), false);
    u.monitor.reset();
    expect(u.prompts).toEqual(["micUnavailable", null]);
    expect(u.monitor.summary()).toEqual({});
  });

  it("the rating reads whatever monitor registered last", () => {
    registerAudioHealthSummary(null);
    expect(currentAudioHealthSummary()).toEqual({});
    registerAudioHealthSummary(() => ({
      outputMissing: { detected: 1, autoFixed: 1, asked: 0, manualFixed: 0, unresolved: 0 },
    }));
    expect(currentAudioHealthSummary().outputMissing?.detected).toBe(1);
    registerAudioHealthSummary(null);
  });
});

describe("createAudioHealthMonitor: lifecycle", () => {
  const silentMic: AudioStatsSample = {
    ...healthyAudio(),
    senders: [{ peerId: "bob", trackId: "mic-1", packetsDelta: 100, audioLevel: 0, energyDelta: 0 }],
  };

  it("a repair that never settles does not hold the monitor for the rest of the call", async () => {
    vi.useFakeTimers();
    try {
      const acts = actions({ reattachMic: vi.fn(() => new Promise<void>(() => {})) });
      const t = setup({ actions: acts });
      t.monitor.noteLocalSpeaking();
      await t.monitor.sample(silentMic);
      t.monitor.noteLocalSpeaking();
      await t.monitor.sample(silentMic);
      t.monitor.noteLocalSpeaking();
      const hung = t.monitor.sample(silentMic);
      await vi.advanceTimersByTimeAsync(10_000);
      await hung;
      // The next samples are judged again: the ladder reached the next rung.
      for (let i = 0; i < 3; i += 1) {
        t.monitor.noteLocalSpeaking();
        await t.monitor.sample(silentMic);
      }
      expect(acts.reopenMic).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a sample still repairing when the call stops judges nothing after", async () => {
    let release: () => void = () => {};
    let stuck = 0;
    const acts = actions({
      reattachMic: vi.fn(() => new Promise<void>((resolve) => (release = resolve))),
      stuckPlayback: vi.fn(() => stuck),
    });
    const t = setup({ actions: acts });
    for (let i = 0; i < 2; i += 1) {
      await t.tick(silentMic);
    }
    const inFlight = t.tick(silentMic);
    await Promise.resolve();
    t.monitor.pause();
    stuck = 1;
    release();
    await inFlight;
    // The playback check after the repair belonged to a stopped call.
    expect(acts.replayPlayback).not.toHaveBeenCalled();
  });

  it("a playback-only card does not restart peers from an episode that already healed", async () => {
    let stuck = 0;
    const acts = actions({
      stuckPlayback: vi.fn(() => stuck),
      replayPlayback: vi.fn(async () => false),
    });
    const t = setup({ actions: acts });
    const nothing: AudioStatsSample = {
      ...healthyAudio(),
      receivers: [{ peerId: "bob", trackId: "bob-mic", packetsDelta: 0, audioLevel: null }],
    };
    for (let i = 0; i < 5; i += 1) {
      await t.tick(nothing, false);
    }
    expect(acts.restartInbound).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 16; i += 1) {
      await t.tick(healthyAudio(), false);
    }
    stuck = 1;
    await t.tick(healthyAudio(), false);
    await t.tick(healthyAudio(), false);
    expect(t.monitor.prompt()).toBe("hearing");
    await t.monitor.repair();
    expect(acts.restartInbound).toHaveBeenCalledTimes(1);
  });
});

describe("createAudioHealthMonitor: the card's repair", () => {
  it("stops before restarting peers when the call ended while it was replaying", async () => {
    let release: (value: boolean) => void = () => {};
    const acts = actions({
      replayPlayback: vi.fn(
        () => new Promise<boolean>((resolve) => (release = resolve)),
      ),
    });
    const t = setup({ actions: acts, view: () => view({ usingSfu: true }) });
    const deaf: AudioStatsSample = {
      senders: [],
      receivers: [{ peerId: "bob", trackId: null, packetsDelta: 0, audioLevel: null, remoteSpeaking: true }],
    };
    for (let i = 0; i < 6; i += 1) {
      await t.tick(deaf, false);
    }
    expect(t.monitor.prompt()).toBe("hearing");
    const restartsBefore = (acts.restartInbound as ReturnType<typeof vi.fn>).mock.calls.length;
    const repair = t.monitor.repair();
    t.monitor.pause();
    release(true);
    await repair;
    expect(acts.restartInbound).toHaveBeenCalledTimes(restartsBefore);
  });

  it("restarts many stalled paths at once, and at most eight", async () => {
    const peers = Array.from({ length: 12 }, (_, i) => ({
      peerId: `p${i}`,
      connected: true,
      expectAudio: true,
      micTrackId: `p${i}-mic`,
    }));
    const t = setup({ view: () => view({ peers }) });
    const nothing: AudioStatsSample = {
      senders: [],
      receivers: peers.map((peer) => ({
        peerId: peer.peerId,
        trackId: peer.micTrackId,
        packetsDelta: 0,
        audioLevel: null,
      })),
    };
    for (let i = 0; i < 5; i += 1) {
      await t.tick(nothing, false);
    }
    expect(t.acts.restartInbound).toHaveBeenCalledTimes(8);
  });
});
