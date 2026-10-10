import type {
  AudioHealthKind,
  AudioHealthKindCounts,
  AudioHealthSummary,
} from "@pqp/shared";

/**
 * Notice when a call's audio has quietly broken, in either direction, and
 * decide what to do about it. Pure: no timers, no WebRTC, no DOM. The voice
 * controller (`use-voice.ts`) feeds it one tick per stats sample and does
 * whatever it is told.
 *
 * WHY THIS EXISTS. Half of the 1 and 2 star call ratings with a note in the
 * thirty days to 2026-10-10 were one of two sentences: "nao consigo ouvir
 * nada" and "o microfone não estava funcionando". Every one of those calls
 * looked fine from the inside: the published track `live`, the mute button
 * off, the peer connection `connected`. `mic-health.ts` (#1019) catches the
 * two failures a browser announces with an event (the capture ending, the
 * AudioContext suspending). This file catches the ones nobody announces, by
 * comparing two witnesses that should agree and do not:
 *
 * - OUTBOUND. The local meter reads the same node the published track is fed
 *   from (`gainNode` feeds both the analyser and the destination in
 *   `createMicPipeline`), so "the meter hears a voice" and "the sender is
 *   sending a voice" must agree. When the meter hears speech for several
 *   seconds while every sender reports a silent source (`media-source`
 *   `totalAudioEnergy` not moving), no packets, or a track that is not the
 *   microphone's, the room is not hearing this person.
 * - INBOUND. On the SFU the server's own detector (`participant.isSpeaking`)
 *   says somebody is talking; if nothing of theirs arrives here, our
 *   subscription is dead. On a mesh there is no server-side detector, so the
 *   witness is the roster: an unmuted peer on a connected path sends packets
 *   continuously (Opus keeps sending through silence, and a closed voice
 *   gate only flips `track.enabled`, which sends silence, not nothing), so a
 *   long run of zero packets is a dead path.
 *
 * WHAT IT DOES ABOUT IT is a ladder per fault (`createAudioHealthTracker`):
 * silent repairs first, each one given time to prove itself, then a card
 * with one button. Every rung is counted, so a call rating can say whether
 * the repair worked, which is the only way to know whether this file is
 * worth having.
 */

/** Ticks are one shared stats sample apart (two seconds). */
export const AUDIO_HEALTH_WINDOW_TICKS = 5;
/** Speaking ticks inside the window before the outbound witness is believed. */
export const OUTBOUND_MIN_SPEAKING_TICKS = 3;
/** SFU: ticks the server called a peer speaking, all with nothing arriving. */
export const INBOUND_MIN_SPEAKING_TICKS = 2;
/** Mesh: consecutive ticks of zero packets from an unmuted, connected peer. */
export const INBOUND_MESH_ZERO_TICKS = 5;
/**
 * `media-source.totalAudioEnergy` gained over one two-second window. The unit
 * is level squared times seconds: a voice at level 0.05 for one second adds
 * 0.0025, room noise behind a suppressor (level ~1e-4) adds ~2e-8 in two
 * seconds, and a source that is fed nothing adds exactly 0. Under this is
 * "nothing is being fed".
 *
 * ENERGY, NOT `audioLevel`. The level is one instant, and an instant lands in
 * the gap between two words a third of the time; three ticks in a row of that
 * would be a false alarm every few minutes of normal talking. The energy is
 * the whole window, the same window the local meter is judged over.
 */
export const SILENT_SOURCE_ENERGY = 1e-6;

export type MicNotSendingReason =
  | "track-ended"
  | "not-published"
  | "stale-track"
  | "silent-source"
  | "no-packets";

/** One mic sender's evidence for one tick. One per mesh peer, one on the SFU. */
export interface OutboundSenderEvidence {
  /**
   * Whether the sender is carrying the microphone's current track. False is
   * a sender left on a track a swap already replaced; null when unknown.
   */
  trackMatches: boolean | null;
  /**
   * `media-source.totalAudioEnergy` gained since the previous tick, null
   * where the browser does not report it (then only packets are judged).
   */
  energyDelta: number | null;
  /** Packets sent since the previous tick; null on the first sample. */
  packetsDelta: number | null;
}

export interface OutboundTick {
  /**
   * The microphone is supposed to be reaching the room right now: in a
   * connected call, transmitting, not deliberately held back (a publication
   * muted because the mic rides in a share's mix, a seat without SPEAK).
   */
  expectSending: boolean;
  /** The local meter heard a voice at least once since the previous tick. */
  localSpeaking: boolean;
  /** The published (processed) track has ended. */
  trackEnded: boolean;
  /**
   * SFU: the room is up and no microphone publication exists although one
   * is expected. Always false on a mesh, where "no sender" is a room of one.
   */
  missingPublication: boolean;
  senders: OutboundSenderEvidence[];
}

function senderDeadReason(sender: OutboundSenderEvidence): MicNotSendingReason | null {
  if (sender.trackMatches === false) {
    return "stale-track";
  }
  if (sender.energyDelta !== null && sender.energyDelta < SILENT_SOURCE_ENERGY) {
    return "silent-source";
  }
  if (sender.packetsDelta === 0) {
    return "no-packets";
  }
  return null;
}

interface OutboundHistoryEntry {
  speaking: boolean;
  dead: MicNotSendingReason | null;
}

/**
 * The outbound witness. `update` returns a reason the tick the evidence is
 * conclusive, then starts over, so a repair always gets a fresh window to
 * prove itself in before the same fault can be reported again.
 */
export function createOutboundDetector(options: {
  windowTicks?: number;
  minSpeakingTicks?: number;
} = {}) {
  const windowTicks = options.windowTicks ?? AUDIO_HEALTH_WINDOW_TICKS;
  const minSpeaking = options.minSpeakingTicks ?? OUTBOUND_MIN_SPEAKING_TICKS;
  let history: OutboundHistoryEntry[] = [];

  function update(tick: OutboundTick): MicNotSendingReason | null {
    if (tick.expectSending && tick.trackEnded) {
      history = [];
      return "track-ended";
    }
    const judged =
      tick.expectSending &&
      tick.localSpeaking &&
      (tick.missingPublication || tick.senders.length > 0);
    let dead: MicNotSendingReason | null = null;
    if (judged) {
      if (tick.missingPublication) {
        dead = "not-published";
      } else {
        const reasons = tick.senders.map(senderDeadReason);
        // Every copy has to be dead. On a mesh one healthy peer means the
        // microphone is fine and that one path is the other side's problem.
        if (reasons.every((reason) => reason !== null)) {
          dead = reasons[0]!;
        }
      }
    }
    history.push({ speaking: judged, dead });
    if (history.length > windowTicks) {
      history.shift();
    }
    const speaking = history.filter((entry) => entry.speaking);
    if (speaking.length >= minSpeaking && speaking.every((entry) => entry.dead !== null)) {
      const reason = speaking[speaking.length - 1]!.dead!;
      history = [];
      return reason;
    }
    return null;
  }

  return {
    update,
    reset() {
      history = [];
    },
  };
}

export interface InboundPeerTick {
  peerId: string;
  /**
   * We should be hearing this person: path connected, unmuted on the roster,
   * allowed to speak, and not silenced by this listener (deafen, a volume at
   * zero, a moderator's mute).
   */
  expectAudio: boolean;
  /** SFU: the server's speaking detector. Null on a mesh, which has none. */
  remoteSpeaking: boolean | null;
  /**
   * Packets of their VOICE received since the previous tick. Zero is
   * evidence of nothing arriving (the SFU sampler also reports zero for a
   * speaker we hold no subscription to, which is the fault itself). Null is
   * no evidence at all: no receiver row, a first read, a failed read.
   */
  packetsDelta: number | null;
}

interface InboundPeerState {
  speaking: { judged: boolean; dead: boolean }[];
  zeroRun: number;
}

/**
 * The inbound witness, per peer. `update` returns the peers whose audio is
 * conclusively not arriving this tick, and forgets their history so a repair
 * gets a fresh window.
 */
export function createInboundDetector(options: {
  windowTicks?: number;
  minSpeakingTicks?: number;
  meshZeroTicks?: number;
} = {}) {
  const windowTicks = options.windowTicks ?? AUDIO_HEALTH_WINDOW_TICKS;
  const minSpeaking = options.minSpeakingTicks ?? INBOUND_MIN_SPEAKING_TICKS;
  const meshZeroTicks = options.meshZeroTicks ?? INBOUND_MESH_ZERO_TICKS;
  const peers = new Map<string, InboundPeerState>();

  function update(ticks: readonly InboundPeerTick[]): string[] {
    const stalled: string[] = [];
    const seen = new Set<string>();
    for (const tick of ticks) {
      seen.add(tick.peerId);
      let peer = peers.get(tick.peerId);
      if (!peer) {
        peer = { speaking: [], zeroRun: 0 };
        peers.set(tick.peerId, peer);
      }
      if (tick.remoteSpeaking !== null) {
        const judged = tick.expectAudio && tick.remoteSpeaking;
        // Only a counter that did not move is evidence. Null (a first read,
        // a read that failed) judges nothing, so it is not counted at all.
        const evidence = judged && tick.packetsDelta !== null;
        peer.speaking.push({
          judged: evidence,
          dead: evidence && tick.packetsDelta === 0,
        });
        if (peer.speaking.length > windowTicks) {
          peer.speaking.shift();
        }
        const judgedTicks = peer.speaking.filter((entry) => entry.judged);
        if (judgedTicks.length >= minSpeaking && judgedTicks.every((entry) => entry.dead)) {
          stalled.push(tick.peerId);
          peers.delete(tick.peerId);
        }
        continue;
      }
      if (tick.expectAudio && tick.packetsDelta === 0) {
        peer.zeroRun += 1;
      } else {
        peer.zeroRun = 0;
      }
      if (peer.zeroRun >= meshZeroTicks) {
        stalled.push(tick.peerId);
        peers.delete(tick.peerId);
      }
    }
    for (const peerId of [...peers.keys()]) {
      if (!seen.has(peerId)) {
        peers.delete(peerId);
      }
    }
    return stalled;
  }

  return {
    update,
    reset() {
      peers.clear();
    },
  };
}

/**
 * Where one fault is on its ladder.
 *
 * - `idle`: nothing wrong, or the last episode is over.
 * - `verifying-auto`: a silent repair ran; if the fault is not seen again for
 *   `verifyMs` it worked.
 * - `asking`: the silent repairs ran out and the card is up.
 * - `verifying-manual`: the card's button ran; same proof as above.
 * - `dismissed`: the card was closed. Nothing more for this kind this call:
 *   no card, no silent repair, no new episode counted. A state that holds
 *   (no microphone at all) would otherwise be re-detected every tick and
 *   re-asked, or re-counted, for the rest of the call.
 */
export type AudioHealthStage =
  | "idle"
  | "verifying-auto"
  | "asking"
  | "verifying-manual"
  | "dismissed";

export type AudioHealthDecision =
  /** Run the silent repair at this rung (0 is the gentlest). */
  | { action: "auto"; step: number }
  /** Put the card up. */
  | { action: "ask" }
  /** Already handled: the card is up, or it was closed for this call. */
  | { action: "none" };

/** What a tracker event means, for telemetry. */
export type AudioHealthOutcome =
  | "detected"
  | "auto-repair"
  | "auto-fixed"
  | "asked"
  | "manual-repair"
  | "manual-fixed"
  | "manual-failed"
  | "unresolved";

export interface AudioHealthPolicy {
  /** How many silent rungs this fault has before it asks. */
  silentSteps: number;
  /** How long a repair must go without the fault coming back to count. */
  verifyMs: number;
  /**
   * Ceiling on silent repairs per call, across episodes, so a fault that
   * heals and comes back every minute cannot keep reopening a microphone
   * for the whole evening. Past it, every new episode asks straight away.
   */
  maxAutoRepairsPerCall: number;
}

export const DEFAULT_AUDIO_HEALTH_POLICY: Record<AudioHealthKind, AudioHealthPolicy> = {
  // Re-attach the track, then reopen the microphone.
  micNotSending: { silentSteps: 2, verifyMs: 30_000, maxAutoRepairsPerCall: 6 },
  // Nothing silent can fix a permission prompt: ask at once.
  micUnavailable: { silentSteps: 0, verifyMs: 15_000, maxAutoRepairsPerCall: 0 },
  // Retry play(), and arm a retry on the next press anywhere. Asks at once
  // too, because until somebody presses something there is no sound at all.
  playbackBlocked: { silentSteps: 1, verifyMs: 10_000, maxAutoRepairsPerCall: 6 },
  // Resubscribe or restart the path, twice, then ask.
  inboundStalled: { silentSteps: 2, verifyMs: 30_000, maxAutoRepairsPerCall: 6 },
  // Back to the default output. Nothing to ask: there is no other device.
  outputMissing: { silentSteps: 1, verifyMs: 10_000, maxAutoRepairsPerCall: 6 },
};

interface KindState {
  stage: AudioHealthStage;
  attempts: number;
  stageAt: number;
  autoRepairs: number;
  counts: AudioHealthKindCounts;
}

function emptyCounts(): AudioHealthKindCounts {
  return { detected: 0, autoFixed: 0, asked: 0, manualFixed: 0, unresolved: 0 };
}

/**
 * One call's ladder for every fault kind, and its tally.
 *
 * `onEvent` hears every rung (for Faro); `counts` is what the call rating
 * carries. The clock is passed in, never read, so a test drives it.
 */
export function createAudioHealthTracker(
  options: {
    policy?: Partial<Record<AudioHealthKind, AudioHealthPolicy>>;
    onEvent?: (kind: AudioHealthKind, outcome: AudioHealthOutcome) => void;
  } = {},
) {
  const policy = { ...DEFAULT_AUDIO_HEALTH_POLICY, ...(options.policy ?? {}) };
  const states = new Map<AudioHealthKind, KindState>();

  function stateOf(kind: AudioHealthKind): KindState {
    let state = states.get(kind);
    if (!state) {
      state = {
        stage: "idle",
        attempts: 0,
        stageAt: 0,
        autoRepairs: 0,
        counts: emptyCounts(),
      };
      states.set(kind, state);
    }
    return state;
  }

  function emit(kind: AudioHealthKind, outcome: AudioHealthOutcome) {
    options.onEvent?.(kind, outcome);
  }

  function ask(kind: AudioHealthKind, state: KindState, now: number): AudioHealthDecision {
    state.stage = "asking";
    state.stageAt = now;
    state.counts.asked += 1;
    emit(kind, "asked");
    return { action: "ask" };
  }

  function tryAuto(kind: AudioHealthKind, state: KindState, now: number): AudioHealthDecision {
    const rules = policy[kind];
    if (state.attempts < rules.silentSteps && state.autoRepairs < rules.maxAutoRepairsPerCall) {
      const step = state.attempts;
      state.attempts += 1;
      state.autoRepairs += 1;
      state.stage = "verifying-auto";
      state.stageAt = now;
      emit(kind, "auto-repair");
      return { action: "auto", step };
    }
    return ask(kind, state, now);
  }

  return {
    /** The fault was seen. Says what to do about it. */
    detected(kind: AudioHealthKind, now: number): AudioHealthDecision {
      const state = stateOf(kind);
      switch (state.stage) {
        case "idle":
          state.counts.detected += 1;
          state.attempts = 0;
          emit(kind, "detected");
          return tryAuto(kind, state, now);
        case "verifying-auto":
          // The last rung did not hold. Next one, or ask.
          return tryAuto(kind, state, now);
        case "asking":
        case "dismissed":
          return { action: "none" };
        case "verifying-manual":
          // Same episode, still broken: the card goes back up. Not counted
          // as unresolved here, so one episode is never two outcomes.
          emit(kind, "manual-failed");
          return ask(kind, state, now);
      }
    },

    /**
     * The fault is observably gone (a state-based fault: the element plays,
     * a microphone opened). Closes the episode at once instead of waiting
     * out the verify window.
     */
    cleared(kind: AudioHealthKind): boolean {
      const state = states.get(kind);
      if (!state || state.stage === "idle" || state.stage === "dismissed") {
        return false;
      }
      if (state.stage === "verifying-manual") {
        state.counts.manualFixed += 1;
        emit(kind, "manual-fixed");
      } else {
        // Fixed with nobody pressing the card: by a silent rung, or by a
        // press somewhere else that happened to be the gesture it needed.
        state.counts.autoFixed += 1;
        emit(kind, "auto-fixed");
      }
      state.stage = "idle";
      state.attempts = 0;
      return true;
    },

    /** The card's button was pressed. True when there was a card to press. */
    manualRepair(kind: AudioHealthKind, now: number): boolean {
      const state = states.get(kind);
      if (!state || state.stage !== "asking") {
        return false;
      }
      state.stage = "verifying-manual";
      state.stageAt = now;
      emit(kind, "manual-repair");
      return true;
    },

    /** The card was closed. It does not come back for this kind this call. */
    dismiss(kind: AudioHealthKind): void {
      const state = states.get(kind);
      if (!state || state.stage !== "asking") {
        return;
      }
      state.counts.unresolved += 1;
      state.stage = "dismissed";
      emit(kind, "unresolved");
    },

    /** Close the episodes whose verify window ran out with no relapse. */
    tick(now: number): void {
      for (const [kind, state] of states) {
        if (state.stage !== "verifying-auto" && state.stage !== "verifying-manual") {
          continue;
        }
        if (now - state.stageAt < policy[kind].verifyMs) {
          continue;
        }
        if (state.stage === "verifying-auto") {
          state.counts.autoFixed += 1;
          emit(kind, "auto-fixed");
        } else {
          state.counts.manualFixed += 1;
          emit(kind, "manual-fixed");
        }
        state.stage = "idle";
        state.attempts = 0;
      }
    },

    stage(kind: AudioHealthKind): AudioHealthStage {
      return states.get(kind)?.stage ?? "idle";
    },

    /** Kinds whose card is up, in the order they asked. */
    asking(): AudioHealthKind[] {
      return [...states.entries()]
        .filter(([, state]) => state.stage === "asking")
        .sort((a, b) => a[1].stageAt - b[1].stageAt)
        .map(([kind]) => kind);
    },

    /**
     * The call's tally, as a rating carries it. Pure read: an episode still
     * open (a card up, a repair being verified) reads as unresolved here, so
     * reading it when the call ends never needs a separate "finish" call that
     * one of the three ways out of a call would forget.
     */
    summary(): AudioHealthSummary {
      const out: AudioHealthSummary = {};
      for (const [kind, state] of states) {
        if (state.counts.detected === 0) {
          continue;
        }
        const counts = { ...state.counts };
        if (state.stage === "asking" || state.stage === "verifying-manual") {
          counts.unresolved += 1;
        } else if (state.stage === "verifying-auto") {
          // A silent repair the call ended before it could be proven. Most
          // of them work, but "probably" is not a count: unresolved.
          counts.unresolved += 1;
        }
        out[kind] = counts;
      }
      return out;
    },
  };
}

export type AudioHealthTracker = ReturnType<typeof createAudioHealthTracker>;

/** Which card a kind shows. `outputMissing` never asks. */
export type AudioHealthPrompt = "mic" | "micUnavailable" | "hearing";

export function promptForKind(kind: AudioHealthKind): AudioHealthPrompt | null {
  switch (kind) {
    case "micNotSending":
      return "mic";
    case "micUnavailable":
      return "micUnavailable";
    case "playbackBlocked":
    case "inboundStalled":
      return "hearing";
    case "outputMissing":
      return null;
  }
}

/** The kinds behind one card, for the button that repairs all of them. */
export function kindsForPrompt(prompt: AudioHealthPrompt): AudioHealthKind[] {
  switch (prompt) {
    case "mic":
      return ["micNotSending"];
    case "micUnavailable":
      return ["micUnavailable"];
    case "hearing":
      return ["playbackBlocked", "inboundStalled"];
  }
}

/** True when the summary has anything in it worth sending. */
export function hasAudioHealth(summary: AudioHealthSummary): boolean {
  return Object.keys(summary).length > 0;
}
