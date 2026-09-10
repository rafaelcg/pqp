import { describeLimitation, sampleVoiceStats } from "@/lib/voice-stats-probe";
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
 *
 * The SFU sampler used to return `paths: []`, so this reading was always
 * null on a watch party and the gate held 720p forever. `livekit-session`
 * now fills paths from the publisher sender's `getStats()`.
 */

export interface PresenterHlsFeed {
  uplinkBps: number | null;
  limitedBy: HlsSourceInput["limitedBy"];
}

/**
 * The best path's estimate, in bit/s, or null when nothing reported one.
 *
 * The BEST, not the mean. On the SFU there is one publishing connection and
 * the question is what it can push; a stale or half-open pair reporting a
 * small number alongside it is not evidence about the uplink. Null is
 * "unmeasured", which the caller treats as a refusal rather than permission
 * (an unread link is not a good one).
 */
export async function readPresenterUplinkBps(): Promise<number | null> {
  const feed = await readPresenterHlsFeed();
  return feed.uplinkBps;
}

export async function readPresenterHlsFeed(): Promise<PresenterHlsFeed> {
  try {
    const snapshot = await sampleVoiceStats();
    let uplinkBps: number | null = null;
    for (const path of snapshot.paths) {
      const kbps = path.availableOutgoingKbps;
      if (typeof kbps === "number" && Number.isFinite(kbps) && kbps > 0) {
        uplinkBps = Math.max(uplinkBps ?? 0, kbps * 1000);
      }
    }
    const screen = snapshot.senders.find((row) => row.role === "screen");
    return {
      uplinkBps,
      limitedBy: screen ? describeLimitation(screen) : null,
    };
  } catch {
    return { uplinkBps: null, limitedBy: null };
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
  limitedBy?: HlsSourceInput["limitedBy"];
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
    limitedBy: input.limitedBy ?? null,
  };
}
