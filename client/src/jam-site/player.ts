import type { PublicJamTrack } from "@pqp/shared";

/**
 * Playing a public song.
 *
 * ONE ENGINE, NOT A SECOND. This is a thin store over the same engine the
 * app's Jam plays through (`lib/jam-session.ts`: `getJamEngine`,
 * `syncJamStems`, `unlockJamAudio`), so the placement rule is the one the app
 * ships: every stem is laid on the song's ONE timeline by `offsetMs` and
 * `trimStartMs` / `trimEndMs`, and a video's file time is the song's time
 * minus its take's `offsetMs` (`JamPlayer.attachVideo`). Nothing here
 * re-implements placement or sync; this file only decides WHEN things are
 * loaded and keeps the numbers the page draws.
 *
 * NOTHING IS FETCHED BEFORE A PLAY. The engine module itself is warmed when a
 * song page opens (`warmJamEngine`: JavaScript only, so the first press can
 * unlock the audio inside the gesture), but the audio of the stems is
 * downloaded and decoded on the first press, never on the page view, and the
 * home never imports this at all.
 *
 * The page reads two things: `state` (rarely changes; React re-renders on it)
 * and `position()` (every animation frame; read by the pieces that draw a
 * moving thing, never through React state).
 */

type SessionModule = typeof import("@/lib/jam-session");

let sessionPromise: Promise<SessionModule> | null = null;
let sessionModule: SessionModule | null = null;

/** Start loading the engine's code. No audio is touched. */
export function warmJamEngine(): Promise<SessionModule> {
  if (!sessionPromise) {
    sessionPromise = import("@/lib/jam-session").then((module) => {
      sessionModule = module;
      return module;
    });
    sessionPromise.catch(() => {
      sessionPromise = null;
    });
  }
  return sessionPromise;
}

/**
 * Unlock the audio from inside a click that is about to take somebody to a song
 * and start it (a play button on the home). The engine is one object for the
 * whole page, so the song page picks up the context this made.
 */
export function unlockAudioInGesture(): boolean {
  if (sessionModule) {
    sessionModule.unlockJamAudio();
    return true;
  }
  // The engine's code is not here yet: nothing could be unlocked in this click,
  // so the caller must not promise a start it cannot make. The song opens paused.
  void warmJamEngine();
  return false;
}

export type PlayerPhase ="idle" | "loading" | "ready" | "error";

export interface PlayerState {
  phase: PlayerPhase;
  playing: boolean;
  /** The song's length: the payload's until the stems are decoded, then the engine's. */
  durationMs: number;
  /** The track heard alone (spotlight), or null for the whole band. */
  solo: string | null;
  /** The stems of the tracks are decoded and the videos can follow the clock. */
  stemsReady: boolean;
}

type Engine = Awaited<ReturnType<SessionModule["getJamEngine"]>>;

export interface PublicPlayer {
  getState(): PlayerState;
  subscribe(listener: () => void): () => void;
  /** Song time being heard, ms. Cheap; read it in an animation frame. */
  position(): number;
  /**
   * Call `listener` once per animation frame while the song plays (a few times a
   * second under reduced motion). ONE loop serves every listener, so nine tiles
   * and the lanes cost one `requestAnimationFrame`, not ten.
   */
  onFrame(listener: () => void): () => void;
  /**
   * Play or pause. Call it from the click or key press itself: the engine's
   * audio is unlocked in that very task.
   */
  toggle(): void;
  seek(ms: number): void;
  /** Hear one track alone, or the band again. */
  setSolo(trackId: string | null): void;
  /** Keep a muted video on a track's clock. Only works once the stems are ready. */
  attachVideo(trackId: string, element: HTMLVideoElement): () => void;
  /** Let go: pause and drop the stems. */
  dispose(): void;
}

export interface PlayerOptions {
  tracks: readonly PublicJamTrack[];
  durationMs: number;
  /** Called once, on the first successful play. */
  onFirstPlay?: () => void;
  /** The URLs may have aged out: give fresh tracks, or null to keep these. */
  refreshTracks?: () => Promise<readonly PublicJamTrack[] | null>;
}

export function createPublicPlayer(options: PlayerOptions): PublicPlayer {
  let tracks = options.tracks;
  let state: PlayerState = {
    phase: "idle",
    playing: false,
    durationMs: options.durationMs,
    solo: null,
    stemsReady: false,
  };
  const listeners = new Set<() => void>();
  let engine: Engine | null = null;
  let unsubscribeClock: (() => void) | null = null;
  let firstPlayed = false;
  let disposed = false;
  let starting = false;
  let parked = 0;

  const frameListeners = new Set<() => void>();
  let frameRaf = 0;
  let frameTimer: ReturnType<typeof setInterval> | null = null;
  const runFrames = () => {
    for (const listener of frameListeners) listener();
  };
  const stopFrames = () => {
    if (frameRaf) cancelAnimationFrame(frameRaf);
    frameRaf = 0;
    if (frameTimer) clearInterval(frameTimer);
    frameTimer = null;
  };
  /** Keep the loop running exactly while something listens and the song plays. */
  const syncFrames = () => {
    const wanted = state.playing && frameListeners.size > 0 && !disposed;
    if (!wanted) {
      stopFrames();
      return;
    }
    if (frameRaf || frameTimer) return;
    let reduced = false;
    try {
      reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      reduced = false;
    }
    if (reduced) {
      frameTimer = setInterval(runFrames, 250);
      return;
    }
    const loop = () => {
      runFrames();
      frameRaf = requestAnimationFrame(loop);
    };
    frameRaf = requestAnimationFrame(loop);
  };

  const emit = () => {
    for (const listener of listeners) listener();
    syncFrames();
  };
  const set = (patch: Partial<PlayerState>) => {
    state = { ...state, ...patch };
    emit();
  };

  function follow(next: Engine) {
    unsubscribeClock?.();
    unsubscribeClock = next.player.subscribe((tick) => {
      const playing = tick.state === "playing";
      if (playing !== state.playing || (tick.durationMs > 0 && tick.durationMs !== state.durationMs)) {
        set({ playing, durationMs: tick.durationMs > 0 ? tick.durationMs : state.durationMs });
      }
    });
  }

  function stemTracks() {
    return tracks.map((track) => ({
      id: track.id,
      inMix: true,
      audioUrl: track.audioUrl,
      offsetMs: track.offsetMs,
      trimStartMs: track.trimStartMs,
      trimEndMs: track.trimEndMs,
      gain: track.gain,
    }));
  }

  async function load(session: SessionModule): Promise<Engine | null> {
    const next = await session.getJamEngine();
    if (disposed) return null;
    engine = next;
    set({ phase: "loading" });
    let wanted = stemTracks();
    await session.syncJamStems(next, wanted);
    if (disposed) return null;
    let missing = wanted.filter((track) => !next.player.stem(track.id));
    if (missing.length > 0 && options.refreshTracks) {
      // A URL that has aged out answers 403: ask for fresh ones once.
      const fresh = await options.refreshTracks().catch(() => null);
      if (fresh && !disposed) {
        tracks = fresh;
        wanted = stemTracks();
        await session.syncJamStems(next, wanted);
        missing = wanted.filter((track) => !next.player.stem(track.id));
      }
    }
    if (disposed) return null;
    if (missing.length > 0) {
      set({ phase: "error" });
      return null;
    }
    follow(next);
    // A part chosen before the stems were here is heard alone from the first note.
    if (state.solo) {
      for (const track of tracks) {
        next.player.updateStem(track.id, { solo: track.id === state.solo });
      }
    }
    set({ phase: "ready", stemsReady: true, durationMs: next.player.durationMs || state.durationMs });
    return next;
  }

  async function run() {
    if (starting) return;
    starting = true;
    try {
      const session = await warmJamEngine();
      if (disposed) return;
      let active = engine;
      if (!active || !state.stemsReady) {
        active = await load(session);
        if (!active) return;
      }
      if (active.player.state === "playing") {
        active.player.pause();
        return;
      }
      await active.context.resume();
      // A seek made before the stems were loaded is where the first play starts.
      const from = parked > 0 && active.player.state === "stopped" ? parked : undefined;
      parked = 0;
      await active.player.play(from);
      if (!firstPlayed) {
        firstPlayed = true;
        options.onFirstPlay?.();
      }
    } catch {
      if (!disposed) set({ phase: "error" });
    } finally {
      starting = false;
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    position() {
      return engine && state.stemsReady ? engine.player.positionMs() : parked;
    },
    onFrame(listener) {
      frameListeners.add(listener);
      syncFrames();
      return () => {
        frameListeners.delete(listener);
        syncFrames();
      };
    },
    toggle() {
      // In the task of the gesture, before anything is awaited.
      sessionModule?.unlockJamAudio();
      if (state.phase === "error") {
        set({ phase: "idle", stemsReady: false });
      }
      void run();
    },
    seek(ms) {
      const to = Math.max(0, Math.min(ms, state.durationMs));
      parked = to;
      if (engine && state.stemsReady) {
        engine.player.seek(to);
      }
      emit();
    },
    setSolo(trackId) {
      if (engine && state.stemsReady) {
        for (const track of tracks) {
          engine.player.updateStem(track.id, { solo: trackId !== null && track.id === trackId });
        }
      }
      set({ solo: trackId });
    },
    attachVideo(trackId, element) {
      if (!engine || !state.stemsReady) {
        return () => undefined;
      }
      return engine.player.attachVideo(trackId, element);
    },
    dispose() {
      disposed = true;
      stopFrames();
      frameListeners.clear();
      unsubscribeClock?.();
      unsubscribeClock = null;
      const held = engine;
      engine = null;
      listeners.clear();
      if (held && sessionModule) {
        held.player.stop();
        sessionModule.clearJamStems(held);
      }
    },
  };
}
