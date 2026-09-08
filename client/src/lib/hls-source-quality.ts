import { sampleVoiceStats } from "@/lib/voice-stats-probe";
import type { HlsSourceInput } from "@/lib/video-quality";

/**
 * The presenter's half of the ladder.
 *
 * WHAT THIS DECIDES. A watch party's audience is on the HLS playlist, and
 * every rendition on that playlist is transcoded from the ONE WebRTC track
 * the presenter publishes. So the published track is the ceiling of the whole
 * ladder: hold it at the large-room 720p cap and the 1080p rung is a 720p
 * upscale, however the server is configured. This module answers "raise the
 * published top to the ladder's top, or not", and the only two inputs are the
 * ladder's own top (which the server states on the stream frame, after the
 * budget guard, so a refused rung never asks the presenter to pay for it) and
 * this machine's measured uplink.
 *
 * WHY IT REUSES THE CANDIDATE-PAIR READING. `screen-upload-budget.ts` already
 * settled how this product measures an uplink: `availableOutgoingBitrate` off
 * the selected ICE candidate pair, which is the browser's own bandwidth
 * estimate rather than a guess derived from what we happen to be sending. It
 * reads it per peer connection for the mesh; `sampleVoiceStats().paths` is
 * the same reading, already collected for both transports. A second estimate
 * invented here would disagree with the first one on exactly the links where
 * it mattered.
 */

/**
 * The best path's estimate, in bit/s, or null when nothing reported one.
 *
 * The BEST, not the mean. On the SFU there is one publishing connection and
 * the question is what it can push; a stale or half-open pair reporting a
 * small number alongside it is not evidence about the uplink. Null is
 * "unmeasured", which the caller treats as permission rather than refusal
 * (an unread link is not a bad one).
 */
export async function readPresenterUplinkBps(): Promise<number | null> {
  try {
    const snapshot = await sampleVoiceStats();
    let best: number | null = null;
    for (const path of snapshot.paths) {
      const kbps = path.availableOutgoingKbps;
      if (typeof kbps === "number" && Number.isFinite(kbps) && kbps > 0) {
        best = Math.max(best ?? 0, kbps * 1000);
      }
    }
    return best;
  } catch {
    // The room went away mid-sample. Unmeasured, not bad.
    return null;
  }
}

/**
 * What to hand `LiveKitSession.setHlsSource`.
 *
 * Null unless all three are true: an egress is live on this channel, this
 * machine is the one sharing, and the room is on the SFU. Anything else is
 * an ordinary call whose large-room cap this feature must not touch.
 */
export function hlsSourceFor(input: {
  /** `stream.topHeight` from the live `voice-stream` frame, if any. */
  streamTopHeight: number | null | undefined;
  isSharingScreen: boolean;
  usingSfu: boolean;
  uplinkBps: number | null;
}): HlsSourceInput | null {
  if (
    !input.isSharingScreen ||
    !input.usingSfu ||
    typeof input.streamTopHeight !== "number"
  ) {
    return null;
  }
  return {
    ladderTopHeight: input.streamTopHeight,
    uplinkBps: input.uplinkBps,
  };
}
