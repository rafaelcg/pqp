/**
 * THE EGRESS RUNS BEHIND ONE LADDER RUNG OF ONE WATCH PARTY.
 *
 * A conventional watch party is one `startedAt` for its whole life: one
 * playlist URL, one viewer token, one master. Its transcode is not so stable.
 * A LiveKit egress dies (`Timestamping error on input streams`, 2026-09-24),
 * its playlist sticks, or the presenter republishes the screen on a new track
 * sid (a reconnect, a resume after a deploy, a quality pick), and a Track
 * Composite egress is bound to one sid. Until this module, every one of those
 * minted a NEW `startedAt`, and every viewer re-attached.
 *
 * Now the ladder restarts IN PLACE: the new egress writes under the same
 * session, under names of its own (`<startedAt>-<rung>-r<its start ms>_NNNNN.ts`,
 * `<startedAt>-<rung>-r<ms>.m3u8`, `<startedAt>-<rung>-r<ms>-index.m3u8`), so
 * nothing a previous run wrote is overwritten, and the rung's row records the
 * run (`hls_sessions.runs`). Every run still starts with the row's
 * `object_prefix`, which is what retention lists and deletes and what
 * `keep_replay` keeps.
 *
 * THE MEDIA SEQUENCE IS DURABLE, NEVER PER PROCESS. A fresh egress numbers its
 * segments from 0 again. The run's `base` is the media sequence its first
 * segment takes in the stitched playlist, decided ONCE, at restart time, from
 * what the previous run actually wrote (its final live playlist), and stored
 * on the row. Every process and both machines render from the row, so a viewer
 * bouncing between them through Cloudflare sees one monotonic
 * `#EXT-X-MEDIA-SEQUENCE` (an in-process rebase would not: hls.js goes fatal
 * on a sequence that runs backwards and Safari sticks, for the whole film).
 * The previous run is capped at `next.base - base` segments when rendered, so
 * a leftover egress that goes on writing after its stop cannot collide with
 * the run that replaced it.
 *
 * The camera already had runs (`cameraRunNames`), with the same `-r<ms>` name
 * shape; the film download stitches both the same way.
 */

export interface HlsRun {
  /** "" for a rung's first run (the legacy names), `-r<epoch ms>` after. */
  suffix: string;
  /** Media sequence of this run's first segment in the stitched playlist. */
  base: number;
}

/** What a row with `runs IS NULL` means: one run, the legacy names. */
export const LEGACY_RUNS: readonly HlsRun[] = Object.freeze([
  Object.freeze({ suffix: "", base: 0 }),
]);

const RUN_SUFFIX = /^-r\d{1,16}$/;

/** `-r<ms>`: the suffix a run started at `atMs` writes under. */
export function runSuffixAt(atMs: number): string {
  return `-r${Math.trunc(atMs)}`;
}

/** When a run started, read back from its suffix (the legacy run: null). */
export function runStartMs(run: HlsRun): number | null {
  if (!RUN_SUFFIX.test(run.suffix)) {
    return null;
  }
  return Number(run.suffix.slice(2));
}

/**
 * `hls_sessions.runs` as stored (JSONB: an array, a JSON string from a
 * driver that did not parse it, or NULL), validated. Anything malformed reads
 * as the legacy single run rather than throwing: a row this cannot read is
 * served exactly as it was before runs existed.
 *
 * Kept only when strictly increasing in `base` and well formed; the first
 * entry is kept whatever its suffix (a rung that joined the ladder after a
 * restart has no legacy run, its first run is already suffixed).
 */
export function parseHlsRuns(raw: unknown): HlsRun[] {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return [...LEGACY_RUNS];
    }
  }
  if (!Array.isArray(value) || value.length === 0) {
    return [...LEGACY_RUNS];
  }
  const runs: HlsRun[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      return [...LEGACY_RUNS];
    }
    const suffix = (entry as { suffix?: unknown }).suffix;
    const base = (entry as { base?: unknown }).base;
    if (
      typeof suffix !== "string" ||
      (suffix !== "" && !RUN_SUFFIX.test(suffix)) ||
      typeof base !== "number" ||
      !Number.isSafeInteger(base) ||
      base < 0
    ) {
      return [...LEGACY_RUNS];
    }
    const previous = runs[runs.length - 1];
    if (previous && (base <= previous.base || suffix === previous.suffix)) {
      return [...LEGACY_RUNS];
    }
    runs.push({ suffix, base });
  }
  return runs;
}

/** The JSON to store, or null for the legacy single run (keeps old rows byte-identical). */
export function serializeHlsRuns(runs: readonly HlsRun[]): string | null {
  if (
    runs.length === 0 ||
    (runs.length === 1 && runs[0]!.suffix === "" && runs[0]!.base === 0)
  ) {
    return null;
  }
  return JSON.stringify(runs.map((run) => ({ suffix: run.suffix, base: run.base })));
}

/** The run a rung is writing now. */
export function currentRun(runs: readonly HlsRun[]): HlsRun {
  return runs[runs.length - 1] ?? LEGACY_RUNS[0]!;
}

/**
 * How many segments a run's live playlist says the run has written: the
 * sequence number its NEXT segment would take. LiveKit numbers from 0 and
 * keeps the last five entries, so `#EXT-X-MEDIA-SEQUENCE` plus the entry
 * count is exactly that. Null when the body lists nothing to count from.
 */
export function segmentsWritten(body: string): number | null {
  let sequence: number | null = null;
  let entries = 0;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      const parsed = Number.parseInt(line.slice("#EXT-X-MEDIA-SEQUENCE:".length), 10);
      if (Number.isFinite(parsed) && parsed >= 0) {
        sequence = parsed;
      }
    } else if (line !== "" && !line.startsWith("#")) {
      entries += 1;
    }
  }
  if (entries === 0) {
    return sequence === null ? null : sequence;
  }
  return (sequence ?? 0) + entries;
}

/**
 * The run that follows `runs`, started at `atMs`, whose predecessor wrote
 * `written` segments (or null when that could not be read).
 *
 * An unread count is ESTIMATED HIGH on purpose: one sequence number per
 * elapsed second of the previous run, which no real segment length reaches
 * (production cuts 4 s segments). Too high costs a jump forward in the
 * sequence, which every player rides; too low would collide with segments the
 * previous run really wrote, which the render's cap then hides but which
 * would leave the two runs overlapping on the sequence line.
 */
export function nextRun(
  runs: readonly HlsRun[],
  atMs: number,
  written: number | null,
  sessionStartedAt: number,
): HlsRun[] {
  const last = currentRun(runs);
  let count = written;
  if (count === null || count < 0) {
    const since = runStartMs(last) ?? sessionStartedAt;
    count = Math.max(1, Math.ceil((atMs - since) / 1_000) + 1);
  }
  let suffix = runSuffixAt(atMs);
  // Two restarts inside one millisecond would share a name. Never.
  while (runs.some((run) => run.suffix === suffix)) {
    atMs += 1;
    suffix = runSuffixAt(atMs);
  }
  return [...runs, { suffix, base: last.base + Math.max(count, 1) }];
}

/** `<rung><suffix>`: the "rung" part of every name one run writes. */
export function runRungName(rung: string, run: HlsRun | string): string {
  return `${rung}${typeof run === "string" ? run : run.suffix}`;
}

// Tags a stitched playlist decides for itself, never copied from an input:
// every run numbers from 0 and each egress closes (or not) its own playlist.
const DROPPED_TAGS = [
  "#EXT-X-MEDIA-SEQUENCE:",
  "#EXT-X-DISCONTINUITY-SEQUENCE:",
  "#EXT-X-ENDLIST",
];
const TARGET_DURATION_TAG = "#EXT-X-TARGETDURATION:";
const PLAYLIST_TYPE_TAG = "#EXT-X-PLAYLIST-TYPE:";
const DISCONTINUITY_TAG = "#EXT-X-DISCONTINUITY";

/** Tags that belong to the segment after them rather than the playlist. */
const SEGMENT_TAGS = [
  "#EXTINF:",
  "#EXT-X-PROGRAM-DATE-TIME:",
  "#EXT-X-BYTERANGE:",
  "#EXT-X-KEY:",
  "#EXT-X-MAP:",
  "#EXT-X-GAP",
  "#EXT-X-BITRATE:",
  "#EXT-X-DATERANGE:",
];

function isSegmentTag(line: string): boolean {
  return (
    line === DISCONTINUITY_TAG ||
    SEGMENT_TAGS.some((prefix) => line.startsWith(prefix))
  );
}

interface RunPlaylist {
  header: string[];
  targetDuration: number | null;
  /** Each entry: its own tags in order, then its URI line. */
  segments: string[][];
}

// Its own small parser rather than `parseMediaPlaylist` (hls-live-window.ts):
// that one reads `#EXT-X-DISCONTINUITY-SEQUENCE` as a segment tag, which here
// would ride into the middle of the stitched body.
function parseRunPlaylist(body: string): RunPlaylist {
  const header: string[] = [];
  const segments: string[][] = [];
  let targetDuration: number | null = null;
  let pending: string[] = [];
  let inSegments = false;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || DROPPED_TAGS.some((tag) => line.startsWith(tag))) {
      continue;
    }
    if (line.startsWith(TARGET_DURATION_TAG)) {
      const parsed = Number.parseInt(line.slice(TARGET_DURATION_TAG.length), 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        targetDuration = Math.max(targetDuration ?? 0, parsed);
      }
    }
    if (line.startsWith("#")) {
      if (!inSegments && !isSegmentTag(line)) {
        header.push(line);
      } else {
        inSegments = true;
        pending.push(line);
      }
      continue;
    }
    inSegments = true;
    segments.push([...pending, line]);
    pending = [];
  }
  // Tags after the last URI describe a segment that is not there.
  return { header, targetDuration, segments };
}

/**
 * Every run's accumulated `-index.m3u8`, in start order, as ONE finished
 * playlist: the replay of a rung whose egress restarted in place.
 *
 * The first listed run's header (its `#EXT-X-TARGETDURATION` raised to the
 * largest of them all, its playlist type made `VOD`), `#EXT-X-MEDIA-SEQUENCE:0`,
 * every run's entries with all their own tags, one `#EXT-X-DISCONTINUITY`
 * where each later run begins (each egress starts its timestamps over, which
 * is exactly what the tag tells a player), and one `#EXT-X-ENDLIST`.
 *
 * `caps[i]`, when a number, keeps at most that many of body i's entries: the
 * same cap the live render applies (`next.base - base`), so a leftover egress
 * that went on writing after its stop is not replayed on top of the run that
 * replaced it. A body that lists nothing is skipped; null when none lists
 * anything.
 */
export function stitchRunPlaylists(
  bodies: readonly string[],
  caps: readonly (number | null | undefined)[] = [],
): string | null {
  const runs = bodies
    .map((body, index) => {
      const parsed = parseRunPlaylist(body);
      const cap = caps[index];
      if (typeof cap === "number" && cap >= 0) {
        parsed.segments = parsed.segments.slice(0, cap);
      }
      return parsed;
    })
    .filter((run) => run.segments.length > 0);
  if (runs.length === 0) {
    return null;
  }
  let targetDuration: number | null = null;
  for (const run of runs) {
    if (run.targetDuration !== null) {
      targetDuration = Math.max(targetDuration ?? 0, run.targetDuration);
    }
  }
  const out: string[] = [];
  let wroteTargetDuration = false;
  let wroteType = false;
  for (const line of runs[0]!.header) {
    if (line.startsWith(TARGET_DURATION_TAG)) {
      if (!wroteTargetDuration && targetDuration !== null) {
        out.push(`${TARGET_DURATION_TAG}${targetDuration}`);
        wroteTargetDuration = true;
      }
      continue;
    }
    if (line.startsWith(PLAYLIST_TYPE_TAG)) {
      if (!wroteType) {
        out.push(`${PLAYLIST_TYPE_TAG}VOD`);
        wroteType = true;
      }
      continue;
    }
    out.push(line);
  }
  if (out[0] !== "#EXTM3U") {
    out.unshift("#EXTM3U");
  }
  if (!wroteTargetDuration && targetDuration !== null) {
    out.push(`${TARGET_DURATION_TAG}${targetDuration}`);
  }
  if (!wroteType) {
    out.push(`${PLAYLIST_TYPE_TAG}VOD`);
  }
  out.push("#EXT-X-MEDIA-SEQUENCE:0");
  for (const [index, run] of runs.entries()) {
    for (const [position, entry] of run.segments.entries()) {
      if (
        index > 0 &&
        position === 0 &&
        !entry.includes(DISCONTINUITY_TAG)
      ) {
        out.push(DISCONTINUITY_TAG);
      }
      out.push(...entry);
    }
  }
  out.push("#EXT-X-ENDLIST");
  return `${out.join("\n")}\n`;
}
