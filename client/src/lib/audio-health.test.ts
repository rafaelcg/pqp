import { describe, expect, it } from "vitest";
import {
  createAudioHealthTracker,
  createInboundDetector,
  createOutboundDetector,
  hasAudioHealth,
  kindsForPrompt,
  promptForKind,
  SILENT_SOURCE_ENERGY,
  type OutboundSenderEvidence,
  type OutboundTick,
} from "./audio-health";

const healthy: OutboundSenderEvidence = { trackMatches: true, energyDelta: 0.004, packetsDelta: 100 };

function tick(extra: Partial<OutboundTick> = {}): OutboundTick {
  return {
    expectSending: true,
    localSpeaking: true,
    trackEnded: false,
    missingPublication: false,
    senders: [healthy],
    ...extra,
  };
}

function feed(detector: ReturnType<typeof createOutboundDetector>, ticks: OutboundTick[]) {
  return ticks.map((t) => detector.update(t));
}

describe("createOutboundDetector", () => {
  it("stays quiet while the room gets what the meter hears", () => {
    const detector = createOutboundDetector();
    expect(feed(detector, Array.from({ length: 10 }, () => tick()))).toEqual(
      Array(10).fill(null),
    );
  });

  it("calls a silent source after three speaking ticks fed nothing", () => {
    const detector = createOutboundDetector();
    const dead = tick({ senders: [{ ...healthy, energyDelta: 0 }] });
    expect(feed(detector, [dead, dead, dead])).toEqual([null, null, "silent-source"]);
  });

  it("treats suppressed room noise as nothing being fed, and quiet speech as something", () => {
    const detector = createOutboundDetector();
    const noise = tick({ senders: [{ ...healthy, energyDelta: SILENT_SOURCE_ENERGY / 50 }] });
    expect(feed(detector, [noise, noise, noise])[2]).toBe("silent-source");
    const quiet = tick({ senders: [{ ...healthy, energyDelta: SILENT_SOURCE_ENERGY * 20 }] });
    expect(feed(detector, [quiet, quiet, quiet])).toEqual([null, null, null]);
  });

  it("names a sender left on an old track, and a sender sending no packets", () => {
    const stale = createOutboundDetector();
    const old = tick({ senders: [{ ...healthy, trackMatches: false }] });
    expect(feed(stale, [old, old, old])[2]).toBe("stale-track");
    const stuck = createOutboundDetector();
    const none = tick({ senders: [{ ...healthy, packetsDelta: 0 }] });
    expect(feed(stuck, [none, none, none])[2]).toBe("no-packets");
  });

  it("does not judge silence: ticks nobody spoke in are not evidence either way", () => {
    const detector = createOutboundDetector();
    const dead = tick({ senders: [{ ...healthy, energyDelta: 0 }] });
    const silent = tick({ localSpeaking: false, senders: [{ ...healthy, energyDelta: 0 }] });
    expect(feed(detector, [dead, silent, silent, dead])).toEqual([null, null, null, null]);
    // Three speaking ticks inside the five-tick window are needed.
    expect(detector.update(dead)).toBe("silent-source");
  });

  it("does not judge a muted, gated or deliberately held-back microphone", () => {
    const detector = createOutboundDetector();
    const held = tick({ expectSending: false, senders: [{ ...healthy, packetsDelta: 0 }] });
    expect(feed(detector, Array.from({ length: 6 }, () => held))).toEqual(Array(6).fill(null));
  });

  it("needs every copy dead: one healthy mesh peer means the microphone is fine", () => {
    const detector = createOutboundDetector();
    const half = tick({ senders: [healthy, { ...healthy, packetsDelta: 0 }] });
    expect(feed(detector, Array.from({ length: 6 }, () => half))).toEqual(Array(6).fill(null));
  });

  it("one healthy tick in the window clears the charge", () => {
    const detector = createOutboundDetector();
    const dead = tick({ senders: [{ ...healthy, energyDelta: 0 }] });
    expect(feed(detector, [dead, dead, tick(), dead])).toEqual([null, null, null, null]);
  });

  it("reports an ended published track at once, and a missing SFU publication", () => {
    expect(createOutboundDetector().update(tick({ trackEnded: true }))).toBe("track-ended");
    const detector = createOutboundDetector();
    const missing = tick({ missingPublication: true, senders: [] });
    expect(feed(detector, [missing, missing, missing])[2]).toBe("not-published");
  });

  it("starts over after a report, so a repair gets a fresh window", () => {
    const detector = createOutboundDetector();
    const dead = tick({ senders: [{ ...healthy, energyDelta: 0 }] });
    expect(feed(detector, [dead, dead, dead, dead, dead])).toEqual([
      null,
      null,
      "silent-source",
      null,
      null,
    ]);
  });
});

describe("createInboundDetector", () => {
  it("SFU: the server hears them speaking and nothing arrives here", () => {
    const detector = createInboundDetector();
    const t = { peerId: "a", expectAudio: true, remoteSpeaking: true, packetsDelta: 0 };
    expect(detector.update([t])).toEqual([]);
    expect(detector.update([t])).toEqual(["a"]);
    // Forgotten after the report: a fresh window for the repair.
    expect(detector.update([t])).toEqual([]);
  });

  it("SFU: a voice that arrives, or a peer not speaking, is never a fault", () => {
    const detector = createInboundDetector();
    for (let i = 0; i < 6; i += 1) {
      expect(
        detector.update([
          { peerId: "a", expectAudio: true, remoteSpeaking: true, packetsDelta: 80 },
          { peerId: "b", expectAudio: true, remoteSpeaking: false, packetsDelta: 0 },
        ]),
      ).toEqual([]);
    }
  });

  it("SFU: a read with no evidence (first read, failed read) is not a strike", () => {
    const detector = createInboundDetector();
    const unknown = { peerId: "a", expectAudio: true, remoteSpeaking: true, packetsDelta: null };
    const zero = { ...unknown, packetsDelta: 0 };
    expect(detector.update([unknown])).toEqual([]);
    expect(detector.update([unknown])).toEqual([]);
    expect(detector.update([zero])).toEqual([]);
    expect(detector.update([unknown])).toEqual([]);
    expect(detector.update([zero])).toEqual(["a"]);
  });

  it("SFU: a peer this listener silenced is not judged", () => {
    const detector = createInboundDetector();
    const t = { peerId: "a", expectAudio: false, remoteSpeaking: true, packetsDelta: 0 };
    for (let i = 0; i < 6; i += 1) {
      expect(detector.update([t])).toEqual([]);
    }
  });

  it("mesh: five ticks of zero packets from an unmuted peer", () => {
    const detector = createInboundDetector();
    const zero = { peerId: "a", expectAudio: true, remoteSpeaking: null, packetsDelta: 0 };
    const results = Array.from({ length: 5 }, () => detector.update([zero]));
    expect(results).toEqual([[], [], [], [], ["a"]]);
  });

  it("mesh: a packet, a mute or a missing receiver breaks the run", () => {
    const detector = createInboundDetector();
    const zero = { peerId: "a", expectAudio: true, remoteSpeaking: null, packetsDelta: 0 };
    const breakers = [
      { ...zero, packetsDelta: 3 },
      { ...zero, expectAudio: false },
      { ...zero, packetsDelta: null },
    ];
    for (const breaker of breakers) {
      for (let i = 0; i < 4; i += 1) {
        expect(detector.update([zero])).toEqual([]);
      }
      expect(detector.update([breaker])).toEqual([]);
    }
  });

  it("forgets a peer who left", () => {
    const detector = createInboundDetector();
    const zero = { peerId: "a", expectAudio: true, remoteSpeaking: null, packetsDelta: 0 };
    for (let i = 0; i < 4; i += 1) {
      detector.update([zero]);
    }
    detector.update([]);
    expect(detector.update([zero])).toEqual([]);
  });
});

describe("createAudioHealthTracker", () => {
  it("climbs silent rungs, then asks, and a tap proven over the window is a manual fix", () => {
    const events: string[] = [];
    const tracker = createAudioHealthTracker({
      onEvent: (kind, outcome) => events.push(`${kind}:${outcome}`),
    });
    expect(tracker.detected("micNotSending", 0)).toEqual({ action: "auto", step: 0 });
    expect(tracker.detected("micNotSending", 10_000)).toEqual({ action: "auto", step: 1 });
    expect(tracker.detected("micNotSending", 20_000)).toEqual({ action: "ask" });
    expect(tracker.asking()).toEqual(["micNotSending"]);
    expect(tracker.detected("micNotSending", 22_000)).toEqual({ action: "none" });
    expect(tracker.manualRepair("micNotSending", 25_000)).toBe(true);
    tracker.tick(40_000);
    expect(tracker.stage("micNotSending")).toBe("verifying-manual");
    tracker.tick(55_000);
    expect(tracker.stage("micNotSending")).toBe("idle");
    expect(tracker.summary()).toEqual({
      micNotSending: { detected: 1, autoFixed: 0, asked: 1, manualFixed: 1, unresolved: 0 },
    });
    expect(events).toEqual([
      "micNotSending:detected",
      "micNotSending:auto-repair",
      "micNotSending:auto-repair",
      "micNotSending:asked",
      "micNotSending:manual-repair",
      "micNotSending:manual-fixed",
    ]);
  });

  it("a silent rung that holds for the window is an auto fix, and the next fault is a new episode", () => {
    const tracker = createAudioHealthTracker();
    tracker.detected("inboundStalled", 0);
    tracker.tick(30_000);
    expect(tracker.stage("inboundStalled")).toBe("idle");
    expect(tracker.detected("inboundStalled", 100_000)).toEqual({ action: "auto", step: 0 });
    expect(tracker.summary().inboundStalled).toMatchObject({ detected: 2, autoFixed: 1 });
  });

  it("asks at once for a fault no silent repair can reach", () => {
    const tracker = createAudioHealthTracker();
    expect(tracker.detected("micUnavailable", 0)).toEqual({ action: "ask" });
    // A state that holds is re-detected every tick and asks only once.
    expect(tracker.detected("micUnavailable", 2_000)).toEqual({ action: "none" });
    expect(tracker.summary().micUnavailable).toMatchObject({ detected: 1, asked: 1 });
  });

  it("cleared closes an episode at once, as auto or manual by who did it", () => {
    const tracker = createAudioHealthTracker();
    tracker.detected("playbackBlocked", 0);
    expect(tracker.cleared("playbackBlocked")).toBe(true);
    tracker.detected("playbackBlocked", 1_000);
    tracker.detected("playbackBlocked", 3_000);
    tracker.manualRepair("playbackBlocked", 4_000);
    tracker.cleared("playbackBlocked");
    expect(tracker.summary().playbackBlocked).toEqual({
      detected: 2,
      autoFixed: 1,
      asked: 1,
      manualFixed: 1,
      unresolved: 0,
    });
    expect(tracker.cleared("playbackBlocked")).toBe(false);
  });

  it("a fault straight back after a tap is unresolved and asks again", () => {
    const tracker = createAudioHealthTracker();
    tracker.detected("micUnavailable", 0);
    tracker.manualRepair("micUnavailable", 1_000);
    expect(tracker.detected("micUnavailable", 3_000)).toEqual({ action: "ask" });
    expect(tracker.summary().micUnavailable).toMatchObject({ asked: 2, unresolved: 1 });
  });

  it("closing the card keeps that problem quiet for the call, counted once", () => {
    const tracker = createAudioHealthTracker();
    tracker.detected("micUnavailable", 0);
    tracker.dismiss("micUnavailable");
    for (let at = 2_000; at < 20_000; at += 2_000) {
      expect(tracker.detected("micUnavailable", at)).toEqual({ action: "none" });
    }
    expect(tracker.asking()).toEqual([]);
    expect(tracker.summary().micUnavailable).toEqual({
      detected: 1,
      autoFixed: 0,
      asked: 1,
      manualFixed: 0,
      unresolved: 1,
    });
  });

  it("caps silent repairs per call, so a fault that keeps coming back asks", () => {
    const tracker = createAudioHealthTracker({
      policy: {
        micNotSending: { silentSteps: 2, verifyMs: 1_000, maxAutoRepairsPerCall: 3 },
      },
    });
    let at = 0;
    const decisions: string[] = [];
    for (let episode = 0; episode < 3; episode += 1) {
      decisions.push(tracker.detected("micNotSending", at).action);
      at += 5_000;
      tracker.tick(at);
    }
    // Episodes 1 and 2 used the budget (one rung each), episode 3 gets one
    // more, and the fourth asks without trying.
    decisions.push(tracker.detected("micNotSending", at).action);
    expect(decisions).toEqual(["auto", "auto", "auto", "ask"]);
  });

  it("the summary reads an open episode as unresolved without changing the tally", () => {
    const tracker = createAudioHealthTracker();
    tracker.detected("inboundStalled", 0);
    expect(tracker.summary().inboundStalled?.unresolved).toBe(1);
    tracker.tick(30_000);
    expect(tracker.summary().inboundStalled).toMatchObject({ autoFixed: 1, unresolved: 0 });
    expect(hasAudioHealth(createAudioHealthTracker().summary())).toBe(false);
  });
});

describe("prompts", () => {
  it("maps kinds onto three cards, and the output never asks", () => {
    expect(promptForKind("micNotSending")).toBe("mic");
    expect(promptForKind("inboundStalled")).toBe("hearing");
    expect(promptForKind("playbackBlocked")).toBe("hearing");
    expect(promptForKind("micUnavailable")).toBe("micUnavailable");
    expect(promptForKind("outputMissing")).toBeNull();
    expect(kindsForPrompt("hearing")).toEqual(["playbackBlocked", "inboundStalled"]);
  });
});
