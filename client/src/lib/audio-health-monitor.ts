import type { AudioHealthKind, AudioHealthSummary } from "@pqp/shared";
import {
  createAudioHealthTracker,
  createInboundDetector,
  createOutboundDetector,
  kindsForPrompt,
  promptForKind,
  type AudioHealthOutcome,
  type AudioHealthPrompt,
  type AudioHealthTracker,
  type InboundPeerTick,
  type MicNotSendingReason,
  type OutboundSenderEvidence,
} from "./audio-health";
import type { AudioStatsSample } from "./voice-stats-probe";

/**
 * The audio self-repair for one voice controller: reads the shared stats
 * sample every tick, runs the two witnesses in `audio-health.ts`, climbs the
 * repair ladder, and raises or lowers the "Arrumar" card.
 *
 * Kept out of `use-voice.ts` on purpose. Everything it needs from the call is
 * a read (`view`) or an action (`actions`) handed in, so a test can drive a
 * whole episode, fault to card to tap to proof, with no WebRTC and no React,
 * and the controller only has to say what its own words mean.
 */

/** What the call looks like right now, as much of it as the repair reads. */
export interface AudioHealthView {
  connected: boolean;
  usingSfu: boolean;
  /**
   * The microphone is supposed to be reaching the room: transmitting, not
   * deliberately held back (muted publication, a share's mix, no SPEAK).
   */
  expectSending: boolean;
  /** The published (processed) microphone track, or null with no microphone. */
  micTrack: { id: string; readyState: string } | null;
  /**
   * In the call with no microphone because opening one failed (the
   * listen-only fallback), not because the person sat in the audience.
   */
  micUnavailable: boolean;
  /** This machine is presenting, so a mesh peer can carry two audio senders. */
  sharingScreen: boolean;
  /** SFU: the room is up, a microphone is expected and none is published. */
  sfuMissingPublication: boolean;
  /** The listener deafened, which silences every element on purpose. */
  deafened: boolean;
  peers: {
    peerId: string;
    /** Mesh: this path is `connected`. Ignored on the SFU. */
    connected: boolean;
    /** We should hear them: unmuted, allowed to speak, not silenced here. */
    expectAudio: boolean;
    /** Mesh: the id of the track their voice arrives on, when one has. */
    micTrackId: string | null;
  }[];
}

export interface AudioHealthActions {
  /** Put the current microphone track back on every sender. */
  reattachMic(): Promise<void>;
  /** Close and reopen the microphone (`swapPipeline`). */
  reopenMic(): Promise<void>;
  /** SFU: publish the microphone that is missing. */
  publishMic(): Promise<void>;
  /** Leave and rejoin with a microphone (the listen-only fallback's way out). */
  rejoinWithMic(): Promise<void>;
  /** SFU: resubscribe one voice. Mesh: restart one peer's path. */
  restartInbound(peerId: string): Promise<void>;
  /** Play every stuck element. True when none is stuck afterwards. */
  replayPlayback(): Promise<boolean>;
  /** Elements holding a stream and not playing it. */
  stuckPlayback(): number;
  /** Missing outputs found and already repaired since the last tick. */
  takeOutputMissing(): number;
}

export interface AudioHealthReport {
  kind: AudioHealthKind;
  outcome: AudioHealthOutcome;
  transport: "mesh" | "livekit";
  reason?: string;
}

/** How long one repair may take before the ladder stops waiting for it. */
export const REPAIR_TIMEOUT_MS = 10_000;

export function createAudioHealthMonitor(deps: {
  view(): AudioHealthView;
  actions: AudioHealthActions;
  now?: () => number;
  /** The card to show, or null. Called only on a change. */
  onPrompt(prompt: AudioHealthPrompt | null): void;
  /** Every rung of every ladder, for Faro. */
  report?(event: AudioHealthReport): void;
}) {
  const now = deps.now ?? (() => Date.now());
  const outbound = createOutboundDetector();
  const inbound = createInboundDetector();
  const reasons = new Map<AudioHealthKind, string>();
  let transport: "mesh" | "livekit" = "mesh";
  let tracker: AudioHealthTracker = newTracker();
  let prompt: AudioHealthPrompt | null = null;
  let localSpoke = false;
  /** Peers the open `inboundStalled` episode is about, for the card's tap. */
  let stalledPeers: string[] = [];
  /**
   * Bumped by `pause` and `reset`. A sample still awaiting a repair when the
   * call stops, or when a new call starts, notices on its next step that its
   * generation is gone and stops, rather than judging the next call with the
   * last one's evidence.
   */
  let generation = 0;
  /** The generation of the sample in flight, or null. */
  let running: number | null = null;

  function newTracker(): AudioHealthTracker {
    return createAudioHealthTracker({
      onEvent: (kind, outcome) => {
        deps.report?.({ kind, outcome, transport, reason: reasons.get(kind) });
      },
    });
  }

  function syncPrompt() {
    let next: AudioHealthPrompt | null = null;
    for (const kind of tracker.asking()) {
      const candidate = promptForKind(kind);
      if (candidate) {
        next = candidate;
        break;
      }
    }
    if (next !== prompt) {
      prompt = next;
      deps.onPrompt(next);
    }
  }

  /**
   * Run one repair, bounded. A repair that throws or hangs is a repair that
   * did not work: the next tick's evidence says so, and the ladder climbs. A
   * hang must never hold the monitor (`running`) for the rest of the call.
   */
  async function run(action: () => Promise<unknown>) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, REPAIR_TIMEOUT_MS);
      let started: Promise<unknown>;
      try {
        started = action();
      } catch {
        started = Promise.resolve();
      }
      started.then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        () => {
          clearTimeout(timer);
          resolve();
        },
      );
    });
  }

  function outboundEvidence(view: AudioHealthView, audio: AudioStatsSample): OutboundSenderEvidence[] {
    if (view.usingSfu) {
      // The SFU publishes a CLONE of the microphone track (see `publish` in
      // `livekit-session.ts`), so the ids never match by design: no stale
      // track judgement here, only energy and packets.
      return audio.senders.map((sender) => ({
        trackMatches: null,
        energyDelta: sender.energyDelta,
        packetsDelta: sender.packetsDelta,
      }));
    }
    const micId = view.micTrack?.id ?? null;
    const evidence: OutboundSenderEvidence[] = [];
    for (const peer of view.peers) {
      if (!peer.connected) {
        continue;
      }
      const rows = audio.senders.filter((sender) => sender.peerId === peer.peerId);
      const mic = rows.find((sender) => sender.trackId !== null && sender.trackId === micId);
      if (mic) {
        evidence.push({ trackMatches: true, energyDelta: mic.energyDelta, packetsDelta: mic.packetsDelta });
      } else if (rows.length === 1 && !view.sharingScreen) {
        // One audio sender to this peer and it is not carrying the
        // microphone: a track a swap already replaced. With a share up the
        // other sender is the share's audio, so nothing can be said.
        const only = rows[0]!;
        evidence.push({
          trackMatches: only.trackId === null ? null : false,
          energyDelta: only.energyDelta,
          packetsDelta: only.packetsDelta,
        });
      }
    }
    return evidence;
  }

  function inboundTicks(view: AudioHealthView, audio: AudioStatsSample): InboundPeerTick[] {
    return view.peers.map((peer) => {
      const rows = audio.receivers.filter((row) => row.peerId === peer.peerId);
      if (view.usingSfu) {
        const row = rows[0];
        return {
          peerId: peer.peerId,
          expectAudio: peer.expectAudio,
          // No microphone publication at all: they cannot be speaking.
          remoteSpeaking: row?.remoteSpeaking ?? false,
          packetsDelta: row?.packetsDelta ?? null,
        };
      }
      const row = peer.micTrackId
        ? rows.find((candidate) => candidate.trackId === peer.micTrackId)
        : undefined;
      return {
        peerId: peer.peerId,
        expectAudio: peer.expectAudio && peer.connected,
        remoteSpeaking: null,
        packetsDelta: row ? row.packetsDelta : null,
      };
    });
  }

  function noteReason(kind: AudioHealthKind, reason: string) {
    reasons.set(kind, reason);
  }

  async function micNotSending(reason: MicNotSendingReason) {
    noteReason("micNotSending", reason);
    const decision = tracker.detected("micNotSending", now());
    if (decision.action !== "auto") {
      return;
    }
    if (reason === "not-published") {
      await run(() => deps.actions.publishMic());
    } else if (decision.step === 0 && reason !== "track-ended") {
      await run(() => deps.actions.reattachMic());
    } else {
      await run(() => deps.actions.reopenMic());
    }
  }

  async function sample(audio: AudioStatsSample | undefined): Promise<void> {
    const view = deps.view();
    transport = view.usingSfu ? "livekit" : "mesh";
    if (!view.connected || running === generation) {
      localSpoke = false;
      return;
    }
    const mine = generation;
    running = mine;
    const stale = () => mine !== generation;
    try {
      const at = now();
      tracker.tick(at);
      const rows = audio ?? { senders: [], receivers: [] };

      // No microphone at all, after trying.
      if (view.micUnavailable) {
        noteReason("micUnavailable", "listen-only");
        tracker.detected("micUnavailable", at);
      } else {
        tracker.cleared("micUnavailable");
      }

      // Our voice.
      if (view.micTrack) {
        const reason = outbound.update({
          expectSending: view.expectSending,
          localSpeaking: localSpoke,
          trackEnded: view.micTrack.readyState === "ended",
          missingPublication: view.usingSfu && view.sfuMissingPublication,
          senders: outboundEvidence(view, rows),
        });
        if (reason) {
          await micNotSending(reason);
          if (stale()) {
            return;
          }
        }
      } else {
        outbound.reset();
      }
      localSpoke = false;

      // The elements that play the call.
      const stuck = view.deafened ? 0 : deps.actions.stuckPlayback();
      if (stuck > 0) {
        noteReason("playbackBlocked", "paused");
        const decision = tracker.detected("playbackBlocked", at);
        if (decision.action === "auto") {
          const played = await deps.actions.replayPlayback().catch(() => false);
          if (stale()) {
            return;
          }
          if (played) {
            tracker.cleared("playbackBlocked");
          }
        }
      } else {
        tracker.cleared("playbackBlocked");
      }

      // Their voices.
      const stalled = inbound.update(inboundTicks(view, rows));
      if (stalled.length > 0) {
        stalledPeers = stalled;
        noteReason("inboundStalled", view.usingSfu ? "speaking-no-packets" : "no-packets");
        const decision = tracker.detected("inboundStalled", at);
        if (decision.action === "auto") {
          for (const peerId of stalled) {
            await run(() => deps.actions.restartInbound(peerId));
            if (stale()) {
              return;
            }
          }
        }
      }
      if (tracker.stage("inboundStalled") === "idle") {
        // Episode over (proven fixed): a later playback-only card must not
        // restart peers that are working.
        stalledPeers = [];
      }

      // The output device, repaired where it was found.
      for (let i = deps.actions.takeOutputMissing(); i > 0; i -= 1) {
        noteReason("outputMissing", "device-gone");
        tracker.detected("outputMissing", at);
        tracker.cleared("outputMissing");
      }

      syncPrompt();
    } finally {
      if (running === mine) {
        running = null;
      }
    }
  }

  return {
    /** One shared stats tick. */
    sample,

    /**
     * One reading of the local meter while transmitting. Called often (a few
     * times a second); the next `sample` judges whether the room heard it.
     */
    noteLocalSpeaking() {
      localSpoke = true;
    },

    /** The card's button. */
    async repair(): Promise<void> {
      const current = prompt;
      if (!current) {
        return;
      }
      const at = now();
      for (const kind of kindsForPrompt(current)) {
        tracker.manualRepair(kind, at);
      }
      syncPrompt();
      if (current === "hearing") {
        const peers = tracker.stage("inboundStalled") === "verifying-manual" ? stalledPeers : [];
        stalledPeers = [];
        const played = await deps.actions.replayPlayback().catch(() => false);
        if (played) {
          tracker.cleared("playbackBlocked");
        }
        for (const peerId of peers) {
          await run(() => deps.actions.restartInbound(peerId));
        }
        inbound.reset();
      } else if (current === "mic") {
        const view = deps.view();
        if (view.usingSfu && view.sfuMissingPublication) {
          await run(() => deps.actions.publishMic());
        } else {
          await run(() => deps.actions.reopenMic());
        }
        outbound.reset();
      } else {
        await run(() => deps.actions.rejoinWithMic());
      }
    },

    /** The card's close. That kind stays quiet for the rest of the call. */
    dismiss() {
      const current = prompt;
      if (!current) {
        return;
      }
      for (const kind of kindsForPrompt(current)) {
        tracker.dismiss(kind);
      }
      syncPrompt();
    },

    /** A new call: new tally, new history, no card. */
    reset() {
      generation += 1;
      tracker = newTracker();
      outbound.reset();
      inbound.reset();
      reasons.clear();
      stalledPeers = [];
      localSpoke = false;
      if (prompt !== null) {
        prompt = null;
        deps.onPrompt(null);
      }
    },

    /**
     * The call stopped (left, or paused for a reconnect): drop any sample
     * still in flight and take the card down. The tally stays.
     */
    pause() {
      generation += 1;
      if (prompt !== null) {
        prompt = null;
        deps.onPrompt(null);
      }
    },

    /** Take the card down without touching the tally (the flag went off). */
    hidePrompt() {
      if (prompt !== null) {
        prompt = null;
        deps.onPrompt(null);
      }
    },

    summary(): AudioHealthSummary {
      return tracker.summary();
    },

    prompt(): AudioHealthPrompt | null {
      return prompt;
    },
  };
}

export type AudioHealthMonitor = ReturnType<typeof createAudioHealthMonitor>;

/**
 * The summary of the call that is running or just ended, for the call rating
 * (`use-call-rating.ts`), which has no handle on the controller. The
 * controller registers its monitor; a rating reads it once, at the end.
 */
let summaryReader: (() => AudioHealthSummary) | null = null;

export function registerAudioHealthSummary(reader: (() => AudioHealthSummary) | null): void {
  summaryReader = reader;
}

export function currentAudioHealthSummary(): AudioHealthSummary {
  return summaryReader?.() ?? {};
}
