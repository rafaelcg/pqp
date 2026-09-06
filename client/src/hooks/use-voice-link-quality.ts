import { useEffect, useState } from "react";
import {
  qualityByPeerFromSnapshot,
  type VoiceLinkQuality,
} from "@/lib/voice-link-quality";
import { sampleVoiceStats } from "@/lib/voice-stats-probe";

/** Same cadence the probe and the video readouts were written for. */
const SAMPLE_INTERVAL_MS = 2000;

/**
 * Per-peer quality, refreshed from the same sampler the console uses.
 *
 * Polling rather than a push because `getStats()` has no change event. The
 * SFU half does not live here: LiveKit already names Excellent / Good / Poor
 * on the participant, and that reading is attached to `RemotePeer.quality`
 * in `livekit-session.ts` so a tile never has to know which transport
 * produced the bars.
 */
export function useVoiceLinkQuality(
  active: boolean,
): Record<string, VoiceLinkQuality> {
  const [byPeer, setByPeer] = useState<Record<string, VoiceLinkQuality>>({});

  useEffect(() => {
    if (!active) {
      setByPeer({});
      return;
    }
    let live = true;
    const tick = () => {
      void sampleVoiceStats().then((snapshot) => {
        if (!live) {
          return;
        }
        setByPeer(qualityByPeerFromSnapshot(snapshot));
      });
    };
    tick();
    const id = setInterval(tick, SAMPLE_INTERVAL_MS);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [active]);

  return byPeer;
}
