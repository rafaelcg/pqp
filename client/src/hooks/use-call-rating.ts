import { useEffect, useRef, useState } from "react";
import {
  advanceCall,
  finishCall,
  startCall,
  type CallProgress,
  type CallSnapshot,
  type RatableCall,
} from "@/lib/call-rating";
import {
  createQualityAccumulator,
  createReconnectTracker,
  finishQuality,
  sampleQuality,
  trackReconnects,
  type QualityAccumulator,
  type ReconnectTracker,
} from "@/lib/call-quality-summary";
import { sampleVoiceStats } from "@/lib/voice-stats-probe";

/**
 * The React shell around `lib/call-rating.ts`: watch a call, ask once when it
 * ends if the rules there say so.
 *
 * WHY A HOOK AND NOT A LINE IN THE LEAVE HANDLER. By the time the call is over
 * every fact worth recording is already gone: the peers are cleared, the
 * transport is forgotten, and whether anybody shared a screen was only true in
 * the middle. So the shape is accumulated while the call runs and frozen at the
 * end. There are also three ways out of a call (the button, a disconnect,
 * navigating away) and only one of them goes through a handler anybody
 * remembers to edit.
 *
 * THE COOLDOWN IS WRITTEN WHEN THE PROMPT IS SHOWN, not when it is answered.
 * Anything else quietly punishes the people who dismiss it, by asking them
 * again after the next call.
 */

const COOLDOWN_KEY = "pqp:call-rating-asked";

/**
 * Storage can be denied outright (private windows, embedded webviews) and the
 * accessor itself throws there rather than returning null. A browser that
 * cannot remember gets asked as often as one that can, never more: a failed
 * read looks like "asked at the epoch", and a failed write is the harmless
 * direction.
 */
function readLastAsked(): number {
  try {
    return Number(window.localStorage.getItem(COOLDOWN_KEY)) || 0;
  } catch {
    return 0;
  }
}

function writeLastAsked(now: number): void {
  try {
    window.localStorage.setItem(COOLDOWN_KEY, String(now));
  } catch {
    // Asked once more than intended, eventually.
  }
}

interface VoiceShapePeer {
  peerId: string;
  connectionState: string;
}

interface VoiceShape {
  status: string;
  remotePeers: VoiceShapePeer[];
  usingSfu: boolean;
  screenSharePeerIds: string[];
  voiceChannelId: string | null;
}

export type { RatableCall };

/** Same cadence the outbound/inbound video readouts poll `sampleVoiceStats()`
 *  at (`voice-stats-probe.ts` consumers) -- this hook shares their sampler
 *  rather than reading it at a different rate that could tell a different
 *  story about the same call. */
const QUALITY_SAMPLE_INTERVAL_MS = 2000;

export function useCallRating(voice: VoiceShape): {
  pending: RatableCall | null;
  dismiss: () => void;
} {
  const [pending, setPending] = useState<RatableCall | null>(null);
  // A ref, not state: this is written on nearly every render of an active call
  // and nothing should re-render because the peak peer count moved.
  const progress = useRef<CallProgress | null>(null);
  // What the media did, accumulated for the same lifetime as `progress`: born
  // when a call starts, read once at the end, thrown away either way. Kept in
  // refs rather than state for the same reason `progress` is.
  const quality = useRef<QualityAccumulator>(createQualityAccumulator());
  const reconnects = useRef<ReconnectTracker>(createReconnectTracker());
  // The hook's own render is not an effect, so the interval closure below
  // cannot see a fresh `voice.remotePeers` without this: written every render,
  // read only from inside the interval tick.
  const remotePeersRef = useRef<VoiceShapePeer[]>(voice.remotePeers);
  remotePeersRef.current = voice.remotePeers;

  const connected = voice.status === "connected";
  const snapshot: CallSnapshot = {
    peerCount: voice.remotePeers.length,
    usingSfu: voice.usingSfu,
    screenSharing: voice.screenSharePeerIds.length > 0,
    channelId: voice.voiceChannelId,
  };

  useEffect(() => {
    if (connected) {
      if (!progress.current) {
        // A fresh call: start clean rather than carrying over whatever the
        // previous call happened to leave in these accumulators.
        quality.current = createQualityAccumulator();
        reconnects.current = createReconnectTracker();
      }
      progress.current = progress.current
        ? advanceCall(progress.current, snapshot)
        : startCall(snapshot, Date.now());
      return;
    }
    const finished = progress.current;
    progress.current = null;
    if (!finished) {
      return;
    }
    const now = Date.now();
    const ratable = finishCall(finished, now, readLastAsked());
    if (!ratable) {
      return;
    }
    writeLastAsked(now);
    setPending({
      ...ratable,
      mediaQuality: {
        ...finishQuality(quality.current),
        reconnectCount: reconnects.current.reconnectCount,
      },
    });
    // `snapshot` is rebuilt every render, so the individual fields are the deps
    // rather than the object; depending on the object would run this on every
    // render of the whole app.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    connected,
    snapshot.peerCount,
    snapshot.usingSfu,
    snapshot.screenSharing,
    snapshot.channelId,
  ]);

  // Polling rather than pushing, for the same reason the readouts poll:
  // `getStats()` has no change event. Only runs while a call is connected, so
  // an idle app never touches `getStats()` at all.
  useEffect(() => {
    if (!connected) {
      return;
    }
    const tick = () => {
      trackReconnects(reconnects.current, remotePeersRef.current);
      void sampleVoiceStats().then((snap) => {
        sampleQuality(quality.current, snap);
      });
    };
    tick();
    const id = setInterval(tick, QUALITY_SAMPLE_INTERVAL_MS);
    return () => clearInterval(id);
  }, [connected]);

  return { pending, dismiss: () => setPending(null) };
}
