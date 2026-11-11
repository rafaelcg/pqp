import type { JamTrack } from "@pqp/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JamEngine, TransportState } from "@/lib/jam";
import { isJamStudioOpen } from "@/lib/jam-hint-context";
import { getJamEngine, syncJamStems, TAKE_STEM_ID, type StemStatus } from "@/lib/jam-session";
import { useEngineClock, type JamClock } from "./use-jam-clock";

export type { JamClock } from "./use-jam-clock";

/**
 * Plays a song's in-mix tracks, all at once, on the shared engine.
 *
 * The engine does the hard part (every stem placed on one frame, so they are
 * sample-aligned by construction); this hook is the screen's view of it: which
 * stems are loaded, the transport, and each lane's own mute, solo and volume.
 * Those three are the LISTENER's mix and are never sent anywhere.
 *
 * The playhead is not state (see `use-jam-clock.ts`); loading, the transport
 * and the lanes' mix are.
 */

export interface JamLaneMix {
  muted: boolean;
  solo: boolean;
  /** 0..1.5, times the track's own stored gain. */
  volume: number;
}

export const DEFAULT_LANE: JamLaneMix = { muted: false, solo: false, volume: 1 };

export interface JamPlayback {
  status: "loading" | "ready" | "error";
  transport: TransportState;
  durationMs: number;
  engine: JamEngine | null;
  clock: JamClock;
  stemStatus: Record<string, StemStatus>;
  lanes: Record<string, JamLaneMix>;
  /** An out-of-mix take being heard in place of the in-mix take of its instrument. */
  audition: string | null;
  setAudition: (trackId: string | null) => void;
  /** Press play (or pause). Call it from the click itself: it unlocks the audio. */
  toggle: () => void;
  seek: (ms: number) => void;
  setLane: (trackId: string, patch: Partial<JamLaneMix>) => void;
  /**
   * Hear a track at a volume that is not stored yet (its author is adjusting it),
   * or `null` to go back to the stored one. It is part of the mix the effect below
   * writes onto the engine, so a mute, a solo or a frame arriving while the author
   * drags cannot put the stored volume back under an editor that says otherwise.
   */
  previewGain: (trackId: string, gain: number | null) => void;
  attachVideo: (trackId: string, element: HTMLVideoElement) => () => void;
}

function mixSignature(tracks: readonly JamTrack[]): string {
  return tracks
    .filter((track) => track.inMix)
    .map((track) => [track.id, track.audioUrl.split("?")[0], track.offsetMs, track.trimStartMs, track.trimEndMs].join(":"))
    .join(",");
}

export function useJamPlayback(
  songId: string | null,
  tracks: readonly JamTrack[],
  options: { autoplay?: boolean; onPlayError?: () => void } = {},
): JamPlayback {
  const [engine, setEngine] = useState<JamEngine | null>(null);
  const [status, setStatus] = useState<JamPlayback["status"]>("loading");
  const [stemStatus, setStemStatus] = useState<Record<string, StemStatus>>({});
  const [lanes, setLanes] = useState<Record<string, JamLaneMix>>({});
  const [audition, setAudition] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, number>>({});
  const previewsRef = useRef(previews);
  previewsRef.current = previews;
  // What the engine holds: the in-mix tracks, plus the one being auditioned.
  const heard = useMemo(
    () => tracks.map((track) => (track.id === audition ? { ...track, inMix: true } : track)),
    [tracks, audition],
  );
  const tracksRef = useRef(heard);
  tracksRef.current = heard;
  const wantAutoplay = useRef(options.autoplay === true);
  const playErrorRef = useRef(options.onPlayError);
  playErrorRef.current = options.onPlayError;
  const loadedOnce = useRef(false);

  // The engine, once: created on first need, shared with the studio.
  useEffect(() => {
    if (!songId) {
      return;
    }
    let cancelled = false;
    getJamEngine().then(
      (created) => {
        if (!cancelled) {
          setEngine(created);
        }
      },
      () => {
        if (!cancelled) {
          setStatus("error");
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [songId]);

  const { clock, transport, durationMs } = useEngineClock(engine);

  // A different song starts from nothing: not ready, nothing heard yet, the
  // listener's mix of the last song forgotten, autoplay owed again.
  useEffect(() => {
    loadedOnce.current = false;
    setStatus("loading");
    setStemStatus({});
    setLanes({});
    setAudition(null);
    setPreviews({});
  }, [songId]);

  // Load what is in the mix, and again when a track arrives, leaves or moves.
  const signature = mixSignature(heard);
  useEffect(() => {
    if (!engine || !songId) {
      return;
    }
    let cancelled = false;
    // Loading again on EVERY sync, not only the first: a take arriving (or leaving)
    // changes which stems the engine holds, and a Play pressed in that window
    // started a run over a song with no length, which ended at once. The button
    // waits for the stems; nothing is lost, it is a spinner for a moment.
    setStatus("loading");
    void syncJamStems(engine, tracksRef.current, (trackId, next) => {
      if (!cancelled) {
        setStemStatus((before) => (before[trackId] === next ? before : { ...before, [trackId]: next }));
      }
    }).then(() => {
      if (cancelled) {
        return;
      }
      setStatus("ready");
      // The request waits for something to play. A song opened from a card whose details were
      // never read (a song with no video has no reason to be) first syncs an EMPTY mix, and the
      // request used to be spent there: the song opened silent. It is spent on the first sync
      // that has a take in the mix (the detail arriving changes the signature, and syncs again).
      if (!loadedOnce.current && signature !== "") {
        loadedOnce.current = true;
        // The request is spent on the song it was made for: another song opened
        // on this hook does not start by itself.
        const autoplayNow = wantAutoplay.current;
        wantAutoplay.current = false;
        // Not under the studio: "Gravar por cima" pressed before the stems were in
        // must not have the song start by itself behind the recording screen.
        if (autoplayNow && engine.context.state === "running" && !isJamStudioOpen()) {
          void engine.player.play(0);
        }
      }
    });
    return () => {
      cancelled = true;
    };
  }, [engine, songId, signature]);

  // Leaving the song: stop and let the stems go.
  useEffect(() => {
    return () => {
      // The studio plays the band in the person's ear while they record. A song
      // panel going away under it (the song was deleted) must not stop that.
      if (!engine || isJamStudioOpen()) {
        return;
      }
      engine.player.stop();
      for (const stem of engine.player.stems()) {
        if (stem.id !== TAKE_STEM_ID) {
          engine.player.removeStem(stem.id);
        }
      }
    };
  }, [engine, songId]);

  // The listener's own mix onto the engine. While a take is being auditioned
  // the in-mix take of its instrument steps aside.
  useEffect(() => {
    if (!engine) {
      return;
    }
    const auditioned = audition ? tracks.find((track) => track.id === audition) : undefined;
    for (const track of heard) {
      if (!track.inMix || !engine.player.stem(track.id)) {
        continue;
      }
      const lane = lanes[track.id] ?? DEFAULT_LANE;
      const steppedAside =
        auditioned !== undefined && track.id !== auditioned.id && track.instrument === auditioned.instrument;
      engine.player.updateStem(track.id, {
        muted: lane.muted || steppedAside,
        solo: lane.solo,
        gain: (previewsRef.current[track.id] ?? track.gain) * lane.volume,
      });
    }
  }, [engine, heard, tracks, audition, lanes, stemStatus]);

  // A volume being previewed: only the stems whose preview moved (or ended) are
  // written, so a drag costs one stem per input event, not the whole song.
  const lanesRef = useRef(lanes);
  lanesRef.current = lanes;
  const previewed = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (!engine) {
      return;
    }
    const moved = new Set([...previewed.current, ...Object.keys(previews)]);
    previewed.current = new Set(Object.keys(previews));
    for (const id of moved) {
      const track = tracksRef.current.find((one) => one.id === id);
      if (!track || !engine.player.stem(id)) {
        continue;
      }
      engine.player.updateStem(id, { gain: (previews[id] ?? track.gain) * (lanesRef.current[id] ?? DEFAULT_LANE).volume });
    }
  }, [engine, previews]);

  const toggle = useCallback(() => {
    if (!engine) {
      return;
    }
    // Unlock first, synchronously, inside the click.
    const fail = () => playErrorRef.current?.();
    engine.context.resume().catch(fail);
    if (engine.player.state === "playing") {
      engine.player.pause();
    } else {
      engine.player.play().catch(fail);
    }
  }, [engine]);

  const seek = useCallback(
    (ms: number) => {
      engine?.player.seek(ms);
    },
    [engine],
  );

  const setLane = useCallback((trackId: string, patch: Partial<JamLaneMix>) => {
    setLanes((before) => ({
      ...before,
      [trackId]: { ...(before[trackId] ?? DEFAULT_LANE), ...patch },
    }));
  }, []);

  const previewGain = useCallback((trackId: string, gain: number | null) => {
    setPreviews((before) => {
      if (gain === null) {
        if (!(trackId in before)) {
          return before;
        }
        const { [trackId]: _gone, ...rest } = before;
        return rest;
      }
      return before[trackId] === gain ? before : { ...before, [trackId]: gain };
    });
  }, []);

  const attachVideo = useCallback(
    (trackId: string, element: HTMLVideoElement) => {
      if (!engine) {
        return () => undefined;
      }
      return engine.player.attachVideo(trackId, element);
    },
    [engine],
  );

  return {
    status,
    transport,
    durationMs,
    engine,
    clock,
    stemStatus,
    lanes,
    audition,
    setAudition,
    toggle,
    seek,
    setLane,
    previewGain,
    attachVideo,
  };
}
