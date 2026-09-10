import { EncodingOptions, VideoCodec } from "livekit-server-sdk";
import { VOICE_PROMOTION_DEFAULT_MAX_MBPS } from "./promotion.js";

/**
 * The adaptive bitrate ladder for live HLS.
 *
 * WHY MORE THAN ONE RENDITION. Until now the egress encoded exactly one
 * profile (`LIVE_HLS_PRESET`, 720p30), so every viewer got the same picture
 * whatever their device or link: a phone on mobile data paid for a desktop's
 * quality, and a desktop on fibre was capped at a phone's. WebRTC already
 * solves this with simulcast. HLS solves it with a master playlist listing
 * several renditions, and the player picks per viewer and re-picks as the
 * link changes.
 *
 * WHY ONE EGRESS PER RUNG. `TrackCompositeEgressRequest` (protocol 1.50.4,
 * which is what `livekit-server-sdk` ^2.17.0 and the pinned `livekit/egress
 * v1.14.1` image speak) carries `repeated SegmentedFileOutput segment_outputs`
 * but a SINGLE `options` oneof: one preset, or one `EncodingOptions`, for the
 * whole request. Several outputs on one egress therefore all get the same
 * encode. A ladder is one egress per rung, and this file is what prices that.
 *
 * WHY EXPLICIT BITRATES RATHER THAN LiveKit's PRESETS. The presets are
 * 720p30 = 3000 kbit/s and 1080p30 = 4500. As a ladder that is a gap of 1.5x,
 * and hls.js's own hysteresis (`abrBandWidthUpFactor` 0.7 to switch up,
 * `abrBandWidthFactor` 0.95 to switch down) leaves a band of only 4286 to
 * 4737 kbit/s between "climb to 1080p" and "fall off 1080p": about 1.10x
 * wide, which is where a viewer oscillates between two renditions that look
 * nearly the same. The rungs below set 720p30 to 1800 kbit/s instead, which
 * is both a real mobile-data rung and a 2.5x gap: the same arithmetic gives
 * a band of 4737 to 6430 kbit/s, about 1.36x, which is a stable switch.
 * Screen content also compresses far better than camera content, so 1800 at
 * 720p is not the compromise the number looks like.
 */

/** One rung of the ladder: a resolution, a bitrate, and what to claim for it. */
export interface LadderRung {
  /** The name in `LIVE_HLS_LADDER`, e.g. `1080p30`. */
  name: string;
  width: number;
  height: number;
  framerate: number;
  /** Video bitrate in kbit/s. What the egress is asked to encode at. */
  videoKbps: number;
  /** Audio bitrate in kbit/s. */
  audioKbps: number;
  /** RFC 6381 codec string for the master playlist's `CODECS` attribute. */
  codecs: string;
}

/**
 * H.264 Main profile (`4d`), no constraint flags (`00`), then the level in
 * hex. Egress encodes H.264 Main by default (`EncodingOptions.video_codec`
 * defaults to `H264_MAIN`) and muxes AAC-LC into MPEG-TS segments, which is
 * `mp4a.40.2`.
 */
const AAC_LC = "mp4a.40.2";
const H264_MAIN_L40 = "avc1.4d0028";
const H264_MAIN_L31 = "avc1.4d001f";
const H264_MAIN_L30 = "avc1.4d001e";

/**
 * Every rung a deployment may name. Only the ones listed in
 * `LIVE_HLS_LADDER` are ever started; the rest exist so an operator can add
 * one with an environment variable rather than a deploy.
 */
export const LADDER_RUNGS: Readonly<Record<string, LadderRung>> = {
  "1080p30": {
    name: "1080p30",
    width: 1920,
    height: 1080,
    framerate: 30,
    videoKbps: 4500,
    audioKbps: 128,
    codecs: `${H264_MAIN_L40},${AAC_LC}`,
  },
  "720p30": {
    name: "720p30",
    width: 1280,
    height: 720,
    framerate: 30,
    videoKbps: 1800,
    audioKbps: 128,
    codecs: `${H264_MAIN_L31},${AAC_LC}`,
  },
  "480p30": {
    name: "480p30",
    width: 854,
    height: 480,
    framerate: 30,
    videoKbps: 900,
    audioKbps: 96,
    codecs: `${H264_MAIN_L30},${AAC_LC}`,
  },
  "360p30": {
    name: "360p30",
    width: 640,
    height: 360,
    framerate: 30,
    videoKbps: 500,
    audioKbps: 96,
    codecs: `${H264_MAIN_L30},${AAC_LC}`,
  },
};

/**
 * The default ladder. 1080p because the point of the exercise is that people
 * get the best picture their link can carry, 720p because it is the floor a
 * desktop should still enjoy, 480p because a phone on mobile data cannot
 * hold 1800 kbit/s and used to buffer on the old two-rung default. A viewer
 * whose link cannot hold 900 kbit/s still has no lower rung: add `360p30`
 * by configuration for that audience.
 */
export const DEFAULT_LADDER = "1080p30,720p30,480p30";

/**
 * BANDWIDTH in a master playlist is the PEAK segment bitrate, not the
 * average, so a player that sizes its buffer from it is not caught out by a
 * busy two seconds. AVERAGE-BANDWIDTH carries the nominal figure.
 */
const PEAK_HEADROOM = 1.15;

/** `BANDWIDTH` for one rung, in bit/s. */
export function rungPeakBandwidth(rung: LadderRung): number {
  return Math.round((rung.videoKbps + rung.audioKbps) * 1000 * PEAK_HEADROOM);
}

/** `AVERAGE-BANDWIDTH` for one rung, in bit/s. */
export function rungAverageBandwidth(rung: LadderRung): number {
  return (rung.videoKbps + rung.audioKbps) * 1000;
}

export interface ParsedLadder {
  /** The rungs to run, LOWEST BITRATE FIRST. Never empty. */
  rungs: LadderRung[];
  /** Entries that named nothing, kept so the caller can log them once. */
  invalid: string[];
}

/**
 * One entry of `LIVE_HLS_LADDER`: a rung name, optionally with a bitrate
 * override (`1080p30@3500`) so an operator can retune a rung for a slow
 * upload path without a deploy.
 */
function parseEntry(raw: string): LadderRung | null {
  const [namePart, kbpsPart] = raw.trim().toLowerCase().split("@", 2);
  const base = namePart ? LADDER_RUNGS[namePart] : undefined;
  if (!base) {
    return null;
  }
  if (kbpsPart === undefined) {
    return base;
  }
  const kbps = Number(kbpsPart);
  if (!Number.isFinite(kbps) || kbps <= 0) {
    return null;
  }
  return { ...base, videoKbps: Math.floor(kbps) };
}

/**
 * `LIVE_HLS_LADDER`, with `LIVE_HLS_PRESET` still honoured as the name of a
 * one-rung ladder so a deployment that already sets it keeps working.
 * Neither set means `DEFAULT_LADDER`. A list that names nothing valid also
 * falls back to the default rather than leaving a watch party with no
 * rendition at all: the caller logs `invalid` so the mistake is visible.
 *
 * Duplicates collapse (the first wins), and the result is sorted by bitrate
 * ascending, which is both the order rungs are started in and the order a
 * master playlist conventionally lists them.
 */
export function parseLadder(input: {
  ladder?: string | null;
  preset?: string | null;
}): ParsedLadder {
  const raw = input.ladder?.trim()
    ? input.ladder
    : input.preset?.trim()
      ? input.preset
      : DEFAULT_LADDER;
  const invalid: string[] = [];
  const byName = new Map<string, LadderRung>();
  for (const entry of raw.split(",")) {
    if (entry.trim() === "") {
      continue;
    }
    const rung = parseEntry(entry);
    if (!rung) {
      invalid.push(entry.trim());
      continue;
    }
    if (!byName.has(rung.name)) {
      byName.set(rung.name, rung);
    }
  }
  const rungs = [...byName.values()].sort(
    (a, b) => a.videoKbps - b.videoKbps || a.height - b.height,
  );
  if (rungs.length === 0) {
    return {
      rungs: parseLadder({ ladder: DEFAULT_LADDER }).rungs,
      invalid,
    };
  }
  return { rungs, invalid };
}

/**
 * The egress encoding for one rung. Advanced `EncodingOptions` rather than a
 * preset because the ladder needs bitrates the presets do not offer (and
 * rungs the presets do not have at all, like 480p). `keyFrameInterval` is
 * left at zero on purpose: for a segmented output egress uses the segment
 * duration, which is what makes segment boundaries land on keyframes in
 * every rung and lets a player switch between them.
 */
export function rungEncodingOptions(rung: LadderRung): EncodingOptions {
  return new EncodingOptions({
    width: rung.width,
    height: rung.height,
    framerate: rung.framerate,
    videoCodec: VideoCodec.H264_MAIN,
    videoBitrate: rung.videoKbps,
    audioBitrate: rung.audioKbps,
  });
}

// ---------------------------------------------------------------- the budget

/**
 * What one live rendition costs the media box, expressed in the same
 * Mbit/s currency `promotion.ts` already prices WebRTC in, so that the two
 * cannot each claim the same core.
 *
 * The conversion, stated because it is arithmetic and not a measurement:
 * a live transcode costs roughly one core of the media box on moving content
 * (`docs/CAPACITY.md` §2, co-tenancy note), the box is 4 vCPU
 * (`vhp-4c-8gb-amd`, §2), and `promotion.ts` prices that whole box at
 * `VOICE_PROMOTION_DEFAULT_MAX_MBPS`. One core is therefore a quarter of
 * that budget. No run has ever had egress active concurrently with a WebRTC
 * room, so this is the honest form of "we do not know exactly, and here is
 * the reasoning we are refusing on".
 */
export const MEDIA_BOX_CORES = 4;
export const HLS_RUNG_MBPS = VOICE_PROMOTION_DEFAULT_MAX_MBPS / MEDIA_BOX_CORES;

/**
 * Default ceiling for the ladder ALONE: three quarters of the box, which
 * is the three-rung default. A fourth rung still needs the operator to
 * say so.
 */
export const DEFAULT_MAX_LADDER_MBPS = HLS_RUNG_MBPS * 3;

/**
 * `LIVE_HLS_MAX_LADDER_MBPS`, read per call like `promotionBudgetMbps()` so
 * an operator can widen or close it without a deploy. `0` is a real value:
 * it holds every watch party to its lowest rung.
 */
export function ladderBudgetMbps(): number {
  const raw = process.env.LIVE_HLS_MAX_LADDER_MBPS?.trim();
  if (!raw) {
    return DEFAULT_MAX_LADDER_MBPS;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    return DEFAULT_MAX_LADDER_MBPS;
  }
  return value;
}

export type RungRefusal = "ladder-budget" | "box-budget" | "source-height";

/**
 * How many lines taller than the published source a rung may still start.
 * A 1670×1078 window is a 1080p share that missed by two pixels; treating
 * that as "not 1080" would refuse the top rung every time someone shares
 * a window instead of a 16:9 screen.
 */
export const SOURCE_HEIGHT_SLACK = 16;

export interface RungDecision {
  rung: LadderRung;
  start: boolean;
  refusal: RungRefusal | null;
  /** Ladder cost including this rung, Mbit/s. */
  ladderMbps: number;
  /** Ladder cost plus the WebRTC load already on the box, Mbit/s. */
  boxMbps: number;
}

export interface LadderDecisionInput {
  rungs: readonly LadderRung[];
  /** Renditions already running on this box for other channels. */
  runningRungs: number;
  /** What `estimateSfuLoadMbps` says the WebRTC side already costs. */
  sfuLoadMbps: number;
  ladderBudgetMbps: number;
  boxBudgetMbps: number;
  /**
   * Published capture height, in lines. Extra rungs taller than this
   * (plus `SOURCE_HEIGHT_SLACK`) are an upscale and are refused. The
   * lowest rung still starts: a watch party with no rendition is a
   * watch party nobody can see. Absent / null is an older client, and
   * the configured ladder runs as before.
   */
  sourceHeight?: number | null;
}

/**
 * Which rungs may start.
 *
 * Two rules, in this order:
 *
 * 1. **The lowest rung always starts.** A watch party with no rendition is a
 *    watch party nobody can see, and one rendition is what shipped before
 *    this file existed. The budget governs the EXTRA rungs, never the
 *    existence of the stream. Its cost is still counted, so the rungs above
 *    it see an honest running total.
 * 2. Every rung above it is refused when it is taller than the published
 *    source (an upscale), or when it would push the ladder past
 *    `LIVE_HLS_MAX_LADDER_MBPS`, or the ladder plus the WebRTC already on the
 *    box past the promotion budget. The last check is the one that matters
 *    during a busy evening: the cameras and screen shares on the same box are
 *    priced by `promotion.ts` and this must not pretend they are free.
 *
 * Rungs are considered lowest first, so a refusal always costs the viewer the
 * best rendition rather than the only one.
 */
export function decideLadder(input: LadderDecisionInput): RungDecision[] {
  const ordered = [...input.rungs].sort((a, b) => a.videoKbps - b.videoKbps);
  const decisions: RungDecision[] = [];
  let ladderMbps = input.runningRungs * HLS_RUNG_MBPS;
  for (const [index, rung] of ordered.entries()) {
    const nextLadder = ladderMbps + HLS_RUNG_MBPS;
    const nextBox = nextLadder + input.sfuLoadMbps;
    if (index === 0) {
      ladderMbps = nextLadder;
      decisions.push({
        rung,
        start: true,
        refusal: null,
        ladderMbps: nextLadder,
        boxMbps: nextBox,
      });
      continue;
    }
    let refusal: RungRefusal | null = null;
    if (
      input.sourceHeight != null &&
      input.sourceHeight > 0 &&
      rung.height > input.sourceHeight + SOURCE_HEIGHT_SLACK
    ) {
      refusal = "source-height";
    } else if (nextLadder > input.ladderBudgetMbps) {
      refusal = "ladder-budget";
    } else if (nextBox > input.boxBudgetMbps) {
      refusal = "box-budget";
    }
    if (refusal === null) {
      ladderMbps = nextLadder;
    }
    decisions.push({
      rung,
      start: refusal === null,
      refusal,
      ladderMbps: nextLadder,
      boxMbps: nextBox,
    });
  }
  return decisions;
}

// -------------------------------------------------------- the master playlist

export interface MasterVariant {
  rung: LadderRung;
  /** What the player should fetch for this rendition. */
  uri: string;
}

/**
 * The master playlist: one `EXT-X-STREAM-INF` per rendition that actually
 * started, highest bitrate LAST so the list reads the conventional way and a
 * player that ignores ABR entirely lands on the lowest rung rather than the
 * most expensive one.
 *
 * `BANDWIDTH`, `RESOLUTION` and `CODECS` are all required for a useful pick:
 * without CODECS a player cannot check MSE support before committing, and
 * without RESOLUTION it cannot avoid sending a 1080p rendition to a 360px
 * element. `FRAME-RATE` is advisory and cheap.
 *
 * A single-variant ladder still gets a master playlist. That is deliberate:
 * one code path, and hls.js handles a one-level master identically to a bare
 * media playlist.
 */
export function buildMasterPlaylist(variants: readonly MasterVariant[]): string {
  const ordered = [...variants].sort(
    (a, b) => a.rung.videoKbps - b.rung.videoKbps,
  );
  const lines = ["#EXTM3U", "#EXT-X-VERSION:3"];
  for (const variant of ordered) {
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${rungPeakBandwidth(variant.rung)},` +
        `AVERAGE-BANDWIDTH=${rungAverageBandwidth(variant.rung)},` +
        `RESOLUTION=${variant.rung.width}x${variant.rung.height},` +
        `FRAME-RATE=${variant.rung.framerate.toFixed(3)},` +
        `CODECS="${variant.rung.codecs}"`,
    );
    lines.push(variant.uri);
  }
  return `${lines.join("\n")}\n`;
}
