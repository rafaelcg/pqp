/**
 * A wider live window than the egress writes, built from what the proxy has
 * already seen.
 *
 * WHY THIS EXISTS. LiveKit's egress keeps exactly five segments in the live
 * playlist (`defaultLivePlaylistWindow = 5` in `pkg/pipeline/sink/segments.go`,
 * not configurable through `SegmentedFileOutput`), which at 2 s segments is a
 * 10 s window. hls.js sits a few segments behind the edge and refreshes the
 * playlist every target duration, so with one segment of slack the window
 * routinely slides past the segment the player wants next: measured on a
 * clean link on 2026-09-12, the playlist skipped a segment the player had
 * not fetched yet eight times in two minutes, each one a hole in the buffer
 * that ends in a forced seek or a stall. Every "choppy, then stalls" report
 * on web has this underneath it.
 *
 * The segments themselves do not go anywhere: the bucket keeps a session's
 * objects until the retention sweep runs, which is after the session ENDS
 * (`hls-cleanup.ts`). So the proxy, which already re-renders the live
 * playlist once a second per rendition, can remember the segments it has
 * seen and serve the last N of them instead of the last five. A viewer then
 * has tens of seconds of listed media behind the playhead rather than two,
 * and a slow playlist poll, a throttled tab or a hiccup on the segment fetch
 * no longer drops the playhead out of the window.
 *
 * What this does NOT do: invent segments, reorder them, or touch anything
 * but `#EXT-X-MEDIA-SEQUENCE` and the list of entries. The header lines are
 * the egress's own, and each entry keeps every tag that preceded it in the
 * playlist it was first seen in (`#EXTINF`, `#EXT-X-PROGRAM-DATE-TIME`, and
 * any discontinuity or map tag the egress ever chooses to write).
 *
 * The history is per process. After a restart the window is the egress's
 * own five segments and grows back by one every 2 s, which the player
 * survives; nothing is fetched to seed it, because the alternative (the
 * `-index.m3u8` event playlist) is uploaded less and less often as a session
 * ages, and a stale seed is worse than a short one.
 */

/** Default number of segments the proxy lists; 15 × 2 s = 30 s. */
export const DEFAULT_LIVE_WINDOW_SEGMENTS = 15;

/** The egress's own window; below this the proxy adds nothing. */
export const EGRESS_LIVE_WINDOW_SEGMENTS = 5;

const MAX_LIVE_WINDOW_SEGMENTS = 120;

/**
 * `LIVE_HLS_WINDOW_SEGMENTS`, the operator's knob. `5` is the rollback to
 * exactly what the egress writes. Anything unparseable is the default.
 */
export function liveWindowSegments(): number {
  const raw = process.env.LIVE_HLS_WINDOW_SEGMENTS;
  if (!raw) {
    return DEFAULT_LIVE_WINDOW_SEGMENTS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_LIVE_WINDOW_SEGMENTS;
  }
  return Math.min(parsed, MAX_LIVE_WINDOW_SEGMENTS);
}

export interface ParsedSegment {
  /** Media sequence number, from `#EXT-X-MEDIA-SEQUENCE` plus position. */
  seq: number;
  /** The URI line, exactly as written (a bare filename for LiveKit). */
  uri: string;
  /** Every tag line between the previous URI and this one, in order. */
  tags: string[];
}

export interface ParsedMediaPlaylist {
  /** Header lines, minus `#EXT-X-MEDIA-SEQUENCE`, in order. */
  header: string[];
  mediaSequence: number;
  segments: ParsedSegment[];
  /** `#EXT-X-ENDLIST` was present. */
  ended: boolean;
}

const MEDIA_SEQUENCE_TAG = "#EXT-X-MEDIA-SEQUENCE:";
const ENDLIST_TAG = "#EXT-X-ENDLIST";

/**
 * Tags that describe the NEXT segment rather than the playlist. Everything
 * else that appears before the first of these is a header line.
 */
const SEGMENT_TAG_PREFIXES = [
  "#EXTINF:",
  "#EXT-X-PROGRAM-DATE-TIME:",
  "#EXT-X-BYTERANGE:",
  "#EXT-X-DISCONTINUITY",
  "#EXT-X-KEY:",
  "#EXT-X-MAP:",
  "#EXT-X-GAP",
  "#EXT-X-BITRATE:",
  "#EXT-X-DATERANGE:",
];

function isSegmentTag(line: string): boolean {
  return SEGMENT_TAG_PREFIXES.some((prefix) => line.startsWith(prefix));
}

/**
 * A media playlist, split into header, entries and the end marker. Tolerant
 * of blank lines and CRLF. A tag after the last URI that is not the end
 * marker is dropped: it describes a segment that is not there.
 */
export function parseMediaPlaylist(body: string): ParsedMediaPlaylist {
  const header: string[] = [];
  const segments: ParsedSegment[] = [];
  let mediaSequence = 0;
  let ended = false;
  let pending: string[] = [];
  let inSegments = false;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") {
      continue;
    }
    if (line === ENDLIST_TAG) {
      ended = true;
      continue;
    }
    if (line.startsWith("#")) {
      if (line.startsWith(MEDIA_SEQUENCE_TAG)) {
        const parsed = Number.parseInt(line.slice(MEDIA_SEQUENCE_TAG.length), 10);
        if (Number.isFinite(parsed)) {
          mediaSequence = parsed;
        }
        continue;
      }
      if (!inSegments && !isSegmentTag(line)) {
        header.push(line);
        continue;
      }
      inSegments = true;
      pending.push(line);
      continue;
    }
    inSegments = true;
    segments.push({
      seq: mediaSequence + segments.length,
      uri: line,
      tags: pending,
    });
    pending = [];
  }

  return { header, mediaSequence, segments, ended };
}

/**
 * One rendition's remembered segments. `merge` takes each fresh playlist the
 * proxy fetched; `render` writes the window a viewer is handed.
 */
export class LiveWindowHistory {
  private readonly segments = new Map<number, ParsedSegment>();
  private header: string[] = [];
  private ended = false;
  private newest = -1;

  /**
   * Fold a freshly fetched playlist in. A playlist whose newest entry is
   * OLDER than what this history already holds is a different stream under
   * the same name (an egress restarted its numbering); the history starts
   * over rather than splicing two timelines together.
   */
  merge(playlist: ParsedMediaPlaylist): void {
    this.header = playlist.header;
    this.ended = playlist.ended;
    const last = playlist.segments[playlist.segments.length - 1];
    if (last && last.seq < this.newest) {
      this.segments.clear();
      this.newest = -1;
    }
    for (const segment of playlist.segments) {
      if (!this.segments.has(segment.seq)) {
        this.segments.set(segment.seq, segment);
      }
      if (segment.seq > this.newest) {
        this.newest = segment.seq;
      }
    }
  }

  /**
   * The last `windowSegments` entries, as one contiguous run ending at the
   * newest segment seen. A gap in the run (a segment this process never saw
   * listed) ends the window there: a playlist must not skip a sequence
   * number, and a shorter honest window beats a longer lying one.
   */
  window(windowSegments: number): ParsedSegment[] {
    const out: ParsedSegment[] = [];
    for (let seq = this.newest; seq >= 0 && out.length < windowSegments; seq--) {
      const segment = this.segments.get(seq);
      if (!segment) {
        break;
      }
      out.push(segment);
    }
    return out.reverse();
  }

  /** Drop everything older than what any window could list. */
  prune(windowSegments: number): void {
    const floor = this.newest - Math.max(windowSegments, EGRESS_LIVE_WINDOW_SEGMENTS) * 2;
    for (const seq of this.segments.keys()) {
      if (seq < floor) {
        this.segments.delete(seq);
      }
    }
  }

  /**
   * A media playlist listing the window. Unsigned: the URI lines are the
   * egress's own, and the caller rewrites them exactly as it always did.
   */
  render(windowSegments: number): string {
    const entries = this.window(windowSegments);
    const lines = [...this.header];
    const first = entries[0];
    lines.push(`${MEDIA_SEQUENCE_TAG}${first ? first.seq : Math.max(this.newest, 0)}`);
    for (const segment of entries) {
      lines.push(...segment.tags, segment.uri);
    }
    if (this.ended) {
      lines.push(ENDLIST_TAG);
    }
    return lines.join("\n") + "\n";
  }

  /** How many segments are remembered, for tests and metrics. */
  get size(): number {
    return this.segments.size;
  }

  /** Newest sequence number seen, or -1. */
  get newestSequence(): number {
    return this.newest;
  }
}

/**
 * One call per fetched playlist: remember its entries and hand back the
 * widened playlist. The `EXT-X-MEDIA-SEQUENCE` of the result is the first
 * listed entry's, so a player's sequence bookkeeping is unchanged.
 */
export function widenLivePlaylist(
  history: LiveWindowHistory,
  body: string,
  windowSegments = liveWindowSegments(),
): string {
  history.merge(parseMediaPlaylist(body));
  history.prune(windowSegments);
  return history.render(windowSegments);
}
