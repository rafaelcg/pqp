/**
 * CONVIDADOS: the presenter's browser is the mixer (`docs/plans/
 * WATCH_PARTY_GUESTS.md` §5.2). The audience never joins the LiveKit room, so
 * the only way a guest's microphone reaches the HLS stream is through the one
 * browser that is already in the room hearing them: the presenter's.
 *
 * WHAT THIS BUILDS. A second bus, independent of `screen-mix.ts`'s film mix:
 * the presenter's own processed microphone plus every accepted guest's
 * subscribed microphone stream, summed through a limiter into one
 * `MediaStreamAudioDestinationNode`. That destination's track is published
 * under the name `stage-mix` (`STAGE_MIX_TRACK_NAME`) — a second `Microphone`
 * source, told apart the same way `mic-archive` and `voice-track` are
 * (pitfall 14: a grant is an allowlist of *sources*, so a second publication
 * has to go up as a microphone and be told apart by name).
 *
 * WHY A SEPARATE BUS, NOT A BRANCH ADDED TO `screen-mix.ts`'s. The film
 * rung's audio must stay exactly what it always was — the share's own sound
 * and nothing else (§5.3, "the film rung is untouched"). Wiring guest
 * microphones into `screen-mix.ts`'s compressor/destination would leak them
 * into the FILM's audio track, which the audience hears with no volume
 * control of its own. This bus feeds only the camera+voice rung.
 *
 * DYNAMIC MEMBERSHIP. Guests come and go while the party runs — `setGuestTrack`
 * mirrors `ScreenMix.setMic`'s reconnect pattern (disconnect the old source,
 * connect a new one) per guest id, so a guest's own tab reload or a host's
 * "Tirar do ar" removes exactly one branch without touching the others or the
 * presenter's own.
 *
 * The AudioContext is injectable so the graph is testable in Node; the pure
 * helpers below (`stageMixInputUserIds`, `shouldPublishStageMix`) are the
 * parts that do not need one at all.
 */

import type {
  AudioContextLike,
  AudioNodeLike,
  GainNodeLike,
} from "./screen-mix";
import type { WatchPartyGuestsMode } from "@pqp/shared";

/**
 * The LiveKit track NAME this bus publishes under. Every other client drops
 * and unsubscribes from it on sight (`livekit-session.ts`'s `TrackSubscribed`
 * handler), the same way `mic-archive` and `voice-track` already are, or a
 * guest would hear their own voice a round trip late.
 */
export const STAGE_MIX_TRACK_NAME = "stage-mix";

/** How often the output meter samples the bus, in ms. Same cadence as `screen-mix.ts`. */
const OUTPUT_LEVEL_POLL_MS = 50;

export interface StageMix {
  /** One audio track: the presenter's mic plus every guest's. Publish this. */
  stream: MediaStream;
  /** Swap or drop the presenter's own microphone branch. */
  setOwnMic(stream: MediaStream | null): void;
  /** Add, replace or (with `null`) drop one guest's microphone branch. */
  setGuestTrack(userId: string, stream: MediaStream | null): void;
  /** How many guest branches are currently feeding the bus. */
  guestCount(): number;
  /** The mixed bus's live level in dBFS, post-limiter. `null` before the first sample. */
  outputLevelDb(): number | null;
  close(): void;
}

export function createStageMix(
  ownMic: MediaStream | null,
  makeContext: () => AudioContextLike = () => new AudioContext(),
): StageMix {
  const context = makeContext();
  const destination = context.createMediaStreamDestination();

  // Every branch — the presenter's own mic and each guest's — feeds this one
  // limiter, the same reasoning `screen-mix.ts` uses for its own bus: N
  // microphones summed at unity can clip, and a guest's mic is not something
  // this module should be trusting to arrive at a sane level.
  const compressor = context.createDynamicsCompressor();
  compressor.threshold.value = -6;
  compressor.knee.value = 6;
  compressor.ratio.value = 12;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.25;

  let lastOutputDbfs: number | null = null;
  let outputInterval: ReturnType<typeof setInterval> | null = null;
  const outputAnalyser = context.createAnalyser?.();
  if (outputAnalyser) {
    compressor.connect(outputAnalyser);
    outputAnalyser.connect(destination);
  } else {
    compressor.connect(destination);
  }
  const startOutputMeter = () => {
    if (!outputAnalyser) {
      return;
    }
    const size = outputAnalyser.fftSize > 0 ? outputAnalyser.fftSize : 2048;
    const buffer = new Float32Array(size);
    outputInterval = setInterval(() => {
      outputAnalyser.getFloatTimeDomainData(buffer);
      let sumSquares = 0;
      for (let i = 0; i < buffer.length; i++) {
        sumSquares += buffer[i] * buffer[i];
      }
      const rms = Math.sqrt(sumSquares / buffer.length);
      lastOutputDbfs = rms > 0 ? 20 * Math.log10(rms) : Number.NEGATIVE_INFINITY;
    }, OUTPUT_LEVEL_POLL_MS);
  };

  const ownGain = context.createGain();
  ownGain.gain.value = 1;
  ownGain.connect(compressor);
  let ownSource: AudioNodeLike | null = null;
  const setOwnMic = (stream: MediaStream | null) => {
    ownSource?.disconnect();
    ownSource = null;
    if (stream && stream.getAudioTracks().length > 0) {
      ownSource = context.createMediaStreamSource(
        new MediaStream(stream.getAudioTracks()),
      );
      ownSource.connect(ownGain);
    }
  };
  setOwnMic(ownMic);

  const guestBranches = new Map<
    string,
    { source: AudioNodeLike; gain: GainNodeLike }
  >();
  const setGuestTrack = (userId: string, stream: MediaStream | null) => {
    const existing = guestBranches.get(userId);
    if (existing) {
      existing.source.disconnect();
      existing.gain.disconnect();
      guestBranches.delete(userId);
    }
    if (stream && stream.getAudioTracks().length > 0) {
      const gain = context.createGain();
      gain.gain.value = 1;
      gain.connect(compressor);
      const source = context.createMediaStreamSource(
        new MediaStream(stream.getAudioTracks()),
      );
      source.connect(gain);
      guestBranches.set(userId, { source, gain });
    }
  };

  startOutputMeter();

  return {
    stream: destination.stream,
    setOwnMic,
    setGuestTrack,
    guestCount: () => guestBranches.size,
    outputLevelDb: () => lastOutputDbfs,
    close: () => {
      if (outputInterval !== null) {
        clearInterval(outputInterval);
        outputInterval = null;
      }
      ownSource?.disconnect();
      ownGain.disconnect();
      for (const branch of guestBranches.values()) {
        branch.source.disconnect();
        branch.gain.disconnect();
      }
      guestBranches.clear();
      compressor.disconnect();
      outputAnalyser?.disconnect();
      void context.close();
    },
  };
}

// ------------------------------------------------------------ pure helpers

/**
 * Who belongs in the bus right now: the presenter themselves, plus every
 * accepted guest, in the same order the composite will eventually draw them
 * (presenter first, then guests by `invited_at` — the party frame's `onAir`
 * array already carries that order, so this never re-sorts it). Pure so it is
 * testable without an `AudioContext`: `use-voice.ts` calls this to decide
 * which peers' streams to feed `setGuestTrack`.
 */
export function stageMixInputUserIds(input: {
  guestsMode: WatchPartyGuestsMode;
  /** `party.guests.onAir`'s user ids, in server (`invited_at`) order. */
  onAirUserIds: readonly string[];
  ownUserId: string;
}): string[] {
  if (input.guestsMode === "off") {
    return [];
  }
  const rest = input.onAirUserIds.filter((id) => id !== input.ownUserId);
  return [input.ownUserId, ...rest];
}

/**
 * Whether THIS client should be publishing `stage-mix` at all. Only the
 * presenter (the person sharing, in the room, with a working mic) ever does —
 * a guest's own client never republishes what it already sent once, and a
 * viewer is never in the room to publish anything.
 *
 * `guestsMode !== "off"` alone is enough, deliberately NOT gated on there
 * being any guest currently on air: §5.3 requires the stage rung to exist
 * from the first second the party goes live with guests on, so that adding
 * the first guest is an input joining a bus already running rather than a
 * fresh rung starting mid-show.
 */
export function shouldPublishStageMix(input: {
  guestsMode: WatchPartyGuestsMode;
  isPresenting: boolean;
  hasMic: boolean;
}): boolean {
  return input.guestsMode !== "off" && input.isPresenting && input.hasMic;
}
