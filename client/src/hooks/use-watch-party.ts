import { createElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { WatchPartyState } from "@pqp/shared";
import type { createVoiceController } from "@/hooks/use-voice";
import {
  createWatchPartyPlayer,
  type PlayerFailure,
  type WatchPartyPlayer,
} from "@/lib/watch-party/player";
import {
  applyLocalAction,
  applyLocalTeardown,
  applyPlayerEvent,
  applyRemoteMessage,
  createSession,
  currentState,
  expectedPositionMs,
  nextResendAt,
  resendUnconfirmed,
  setRateControl,
  type ParsedYouTubeLink,
  type WatchPartyEffects,
  type WatchPartySession,
} from "@/lib/watch-party/state";

/**
 * The container. It holds the reducer, it holds the player, and it decides
 * nothing.
 *
 * `docs/WATCH_PARTY.md` splits this feature three ways: `state` is the pure
 * reducer, `player` is an imperative shell with no opinions, and the UI reads
 * state and dispatches intents. Nothing joined them up, so this file is the
 * join and its whole job is to be boring. Every decision below is delegated:
 *
 * - What a user action means, and what the room should be told: `applyLocalAction`.
 * - Whether an incoming frame wins: `applyRemoteMessage`.
 * - What a player event meant, and whether it is worth broadcasting: `applyPlayerEvent`.
 * - What the player should do about any of it: the commands those three return.
 *
 * IF A CONDITIONAL ABOUT `rev`, DRIFT, ECHOES OR POSITIONS APPEARS IN THIS
 * FILE, IT IS IN THE WRONG FILE. The reducer is testable precisely because it
 * has no clock, no socket and no DOM of its own, and every one of those three
 * is available here. Reach for `Date.now()` below only to hand it to the
 * reducer as an argument.
 *
 * THE SOCKET IS THE VOICE CONTROLLER'S, NOT A SECOND ONE. A watch party lives
 * inside a voice room, its one client frame goes out on the voice signaling
 * path, and the server routes it beside `set-voice-state`. See the
 * `set-watch-party` arm in `server/src/ws/voice.ts`.
 */

type VoiceController = ReturnType<typeof createVoiceController>;

/**
 * How often the resend clock is checked.
 *
 * Not the backoff. `state` owns the backoff (500ms doubling to 4s) and answers
 * `nextResendAt`; this only has to look often enough not to add meaningfully
 * to it. A quarter of a second is well inside the smallest interval it can
 * ask for.
 */
const RESEND_TICK_MS = 250;

/**
 * How long to wait for the rate probe's answer.
 *
 * The probe is the caller's job, says `setRateControl`, because it needs a
 * player and a timer and the reducer has neither. Ask for 1.05 once, and read
 * the answer off the player rather than off the request: YouTube quantises onto
 * an undocumented 0.05 grid, so 1.05 is a value it accepts, and SILENCE IS THE
 * SIGNAL. A refused rate fires no `onPlaybackRateChange` at all, and the player
 * updates its own rate only from that event, so a player still reading 1 here
 * is a player whose middle rung does nothing.
 *
 * Half a second is several round trips inside one process. The cost of being
 * wrong is small in one direction and not the other: reading a working player
 * as broken costs a wider deadband, while reading a broken one as working costs
 * a correction that silently never happens, which is the failure mode this
 * whole mechanism exists to avoid.
 */
const RATE_PROBE_MS = 500;

export interface WatchPartyController {
  /** The room's state, or null when there is no party. Feeds `WatchPartyStage`. */
  party: WatchPartyState | null;
  /** This person's player, if it refused. Local, never dispatched. */
  failure: PlayerFailure | null;
  /**
   * The player element, mounted by the stage only once this person has clicked
   * in. Nothing here decides that: React simply does not run the ref below
   * until the element is rendered, which is the entire autoplay gate.
   */
  player: ReactNode;
  onLoadVideo: (link: ParsedYouTubeLink) => void;
  onPlay: () => void;
  onPause: () => void;
  onSkip: (deltaMs: number) => void;
  onEndParty: () => void;
  onRetryPlayback: () => void;
}

export function useWatchParty(options: {
  voice: VoiceController;
  /** The voice channel this party belongs to, or null when not in one. */
  channelId: string | null;
  /** This machine's peer id, which is the `actorId` on every write it makes. */
  peerId: string | null;
}): WatchPartyController {
  const { voice, channelId, peerId } = options;

  const sessionRef = useRef<WatchPartySession>(createSession());
  const playerRef = useRef<WatchPartyPlayer | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const peerIdRef = useRef<string | null>(peerId);
  peerIdRef.current = peerId;

  const [party, setParty] = useState<WatchPartyState | null>(null);
  const [failure, setFailure] = useState<PlayerFailure | null>(null);
  /**
   * Bumped to rebuild the player after a failure a retry can change. A key
   * rather than a flag: remounting is the whole of the retry, and the ref
   * callback's teardown is what releases the iframe that failed.
   */
  const [playerGeneration, setPlayerGeneration] = useState(0);

  /**
   * The one place effects are drained, so there is one order and not four.
   *
   * Broadcast first, then command the player. The reverse would let a player
   * event fire from a command and reach the reducer before the write that
   * caused it had left, which is a reordering with no upside.
   */
  const applyEffects = useCallback(
    (effects: WatchPartyEffects | null) => {
      if (effects === null) {
        return;
      }
      sessionRef.current = effects.session;
      if (effects.broadcast) {
        voice.sendWatchParty(effects.broadcast);
      }
      if (effects.commands.length > 0) {
        playerRef.current?.executeAll(effects.commands);
      }
      setParty(currentState(effects.session));
    },
    [voice],
  );

  /**
   * Where this machine's playback actually is.
   *
   * `getPosition()` answers null rather than 0 when there is no player to ask,
   * and the difference matters more than it looks: position 0 on a fresh `rev`
   * outranks the whole room and drags everybody back to the start of the video.
   * Somebody who has not clicked in yet has no player and no position of their
   * own, so what they mean by "pause" is "pause where the room is".
   */
  const localPositionMs = useCallback((now: number): number => {
    const live = playerRef.current?.getPosition();
    if (live !== null && live !== undefined) {
      return live;
    }
    const adopted = sessionRef.current.adopted;
    return adopted ? expectedPositionMs(adopted, now) : 0;
  }, []);

  const act = useCallback(
    (intent: {
      videoId?: string | null;
      status: WatchPartyState["status"];
      positionMs?: number;
    }) => {
      const actor = peerIdRef.current;
      if (actor === null) {
        return;
      }
      const now = Date.now();
      applyEffects(
        applyLocalAction(
          sessionRef.current,
          {
            videoId: intent.videoId,
            status: intent.status,
            positionMs: intent.positionMs ?? localPositionMs(now),
          },
          actor,
          now,
        ),
      );
    },
    [applyEffects, localPositionMs],
  );

  /* ---------------------------------------------------------------------- */
  /* The room                                                                */
  /* ---------------------------------------------------------------------- */

  useEffect(() => {
    voice.onWatchParty((message) => {
      const now = Date.now();
      const result = applyRemoteMessage(
        sessionRef.current,
        message,
        now,
        channelId ?? undefined,
      );
      sessionRef.current = result.session;
      if (result.commands.length > 0) {
        playerRef.current?.executeAll(result.commands);
      }
      setParty(currentState(result.session));
    });
    return () => {
      voice.onWatchParty(null);
    };
  }, [voice, channelId]);

  /**
   * Leaving the channel forgets the party, because the party was the room's.
   *
   * The server tears a party down when the last participant leaves, and a peer
   * that walked out is not told about a room it is no longer in. Carrying the
   * old state into the next channel would show somebody a film that nobody in
   * that channel is watching.
   */
  useEffect(() => {
    sessionRef.current = createSession();
    setParty(null);
    setFailure(null);
    setPlayerGeneration((generation) => generation + 1);
  }, [channelId]);

  /* ---------------------------------------------------------------------- */
  /* The resend clock                                                        */
  /* ---------------------------------------------------------------------- */

  /**
   * An unechoed write is a write that has not happened.
   *
   * The wire contract makes the server's echo an acknowledgement rather than a
   * courtesy, precisely so a write the limiter coalesced can be retried. Without
   * this loop a coalesced PAUSE leaves this peer holding the highest `rev`,
   * ignoring every frame the room sends afterwards, split off permanently. The
   * loop stops on its own the moment the write is confirmed or outranked.
   */
  useEffect(() => {
    const timer = setInterval(() => {
      if (nextResendAt(sessionRef.current) === null) {
        return;
      }
      const now = Date.now();
      applyEffects(
        resendUnconfirmed(
          sessionRef.current,
          now,
          playerRef.current?.getPosition() ?? null,
        ),
      );
    }, RESEND_TICK_MS);
    return () => {
      clearInterval(timer);
    };
  }, [applyEffects]);

  /* ---------------------------------------------------------------------- */
  /* The player                                                              */
  /* ---------------------------------------------------------------------- */

  const attachHost = useCallback(
    (node: HTMLDivElement | null) => {
      hostRef.current = node;
      if (node === null) {
        // Unmounted, which is somebody leaving the party or the stage swapping
        // views. The iframe goes with it: one left behind is a video still
        // buffering in a channel nobody is looking at.
        playerRef.current?.destroy();
        playerRef.current = null;
        return;
      }
      if (playerRef.current !== null) {
        return;
      }

      let probeTimer: ReturnType<typeof setTimeout> | null = null;
      const player = createWatchPartyPlayer({
        host: node,
        videoId: currentState(sessionRef.current)?.videoId ?? null,
        onEvent: (playerEvent) => {
          if (playerEvent.kind === "failed") {
            setFailure(playerEvent.failure);
          }
          if (playerEvent.kind === "ready") {
            setFailure(null);
            // The probe. See `RATE_PROBE_MS`: ask once, then read the player's
            // own resolved rate rather than trusting the request, and put it
            // back either way.
            player.setPlaybackRate(1.05);
            probeTimer = setTimeout(() => {
              const supported = player.getStatus().playbackRate !== 1;
              sessionRef.current = setRateControl(sessionRef.current, supported);
              player.setPlaybackRate(1);
            }, RATE_PROBE_MS);
          }
          const actor = peerIdRef.current;
          applyEffects(
            applyPlayerEvent(
              sessionRef.current,
              playerEvent,
              // A peer with no id cannot author a write. The reducer needs a
              // non-empty actor to build one, and the wire schema refuses an
              // empty string, so a placeholder here would throw on encode
              // rather than fail quietly.
              actor ?? "unknown",
              Date.now(),
            ),
          );
        },
      });
      playerRef.current = player;

      // Belt to the ref callback's braces: React calls it with null on unmount,
      // but a probe still in flight would otherwise touch a destroyed player.
      const destroy = player.destroy.bind(player);
      player.destroy = () => {
        if (probeTimer !== null) {
          clearTimeout(probeTimer);
          probeTimer = null;
        }
        destroy();
      };
    },
    [applyEffects],
  );

  const player = useMemo(
    () =>
      createElement("div", {
        // The generation is the retry: a new key is a new element, so React
        // tears the old one down through the same ref callback that built it.
        key: playerGeneration,
        ref: attachHost,
        className: "h-full w-full",
      }),
    [attachHost, playerGeneration],
  );

  /* ---------------------------------------------------------------------- */
  /* What the panel dispatches                                               */
  /* ---------------------------------------------------------------------- */

  const onLoadVideo = useCallback(
    (link: ParsedYouTubeLink) => {
      // A pasted link is a decision to watch something, so the room starts
      // playing it. The person who pasted it clicked to do so, which is the
      // gesture their own autoplay policy wants; everybody else still has to
      // click in, and their player is not mounted until they do.
      act({
        videoId: link.videoId,
        status: "playing",
        positionMs: link.startMs,
      });
    },
    [act],
  );

  const onPlay = useCallback(() => {
    act({ status: "playing" });
  }, [act]);

  const onPause = useCallback(() => {
    act({ status: "paused" });
  }, [act]);

  const onSkip = useCallback(
    (deltaMs: number) => {
      const now = Date.now();
      act({
        // Whatever the room is doing, it keeps doing. Skipping is a move, not
        // a play or a pause, and turning it into one would be this file making
        // a decision.
        status: currentState(sessionRef.current)?.status ?? "playing",
        positionMs: Math.max(0, localPositionMs(now) + deltaMs),
      });
    },
    [act, localPositionMs],
  );

  const onEndParty = useCallback(() => {
    applyEffects(applyLocalTeardown(sessionRef.current, Date.now()));
  }, [applyEffects]);

  const onRetryPlayback = useCallback(() => {
    setFailure(null);
    setPlayerGeneration((generation) => generation + 1);
  }, []);

  useEffect(() => {
    return () => {
      playerRef.current?.destroy();
      playerRef.current = null;
    };
  }, []);

  return {
    party,
    failure,
    player,
    onLoadVideo,
    onPlay,
    onPause,
    onSkip,
    onEndParty,
    onRetryPlayback,
  };
}
