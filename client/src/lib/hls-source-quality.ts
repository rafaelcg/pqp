import { describeLimitation, sampleVoiceStats } from "@/lib/voice-stats-probe";
import {
  SCREEN_CAPTURE_HEIGHT,
  type HlsSourceInput,
} from "@/lib/video-quality";

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
 *
 * A LOW-LATENCY SESSION STATES NO LADDER, AND THAT IS NOT "NO SESSION".
 * `pqp-remux` is a CMAF passthrough: it does not transcode renditions, it
 * forwards the presenter's own top simulcast layer verbatim, so its
 * `voice-stream` frame carries `mode: "ll"` and no `topHeight` at all
 * (`server/src/voice/hls-remux.ts` builds the stream with `mode`,
 * `partTargetMs` and nothing about size). Reading that absence as "there is
 * no egress" is what left a production presenter publishing TWO active
 * screen encodings for a whole 21 minute party on 2026-09-17: a null here
 * means `setHlsSource(null)`, and then nothing pins the encoder, nothing
 * deactivates the 360p rung the remux never subscribes to, and nothing caps
 * the presenter's camera either.
 *
 * For a passthrough the ladder's top IS the presenter's own ceiling, so that
 * is what goes on the wire. `hlsSourceTopHeight` then holds the published
 * height at `maxPublishHeight` (720 by default) behind the measured-uplink
 * gate, exactly as it does for a conventional 1080p ladder, which is the
 * right answer here twice over: an LL viewer is handed the presenter's own
 * packets, and their loss with them.
 */
export function hlsSourceFor(input: {
  /** `stream.topHeight` from the live `voice-stream` frame, if any. */
  streamTopHeight: number | null | undefined;
  /** `stream.mode` from the same frame. Absent means conventional. */
  streamMode?: "conventional" | "ll" | undefined;
  isSharingScreen: boolean;
  usingSfu: boolean;
  uplinkBps: number | null;
  limitedBy?: HlsSourceInput["limitedBy"];
}): HlsSourceInput | null {
  if (!input.isSharingScreen || !input.usingSfu) {
    return null;
  }
  const ladderTopHeight =
    typeof input.streamTopHeight === "number"
      ? input.streamTopHeight
      : input.streamMode === "ll"
        ? SCREEN_CAPTURE_HEIGHT
        : null;
  if (ladderTopHeight === null) {
    return null;
  }
  return {
    ladderTopHeight,
    uplinkBps: input.uplinkBps,
    limitedBy: input.limitedBy ?? null,
  };
}

/**
 * The inputs `hlsSourceFor` reads off the voice state, as one comparable
 * value. `use-voice.ts` asks `refreshHlsSource` again whenever this changes,
 * whatever changed it.
 *
 * WHY A LEVEL AND NOT AN EVENT. The answer depends on three facts and only
 * one of them arrives as a `voice-stream` frame; the other two (this machine
 * sharing, this machine on the SFU) change on this page with no frame at all.
 * It used to be asked on the frame and on the 2 s sampler the frame arms, so
 * a share that went up AFTER the frame was never pinned: a reloaded presenter
 * is told the stream when it joins, before it shares, and a presenter who
 * re-shares on the same page is told nothing, because the server's stream did
 * not change. Production rehearsal E, 2026-09-25: after a reload the share
 * went out on `maintain-framerate` with no `scaleResolutionDownBy`, and the
 * whole party watched it at 280x180 for the rest of the show.
 */
export function hlsSourceInputsKey(input: {
  stream: {
    topHeight?: number | null;
    mode?: "conventional" | "ll";
  } | null;
  isSharingScreen: boolean;
  usingSfu: boolean;
}): string {
  const stream = input.stream
    ? `${input.stream.topHeight ?? ""}:${input.stream.mode ?? ""}`
    : "none";
  return `${input.usingSfu ? 1 : 0}|${input.isSharingScreen ? 1 : 0}|${stream}`;
}

/**
 * Whether the presenter's camera is held at the watch-party cap
 * (`applyWatchPartyCameraCap` in `use-voice.ts`).
 *
 * While this machine feeds the egress (`hlsSourceFor` answered), and ALSO
 * while the server still holds a live session presented by this very peer
 * with the share momentarily down. The server waits for a presenter who
 * stopped sharing (`HLS_PRESENTER_RETURN_GRACE_MS`, 60 s) and sends nothing
 * until it gives up, so the stream frame still naming this peer is the
 * server's own word that the party expects the share back. Lifting the cap in
 * that window cost a camera republish on the way up and another on the way
 * back down, and each republish is a new camera track, so each one restarted
 * the camera egress: production rehearsal C, 2026-09-25, 3.1 s cut from the
 * presenter's camera recording by a two-second screen re-share.
 *
 * Only this peer's session: somebody else presenting never caps this camera,
 * and a presenter who reloaded (a new peer id) is capped again the moment
 * their share feeds the egress.
 */
export function watchPartyCameraCapWanted(input: {
  /** `hlsSourceFor(...) !== null`. */
  hlsSourceWanted: boolean;
  usingSfu: boolean;
  /** `presenterPeerId` of the room's live `voice-stream`, null when none. */
  streamPresenterPeerId: string | null;
  ownPeerId: string | null;
}): boolean {
  if (input.hlsSourceWanted) {
    return true;
  }
  return (
    input.usingSfu &&
    input.ownPeerId !== null &&
    input.streamPresenterPeerId === input.ownPeerId
  );
}
