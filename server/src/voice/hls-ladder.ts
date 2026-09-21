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
 * nearly the same. The rungs below keep a ≥2.5× gap (8000 against 3200):
 * the same arithmetic gives a band of about 1.36×, which is a stable switch.
 * Film and games need those higher numbers: 1800 at 720p looked like a
 * slideshow even when the host's YouTube tab was clean.
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
const H264_MAIN_L42 = "avc1.4d002a";
const H264_MAIN_L40 = "avc1.4d0028";
const H264_MAIN_L32 = "avc1.4d0020";
const H264_MAIN_L31 = "avc1.4d001f";
const H264_MAIN_L30 = "avc1.4d001e";

/**
 * Every rung a deployment may name. Only the ones listed in
 * `LIVE_HLS_LADDER` are ever started; the rest exist so an operator can add
 * one with an environment variable rather than a deploy.
 */
export const LADDER_RUNGS: Readonly<Record<string, LadderRung>> = {
  /**
   * Named 1080p60 option. 60 fps is how a 24 fps film on a 60 Hz display
   * stays as smooth as the host's screen: capture and HLS match the
   * compositor instead of recadencing to 30 (3:2 judder). Do not stack it
   * next to `1080p30` — same height, and the viewer's pin is by height.
   * Costs roughly 1.6–2× a 1080p30 encode on the media box. Off by default;
   * an operator who wants it sets `LIVE_HLS_LADDER`.
   */
  "1080p60": {
    name: "1080p60",
    width: 1920,
    height: 1080,
    framerate: 60,
    videoKbps: 8000,
    audioKbps: 128,
    codecs: `${H264_MAIN_L42},${AAC_LC}`,
  },
  "1080p30": {
    name: "1080p30",
    width: 1920,
    height: 1080,
    framerate: 30,
    videoKbps: 6500,
    audioKbps: 128,
    codecs: `${H264_MAIN_L40},${AAC_LC}`,
  },
  "720p30": {
    name: "720p30",
    width: 1280,
    height: 720,
    framerate: 30,
    videoKbps: 3200,
    audioKbps: 128,
    codecs: `${H264_MAIN_L31},${AAC_LC}`,
  },
  /**
   * Named 720p60 option. Bitrate overridden to 3200 when stacked under
   * 1080p60 so the ABR gap stays ≥2.5×. 60 fps so a viewer whose player
   * size or link pins 720 still sees the host's display cadence (a 24 fps
   * film on a 60 Hz screen) instead of 3:2 judder. The named 5500 is what
   * `720p60,480p30` spends when 720 is the top. Do not stack it next to
   * `720p30` — same height, and the viewer's pin is by height.
   */
  "720p60": {
    name: "720p60",
    width: 1280,
    height: 720,
    framerate: 60,
    videoKbps: 5500,
    audioKbps: 128,
    codecs: `${H264_MAIN_L32},${AAC_LC}`,
  },
  "480p30": {
    name: "480p30",
    width: 854,
    height: 480,
    framerate: 30,
    videoKbps: 1200,
    audioKbps: 96,
    codecs: `${H264_MAIN_L30},${AAC_LC}`,
  },
  "360p30": {
    name: "360p30",
    width: 640,
    height: 360,
    framerate: 30,
    videoKbps: 700,
    audioKbps: 96,
    codecs: `${H264_MAIN_L30},${AAC_LC}`,
  },
};

/**
 * The presenter's CAMERA, and it is deliberately not in `LADDER_RUNGS`.
 *
 * A watch party's audience is seatless: they never join the LiveKit room, so a
 * camera published into it reaches the seated participants over WebRTC and
 * reaches nobody on the playlist. And `TrackCompositeEgressRequest` carries one
 * video and one audio track, singular fields, so the running transcode cannot
 * be asked to also carry a face. The answer is a second, video-only egress
 * beside the ladder, writing under the same session prefix. See
 * `docs/WATCH_PARTY.md` "The presenter's camera, floating over the film".
 *
 * WHY IT IS NOT A RUNG, and each of these would be a bug if it were:
 *
 *  - `sessionRungs` builds the master playlist's variants by looking each
 *    stored rung up in `LADDER_RUNGS`. A camera listed there is a variant a
 *    viewer's ABR could switch **to**, and they would get a webcam instead of
 *    the film.
 *  - `decideLadder` prices renditions OF THE SHARE. The camera is not one, and
 *    it must never be the thing that costs the audience a rung.
 *  - `adoptLiveHlsSession` reads the same table, so a camera egress adopted
 *    across a deploy would quietly become a 720p30 ladder rung.
 *
 * `audioKbps: 0` is the video-only request: the field is proto3, so zero is
 * unset, and `rungEncodingOptions` therefore asks for no audio at all. The
 * egress is started with no `audioTrackId`, which is the same shape a share
 * picked without its own audio already produces in production.
 *
 * 360p30 at 400 kbit/s is lockstep with the presenter's camera cap while
 * sharing: the egress transcodes from the published track, so a rung above
 * what the presenter publishes is an upscale that costs a core to invent
 * pixels.
 */
export const CAMERA_RUNG_NAME = "cam360p30";

export const CAMERA_RUNG: LadderRung = {
  name: CAMERA_RUNG_NAME,
  width: 640,
  height: 360,
  framerate: 30,
  videoKbps: 400,
  audioKbps: 0,
  codecs: `${H264_MAIN_L30}`,
};

/**
 * The same camera rung, WITH the presenter's microphone attached.
 *
 * `LIVE_HLS_VOICE_TRACK`, dark by default: `reconcileCameraEgress` in
 * `hls-egress.ts` picks this over `CAMERA_RUNG` exactly when the flag is on
 * and the sharer's ordinary (non-archive) microphone publication is found
 * beside their camera. Same `name` as `CAMERA_RUNG` ON PURPOSE — it is the
 * same slot, same object prefix, same playlist URL, just carrying a second
 * track this time — so nothing that looks the rung up by name (the health
 * monitor, the box-budget ghost filter, the retention sweep) needs to know
 * which of the two variants is running underneath it.
 *
 * 64 kbit/s Opus-in-AAC is a voice track, not a music one: small enough that
 * it barely moves `HLS_CAMERA_MBPS`'s own estimate, which is why the box cost
 * below is not repriced for it.
 */
export const CAMERA_RUNG_WITH_VOICE: LadderRung = {
  ...CAMERA_RUNG,
  audioKbps: 64,
  codecs: `${H264_MAIN_L30},${AAC_LC}`,
};

/**
 * The presenter's voice ALONE, no camera published.
 *
 * `LIVE_HLS_VOICE_TRACK`'s other half: a presenter who turned "separada" on
 * but has no webcam still owes the audience a way to hear them apart from the
 * film, so `reconcileCameraEgress` starts a Track Composite with an audio
 * track and no video one at all — legal per the protocol (both fields are
 * optional; a share picked with no audio of its own already starts one with
 * no `audioTrackId` in production, the mirror case). `width`/`height`/
 * `framerate`/`videoKbps` are all zero because there is no video to encode;
 * `rungEncodingOptions` is still called with this so the audio bitrate has
 * somewhere to come from, and a zeroed `EncodingOptions.width`/`height` on a
 * request that carries no video track is untested against the pinned egress
 * image — the honest caveat `HLS_CAMERA_MBPS`'s own comment already sets the
 * tone for.
 *
 * SAME NAME AS `CAMERA_RUNG_NAME`, for the same reason `CAMERA_RUNG_WITH_VOICE`
 * shares it: one slot, one prefix, one playlist path, whichever of the three
 * shapes happens to be running.
 */
export const VOICE_RUNG: LadderRung = {
  name: CAMERA_RUNG_NAME,
  width: 0,
  height: 0,
  framerate: 0,
  videoKbps: 0,
  audioKbps: 32,
  codecs: AAC_LC,
};

/**
 * Every rung name this build can ever produce a transcode under, ladder plus
 * camera. The thing to check a CLIENT-SUPPLIED rung name against before it
 * touches anything keyed on it (a Farol B0.5 finding, 2026-09-13): without
 * this, `POST /api/live-hls/telemetry`'s `rung` field is a free-form 1-16
 * character string an authenticated caller controls, and every accepted
 * value becomes its own permanent key in `hls-latency-metrics.ts`'s
 * per-rung histogram map -- one authenticated account sending distinct
 * garbage rungs grows that map without bound for the life of the process.
 */
// `Object.create(null)` on purpose, not `{}`: a plain object literal
// inherits `Object.prototype`, so a bracket lookup with an ATTACKER-CONTROLLED
// key like `"toString"` or `"constructor"` returns a real (truthy) function
// off the prototype chain instead of `undefined` -- a second Farol finding,
// 2026-09-13, on the exact line meant to close the first one. A prototype-less
// object has no such inherited properties to leak through the lookup.
const ALL_KNOWN_RUNGS: Readonly<Record<string, LadderRung>> = Object.assign(
  Object.create(null) as Record<string, LadderRung>,
  LADDER_RUNGS,
  { [CAMERA_RUNG_NAME]: CAMERA_RUNG },
);

/**
 * The two rung names the low-latency path reports, straight from
 * `LL_VIDEO_RUNG` / `LL_AUDIO_RUNG` in `tools/hls-edge/src/ll-state.js`
 * ("ll" / "ll-audio"). Kept as a local literal rather than an import --
 * `tools/hls-edge` is a standalone Worker package with no `@pqp/shared`
 * dependency, the same reason `llObjectPrefix` in `hls-remux.ts` duplicates
 * its own small literal from that file instead of importing it. These two
 * names never appear in `LADDER_RUNGS` (that ladder is the conventional
 * egress only) and have no real `LadderRung` entry -- no width, height, or
 * bitrate to invent -- so they are checked here rather than folded into
 * `ALL_KNOWN_RUNGS`. `hlsRungVideoKbps` already returns null for a name with
 * no `LadderRung`, which is what a name with no real bitrate should do: it
 * sorts last in `byRung` instead of claiming a made-up number.
 */
const LL_RUNGS = new Set(["ll", "ll-audio"]);

export function isKnownHlsRung(rung: string): boolean {
  return Object.hasOwn(ALL_KNOWN_RUNGS, rung) || LL_RUNGS.has(rung);
}

/**
 * The bitrate a rung name sorts by, lowest first -- what "lowest bitrate
 * first" actually means, rather than `localeCompare` on the name (which puts
 * `1080p30` before `720p30`). Null for a name with no real `LadderRung` --
 * a name this build does not know at all, or one of the LL rungs above,
 * which have no bitrate to report -- so a caller can put those last rather
 * than guessing where they sort. Checked against `ALL_KNOWN_RUNGS` directly
 * rather than `isKnownHlsRung`: that also accepts the LL names, which is
 * right for "should this sample be recorded at all" but wrong here, where
 * there is no entry to look up.
 */
export function hlsRungVideoKbps(rung: string): number | null {
  return Object.hasOwn(ALL_KNOWN_RUNGS, rung)
    ? ALL_KNOWN_RUNGS[rung]!.videoKbps
    : null;
}

/**
 * The default ladder. One 720p30 rung: 1080p30 tiled HLS hit RTP gaps and
 * egress CPU on the media box, so watch party ships at 720p30. Named 1080
 * and 60 fps rungs stay in `LADDER_RUNGS` for an operator who wants them
 * (`LIVE_HLS_LADDER=1080p30,720p30`, or `1080p60,720p60@3200,480p30`).
 */
export const DEFAULT_LADDER = "720p30";

/** Highest fps any of these rungs asks for. 30 when the list is empty. */
export function ladderMaxFramerate(rungs: readonly LadderRung[]): number {
  return rungs.reduce((max, rung) => Math.max(max, rung.framerate), 30);
}

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
 * 2 seconds, matching `segmentDuration`, so segment boundaries land on
 * keyframes in every rung and a player can switch between them.
 */
export function rungEncodingOptions(rung: LadderRung): EncodingOptions {
  return new EncodingOptions({
    width: rung.width,
    height: rung.height,
    framerate: rung.framerate,
    videoCodec: VideoCodec.H264_MAIN,
    videoBitrate: rung.videoKbps,
    audioBitrate: rung.audioKbps,
    keyFrameInterval: 2,
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

/**
 * What the camera's rendition costs the media box, in the same Mbit/s currency
 * as `HLS_RUNG_MBPS`.
 *
 * THIRTY PER CENT OF A FULL RENDITION, and that is an estimate stated as one.
 * `docs/CAPACITY.md` §2 measured a Track Composite egress at **0.51 core** for
 * `720p30` at 1800 kbit/s and **0.88 core** for `1080p30` at 4500. A `360p30`
 * rendition at 400 kbit/s is roughly a fifth of the 720p30 pixel rate, so 0.2
 * to 0.3 of a core is the honest range and the top of it is what is charged.
 * Nobody has measured this one; when somebody does, this is the line to
 * change.
 */
export const HLS_CAMERA_MBPS = HLS_RUNG_MBPS * 0.3;

/**
 * What the presenter's VOICE ALONE costs the box, when `LIVE_HLS_VOICE_TRACK`
 * starts a Track Composite with no video track at all (`VOICE_RUNG`).
 *
 * A TENTH OF A CAMERA'S OWN ESTIMATE, and stated as an estimate the same way
 * `HLS_CAMERA_MBPS` is: nobody has measured an audio-only Track Composite on
 * this box. What is not a guess is the shape of the saving — there is no
 * frame to encode, so whatever a camera's 0.2 to 0.3 of a core is mostly
 * spending it on is exactly the part this rung skips.
 */
export const HLS_VOICE_ONLY_MBPS = HLS_RUNG_MBPS * 0.03;

export interface CameraEgressDecision {
  start: boolean;
  /** Null when it starts. `box-budget` is the only way it does not. */
  refusal: "box-budget" | null;
  /** Ladder plus camera plus the WebRTC already on the box, Mbit/s. */
  boxMbps: number;
}

/**
 * Whether the presenter's camera may have a transcode of its own.
 *
 * ONE RULE, AND IT IS NEVER THE LADDER'S. The camera is priced against the
 * WHOLE box (the renditions already running plus what `promotion.ts` says the
 * WebRTC side costs) and refused when it would push past the promotion budget.
 * There is deliberately no ladder-budget check: `LIVE_HLS_MAX_LADDER_MBPS`
 * governs how many renditions of the SHARE a party gets, and a camera must
 * never be the reason a viewer loses a rung of the film. The trade only ever
 * goes the other way — a box with no room left gets no camera, and the party
 * is untouched.
 *
 * Pure, so the whole matrix is testable without a media server.
 */
export function decideCameraEgress(input: {
  /** Renditions already running on this box, this session's included. */
  runningRungs: number;
  /** What `estimateSfuLoadMbps` says the WebRTC side already costs. */
  sfuLoadMbps: number;
  boxBudgetMbps: number;
  /**
   * Whether this slot has a camera video track. Default true, which is every
   * caller before `LIVE_HLS_VOICE_TRACK`: the cost was always a camera's.
   * False prices it as `HLS_VOICE_ONLY_MBPS` instead — the audio-alone rung,
   * `VOICE_RUNG`, which has no frame to encode.
   */
  hasVideo?: boolean;
}): CameraEgressDecision {
  const ownCost = input.hasVideo === false ? HLS_VOICE_ONLY_MBPS : HLS_CAMERA_MBPS;
  const boxMbps = input.runningRungs * HLS_RUNG_MBPS + ownCost + input.sfuLoadMbps;
  return boxMbps > input.boxBudgetMbps
    ? { start: false, refusal: "box-budget", boxMbps }
    : { start: true, refusal: null, boxMbps };
}

// -------------------------------------------------------- the master playlist

export interface MasterVariant {
  rung: LadderRung;
  /** What the player should fetch for this rendition. */
  uri: string;
}

/**
 * `#EXT-X-PQP-SESSION:<id>` — our own comment tag naming the `hls_sessions`
 * row a playlist came from (BROADCAST_PIPELINE B0.4). Deliberately not a
 * standard HLS tag and deliberately not a status: it names identity only, so
 * a client's telemetry batch and this server's own `voice.hls*` logs can be
 * stitched together on one id instead of a reader guessing from a time
 * window. CLAUDE.md already explains why `hls_sessions` gets no status enum
 * of its own; this is the same rule applied to the playlist.
 *
 * A comment tag (`#EXT-X-...` with no player-defined meaning) is ignored by
 * every HLS parser this product ships against: hls.js skips unknown tags,
 * and so does `AVPlayer`.
 */
export function withPqpSessionTag(
  playlist: string,
  sessionId: string | null | undefined,
): string {
  if (!sessionId) {
    return playlist;
  }
  const lines = playlist.split("\n");
  const insertAt = lines[0] === "#EXTM3U" ? 1 : 0;
  lines.splice(insertAt, 0, `#EXT-X-PQP-SESSION:${sessionId}`);
  return lines.join("\n");
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
export function buildMasterPlaylist(
  variants: readonly MasterVariant[],
  sessionId?: string | null,
): string {
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
  return withPqpSessionTag(`${lines.join("\n")}\n`, sessionId);
}
