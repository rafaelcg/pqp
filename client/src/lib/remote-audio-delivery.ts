/**
 * Which remote audio the SFU should be sending this listener right now.
 *
 * WHY THIS EXISTS. `remote-video-delivery.ts` stops the pictures nobody is
 * looking at. This is its twin for the sounds nobody is listening to, and the
 * arithmetic says it is the half that grows fastest. A sample taken off the
 * production media box on 8 Sep 2026 held 3 rooms, 11 published microphones
 * and **58 audio subscriptions** against 3 published videos and 14 video
 * subscriptions: audio fans out as the square of the room while video fans
 * out as viewers times publishers, so in a room of twenty every microphone is
 * forwarded nineteen times and the box pays for all 380 copies.
 *
 * Most of those copies are worth paying for, because someone is listening.
 * These are the ones that are not:
 *
 * 1. **Deafened.** The listener pressed the button that means "I hear nobody".
 *    Every remote sound still arrives and every `<audio>` element plays it at
 *    `muted = true` (`voice-audio-sinks.tsx`). One deafened person in a room
 *    of twenty is nineteen forwarded streams decoded into silence.
 * 2. **A person turned all the way down.** The per-person volume slider at
 *    zero, which the row draws its "silenced" glyph for, is the listener
 *    saying the same thing about one person.
 * 3. **A moderator's mute.** `resolvePeerPlaybackVolume` already returns zero
 *    for a `serverMuted` peer, so every client plays them at zero while the
 *    packets keep arriving. Stopping the packets is strictly stronger than
 *    playing them at zero, and it is the same sanction.
 * 4. **A share whose sound is off.** Screen audio is published with
 *    `dtx: false, red: false` because a film is not a phone call, which means
 *    it costs its full bitrate every second whether or not anyone has it
 *    turned up. A viewer who muted the film pays for it continuously.
 *
 * NONE OF THESE COSTS QUALITY, which is the whole reason this file draws the
 * line where it does. In every one of them the listener already hears exactly
 * nothing; the only change is that the bytes stop leaving São Paulo. Anything
 * that would silence a sound somebody can currently hear belongs in a
 * different file and a different decision.
 *
 * `setEnabled` RATHER THAN `setSubscribed`, for the reason the video module
 * gives: unsubscribing tears the receiver down and re-subscribing
 * renegotiates. `setEnabled(false)` is one `UpdateTrackSettings` message and
 * the server stops forwarding; the receiver and the `MediaStreamTrack` stay
 * put, so the `<audio>` element keeps its `srcObject` and undeafening is
 * audible again within a round trip. Verified against livekit-client 2.21.0:
 * `RemoteTrackPublication.setEnabled` is not gated on kind, and
 * `emitTrackUpdate` sends `disabled: !isEnabled` for an audio publication the
 * same way it does for video. Its one guard is `isDesired`, so a publication
 * this client never subscribed to is a no-op rather than an error.
 *
 * FAIL OPEN, ALWAYS. Every rule below is a deny list of peer ids the listener
 * has explicitly silenced. A peer the plan has never heard of keeps flowing.
 * That is deliberate: the failure mode of a bug in an allow list is a room
 * where nobody can hear anybody, and no bandwidth saving is worth that.
 */

/** The subset of `RemoteTrackPublication` this module touches. */
export interface AudioDeliveryPublication {
  setEnabled(enabled: boolean): void;
}

/** Which of a person's two possible sounds a publication carries. */
export type RemoteAudioKind = "voice" | "screen";

/**
 * What this listener wants to hear, as a set of exceptions.
 *
 * Peer ids rather than user ids because that is what the SFU keys a
 * participant by and what the roster hands the hook; `voice-audio-sinks.tsx`
 * resolves the volume maps by `userId ?? peerId` and this plan is built from
 * the same resolution, so the two cannot disagree about who is silent.
 */
export interface RemoteAudioPlan {
  /** Nothing at all is wanted. Wins over both lists below. */
  deafened: boolean;
  /** Peers whose microphone plays at zero for this listener. */
  silentVoicePeerIds: readonly string[];
  /** Peers whose screen-share sound plays at zero, or is not played at all. */
  silentScreenPeerIds: readonly string[];
}

export const SILENT_AUDIO_PLAN: RemoteAudioPlan = {
  deafened: false,
  silentVoicePeerIds: [],
  silentScreenPeerIds: [],
};

/** The shape of a seated person, as much of it as the plan reads. */
export interface AudioPlanPeer {
  peerId: string;
  userId?: string | null;
}

export interface RemoteAudioPlanInput {
  peers: readonly AudioPlanPeer[];
  isDeafened: boolean;
  /** userId (or peerId) to voice volume, 0 to 1. Absent means 1. */
  peerVolumes: Readonly<Record<string, number>>;
  /** userId (or peerId) to screen-audio volume, 0 to 1. Absent means 1. */
  screenVolumes: Readonly<Record<string, number>>;
  /** Peers a moderator muted for everyone. Their voice plays at zero. */
  serverMutedPeerIds: readonly string[];
  /**
   * Peers whose share sound the hook is actually playing. A share missing
   * from this list is already silent for this listener today, because
   * `voice-audio-sinks.tsx` never mounts an element for it.
   */
  audibleScreenPeerIds: readonly string[];
}

/**
 * The listener's plan, derived from exactly the values that decide what the
 * `<audio>` elements do.
 *
 * THIS FUNCTION AND `VoiceAudioSinks` HAVE TO AGREE, and the test beside this
 * file says so out loud against the same inputs. A peer this says is silent
 * whose element is audible would be a person who has gone quiet for no
 * reason, which is the one bug this whole file must not have.
 *
 * The master output slider is deliberately not read. It is not in the voice
 * hook's state, it is a value people drag rather than a state they choose,
 * and deafen is the control that means "silence everything". Reading it would
 * buy the same saving with a cross-store dependency and a slider that
 * renegotiates the room on the way past zero.
 */
export function remoteAudioPlan(
  input: RemoteAudioPlanInput,
): RemoteAudioPlan {
  const silentVoicePeerIds: string[] = [];
  const silentScreenPeerIds: string[] = [];
  const serverMuted = new Set(input.serverMutedPeerIds);
  const audibleScreens = new Set(input.audibleScreenPeerIds);
  for (const peer of input.peers) {
    const key = peer.userId ?? peer.peerId;
    if (serverMuted.has(peer.peerId) || input.peerVolumes[key] === 0) {
      silentVoicePeerIds.push(peer.peerId);
    }
    // Not on the audible list is the state a share's sound spends its first
    // moments in, before the roster announces it. It is silent then too, so
    // it costs nothing to say so, and the list is a deny list, so a share
    // that arrives later simply is not on it.
    if (!audibleScreens.has(peer.peerId) || input.screenVolumes[key] === 0) {
      silentScreenPeerIds.push(peer.peerId);
    }
  }
  return {
    deafened: input.isDeafened,
    silentVoicePeerIds,
    silentScreenPeerIds,
  };
}

/**
 * Whether two plans say the same thing.
 *
 * `use-voice.ts` rebuilds the plan on every state emit, which is every
 * speaking-ring change in a busy room, and pushing an identical plan would
 * walk every registered publication for nothing. Order is significant and
 * that is fine: both lists are built by walking `remotePeers` in order, so
 * the same room in the same state produces the same arrays.
 */
export function sameAudioPlan(a: RemoteAudioPlan, b: RemoteAudioPlan): boolean {
  return (
    a.deafened === b.deafened &&
    sameIds(a.silentVoicePeerIds, b.silentVoicePeerIds) &&
    sameIds(a.silentScreenPeerIds, b.silentScreenPeerIds)
  );
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/** Whether a plan wants one peer's one sound. */
export function wantsRemoteAudio(
  plan: RemoteAudioPlan,
  peerId: string,
  kind: RemoteAudioKind,
): boolean {
  if (plan.deafened) {
    return false;
  }
  const silenced =
    kind === "voice" ? plan.silentVoicePeerIds : plan.silentScreenPeerIds;
  return !silenced.includes(peerId);
}

export interface RemoteAudioDeliveryOptions {
  /**
   * How long a sound stays on the wire after the listener silenced it.
   *
   * A volume slider is dragged, and a drag from 0.4 to 0.8 passes through
   * nothing, but a drag from 0.2 down and back up passes through zero twice.
   * Without this, that gesture would spend two signalling messages and put a
   * gap in the person's voice for no reason at all. Pausing waits; resuming
   * never does, because the listener turning somebody back up is the one
   * moment where a delay is audible.
   */
  graceMs?: number;
}

export interface RemoteAudioDelivery {
  /** An audio publication arrived. It starts delivered, then follows the plan. */
  register(
    publication: AudioDeliveryPublication,
    peerId: string,
    kind: RemoteAudioKind,
  ): void;
  /** The publication went away. Forgets it; sends nothing. */
  unregister(publication: AudioDeliveryPublication): void;
  /** The listener changed something. Applies to everything registered. */
  setPlan(plan: RemoteAudioPlan): void;
  /** Whether the plan currently has this publication paused. */
  isPaused(publication: AudioDeliveryPublication): boolean;
  /** Drop every timer. Nothing is resumed; the room is going away. */
  dispose(): void;
}

export const AUDIO_SILENCE_GRACE_MS = 750;

interface Entry {
  peerId: string;
  kind: RemoteAudioKind;
  paused: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

export function createRemoteAudioDelivery(
  options: RemoteAudioDeliveryOptions = {},
): RemoteAudioDelivery {
  const graceMs = options.graceMs ?? AUDIO_SILENCE_GRACE_MS;
  const entries = new Map<AudioDeliveryPublication, Entry>();
  let plan: RemoteAudioPlan = SILENT_AUDIO_PLAN;
  /**
   * The plan's two lists as sets, rebuilt once per plan.
   *
   * `wantsRemoteAudio` walks the array, which is the right shape for the
   * public function and the wrong one here: nobody sharing a screen puts
   * every peer in `silentScreenPeerIds`, so a room of two hundred would do
   * forty thousand string comparisons per plan, on every speaking-ring
   * change, on a phone.
   */
  let silentVoice = new Set<string>();
  let silentScreen = new Set<string>();

  function wanted(entry: Entry) {
    if (plan.deafened) {
      return false;
    }
    const silenced = entry.kind === "voice" ? silentVoice : silentScreen;
    return !silenced.has(entry.peerId);
  }

  function clearTimer(entry: Entry) {
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
  }

  function pause(publication: AudioDeliveryPublication, entry: Entry) {
    if (entry.paused) {
      return;
    }
    entry.paused = true;
    try {
      publication.setEnabled(false);
    } catch (err) {
      console.warn("[pqp] could not pause remote audio delivery", err);
    }
  }

  function resume(publication: AudioDeliveryPublication, entry: Entry) {
    if (!entry.paused) {
      return;
    }
    entry.paused = false;
    try {
      publication.setEnabled(true);
    } catch (err) {
      console.warn("[pqp] could not resume remote audio delivery", err);
    }
  }

  function reconcile(publication: AudioDeliveryPublication, entry: Entry) {
    if (wanted(entry)) {
      clearTimer(entry);
      resume(publication, entry);
      return;
    }
    if (entry.paused || entry.timer !== null) {
      return;
    }
    entry.timer = setTimeout(() => {
      entry.timer = null;
      if (!wanted(entry)) {
        pause(publication, entry);
      }
    }, graceMs);
  }

  return {
    register(publication, peerId, kind) {
      if (entries.has(publication)) {
        return;
      }
      const entry: Entry = { peerId, kind, paused: false, timer: null };
      entries.set(publication, entry);
      reconcile(publication, entry);
    },

    unregister(publication) {
      const entry = entries.get(publication);
      if (!entry) {
        return;
      }
      clearTimer(entry);
      entries.delete(publication);
    },

    setPlan(next) {
      plan = next;
      silentVoice = new Set(next.silentVoicePeerIds);
      silentScreen = new Set(next.silentScreenPeerIds);
      for (const [publication, entry] of entries) {
        reconcile(publication, entry);
      }
    },

    isPaused(publication) {
      return entries.get(publication)?.paused ?? false;
    },

    dispose() {
      for (const entry of entries.values()) {
        clearTimer(entry);
      }
      entries.clear();
    },
  };
}
