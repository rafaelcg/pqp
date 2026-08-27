import { z } from "zod";

/**
 * Watching a YouTube video together, as a synchronised state object.
 *
 * NO VIDEO OR AUDIO PASSES THROUGH OUR INFRASTRUCTURE. Every participant
 * streams from YouTube directly through the IFrame Player API. What we carry
 * is this object, which is small, and nothing else. If you find yourself
 * adding a media track for a watch party, stop: that is a different feature
 * with a different cost model.
 *
 * WHY THIS TRAVELS OVER THE WEBSOCKET AND NOT A DATA CHANNEL.
 *
 * The obvious design is an `RTCDataChannel` between peers. This repo has no
 * data channel at all, on either transport, and adding one would mean
 * negotiating N-1 channels per peer in a mesh, handling their reconnection
 * separately from the media path, and then writing the whole thing a second
 * time for LiveKit.
 *
 * The signalling socket is already there, already ordered, already
 * reconnecting, already authenticated, and already carries per-room state of
 * exactly this shape in `set-voice-state`. It is also transport agnostic:
 * presence and signalling run over `/ws` for mesh and LiveKit alike, so this
 * works on both without a second implementation.
 *
 * The cost is that watch-party state inherits the limitation documented at
 * `server/src/ws/voice.ts`: voice is deliberately not on the cluster bus, so
 * a room lives on one instance. That is the same ceiling mesh voice already
 * has, not a new one.
 */

/**
 * Last-writer-wins, and deliberately no host.
 *
 * `rev` is a logical clock, not a timestamp. Any local user action sets it to
 * `maxSeenRev + 1`, so a peer that has heard more of the conversation always
 * outranks one that has heard less. Ties break on `actorId` lexically, which
 * is arbitrary but total, and total is the only property that matters: every
 * peer must pick the same winner without talking to anyone.
 *
 * There is no leader election and no "host" role. Whoever acted most recently
 * controls the player. That is a product decision as much as a technical one:
 * a group watching something together does not want to ask permission to
 * pause it.
 */
export const watchPartyStateSchema = z.object({
  /** The YouTube video id, or null when the party exists but nothing is loaded. */
  videoId: z.string().min(1).max(64).nullable(),
  status: z.enum(["playing", "paused", "ended"]),
  /** Playback position sampled at `atMs`. */
  positionMs: z.number().int().nonnegative(),
  /**
   * The sender's clock when `positionMs` was sampled. DIAGNOSTIC ONLY.
   *
   * NEVER SUBTRACT THIS FROM A RECEIVER'S CLOCK. An earlier version of this
   * comment argued that the error was around 100ms because mesh latency
   * between two Brazilian peers is low. That conflated two different
   * quantities. Latency is small and bounded; CLOCK OFFSET IS NEITHER. Two
   * consumer machines routinely disagree by tens of seconds: a laptop resuming
   * from sleep, a phone with the time set by hand, a VM with a drifting RTC.
   *
   * What that bought, precisely, and it is worth knowing because it is
   * invisible from the sending side. `positionMs + (now - atMs)` against a
   * sender whose clock is 30 seconds slow puts the expected position 30
   * seconds into the future, so every receiver seeks forward and then sits
   * there, stably and permanently out of step by exactly that offset, while
   * the sender sees a party working perfectly. The worst clock in the room
   * wins, and nothing in the room can tell.
   *
   * SO THE RECEIVER STAMPS ITS OWN ARRIVAL TIME AND MEASURES ELAPSED FROM
   * THAT. Everything in the drift arithmetic then lives in one clock, and the
   * only error left is one-way network latency, which really is the ~100ms the
   * old comment claimed. Flooring a negative elapsed at zero does not rescue
   * the raw form: it covers a sender whose clock runs ahead and leaves the
   * opposite, equally common and far more damaging, wide open.
   *
   * ONE CONSEQUENCE FOR RESENDS, which is easy to miss because it only shows
   * up under packet loss. An unconfirmed write is retried with backoff, so a
   * resend can carry a sample taken seconds ago. A receiver stamping arrival
   * time treats every frame as current, so replaying the old sample makes the
   * whole room run late by the length of the backoff. A RESEND OF A `playing`
   * STATE MUST RE-SAMPLE THE POSITION AND RESTAMP, not repeat the frame it
   * sent last time. A paused or ended state may be replayed verbatim, because
   * its position does not advance.
   */
  atMs: z.number().int().nonnegative(),
  /** Logical clock. Higher wins. */
  rev: z.number().int().nonnegative(),
  /** `peerId` of the last writer. Breaks `rev` ties lexically. */
  actorId: z.string().min(1).max(128),
});

export type WatchPartyState = z.infer<typeof watchPartyStateSchema>;

/**
 * Client to server. Rate limited server side, because a seek scrub can emit
 * continuously and would otherwise spend the whole room's bandwidth.
 *
 * THE `set-voice-state` PRECEDENT DOES NOT TRANSFER, AND THIS IS THE ONE
 * PLACE THE ANALOGY BREAKS. That limiter simply drops the frame past its
 * budget, and the comment there explains why that is safe: mute is display
 * state, never enforcement, so a dropped frame leaves a stale badge until the
 * next honest toggle. Watch-party state is not display state. A dropped PAUSE
 * leaves the actor paused at `rev` N while everyone else plays on at N-1, and
 * because the actor's `rev` is now the higher one they will ignore every
 * frame the room sends afterwards. That is not a stale badge, it is a room
 * split in half permanently, by design, with no path back.
 *
 * Two things together fix it, and they are cheap because the server has to
 * hold the room's current state anyway (a peer joining mid-video has to land
 * at the right position, and the last participant leaving has to tear the
 * party down; neither is possible for a dumb relay).
 *
 * 1. THE SERVER COALESCES RATHER THAN DROPS. Compare an incoming state to the
 *    held one. A change to `videoId` or `status` is never dropped, whatever
 *    the limiter says. Position-only updates, which is exactly what a scrub
 *    emits continuously, are the ones worth coalescing, and they are also the
 *    only reason the limiter was needed in the first place.
 * 2. THE CLIENT RESENDS WHAT IT HAS NOT SEEN ECHOED. Local state is not
 *    confirmed until it comes back, so an unechoed state is retried with
 *    backoff. This is the same mechanism that recovers a reconnect and a
 *    mid-video join, so it is one piece of machinery and not three.
 */
export const setWatchPartyMessageSchema = z.object({
  type: z.literal("set-watch-party"),
  state: watchPartyStateSchema.nullable(),
});

export type SetWatchPartyMessage = z.infer<typeof setWatchPartyMessageSchema>;

/**
 * Server to everyone in the room, including the sender.
 *
 * Echoing to the sender is deliberate: it is how a client learns its write
 * was accepted rather than dropped by the rate limiter, and it keeps every
 * peer's view of `rev` derived from the same source. Treat the echo as an
 * acknowledgement, not as a courtesy: it is what the resend logic described
 * above waits for, and a local state that has never been echoed has not
 * happened as far as the room is concerned.
 *
 * `state: null` means the party was torn down, which is what the last
 * participant leaving produces.
 *
 * WHO MAY WRITE. A participant whose player has failed (embedding disabled,
 * age restricted, error 153, or any other) is a reader of this state and
 * never a writer, and the client is responsible for enforcing that on itself.
 * A failed player reports position 0 forever, and position 0 carried on a
 * fresh `rev` outranks everyone and drags the whole room back to the start of
 * the video. One person's broken embed must not do that, which is the
 * difference between the failure paths being handled and merely being
 * displayed.
 */
export const watchPartyMessageSchema = z.object({
  type: z.literal("watch-party"),
  channelId: z.string().uuid(),
  state: watchPartyStateSchema.nullable(),
});

export type WatchPartyMessage = z.infer<typeof watchPartyMessageSchema>;
