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
 *
 * BROADCAST_PIPELINE B0.2 (probed against a real session copied onto
 * `hls-live-window.test.ts`'s `egressPlaylist` fixture, staging bucket,
 * 2026-09-12): the egress DOES write `#EXT-X-PROGRAM-DATE-TIME`, one per
 * entry, so a viewer's own clock is enough to compute wall-clock latency with
 * no server work at all. `render` below still synthesises one from
 * `firstSeenAt` for any segment that somehow arrives without one, so a future
 * LiveKit build or a self-host's own encoder that omits it degrades to a
 * slightly later (never earlier) timestamp instead of leaving the client with
 * nothing to compute from.
 */

/**
 * Default number of segments the proxy lists. This constant does not know
 * the segment length: at the code's own local default (`LIVE_HLS_SEGMENT_SECONDS`
 * unset, 2 s) that is 30 s, but production has run 4 s segments since #495
 * (`LIVE_HLS_SEGMENT_SECONDS=4`, see `docs/WATCH_PARTY.md`), so the window a
 * production viewer actually gets is 60 s. This comment used to just say
 * "15 x 2 s = 30 s" as if that were universally true, which is the exact
 * "stale the moment production changed and nothing here said so" pattern
 * `docs/plans/BROADCAST_PIPELINE.md` B0.1 exists to stop.
 */
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
  // `#EXT-X-DISCONTINUITY-SEQUENCE` shares a prefix with the per-segment
  // `#EXT-X-DISCONTINUITY` and is a playlist header, not a segment tag.
  if (line.startsWith("#EXT-X-DISCONTINUITY-SEQUENCE:")) {
    return false;
  }
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

const PROGRAM_DATE_TIME_PREFIX = "#EXT-X-PROGRAM-DATE-TIME:";
const DISCONTINUITY_TAG = "#EXT-X-DISCONTINUITY";
const DISCONTINUITY_SEQUENCE_TAG = "#EXT-X-DISCONTINUITY-SEQUENCE:";

/**
 * Where one fetched playlist sits in a rung's run history (`hls-runs.ts`).
 * The default is the only shape there was before runs: the one and only run,
 * numbered as the egress numbered it.
 */
export interface MergeRun {
  /** Added to every sequence number in the playlist. */
  base?: number;
  /** The run's position, 0 for the first. */
  index?: number;
  /** Segments at or past this LOCAL sequence number are ignored (a finished run's cap). */
  limit?: number;
  /** Whether this is the run being written now (its header and end marker count). */
  current?: boolean;
}

const CURRENT_LEGACY_RUN: MergeRun = { base: 0, index: 0, current: true };

/** One remembered segment, plus the wall clock this process first saw it. */
interface HistoryEntry {
  segment: ParsedSegment;
  /**
   * Which egress run of the rung this segment came from (`hls-runs.ts`), 0
   * for the first. Its discontinuity sequence number: a player decodes each
   * run as its own timeline.
   */
  run: number;
  /** The first segment of a run after the first: it carries the discontinuity. */
  firstOfRun: boolean;
  /**
   * `Date.now()` (or the caller's clock) the instant this segment was first
   * merged in -- BROADCAST_PIPELINE B0.3's T5-T6 stamp: "in the bucket, to
   * listed in the playlist a viewer polls". Never touched again once set, so
   * every later render of this same segment reports the same age.
   */
  firstSeenAt: number;
}

/**
 * One rendition's remembered segments. `merge` takes each fresh playlist the
 * proxy fetched; `render` writes the window a viewer is handed.
 */
export class LiveWindowHistory {
  private readonly segments = new Map<number, HistoryEntry>();
  private header: string[] = [];
  private ended = false;
  private newest = -1;
  /** The run the newest segment belongs to. */
  private newestRun = 0;

  /**
   * Fold a freshly fetched playlist in. A playlist whose newest entry is
   * OLDER than what this history already holds is a different stream under
   * the same name (an egress restarted its numbering); the history starts
   * over rather than splicing two timelines together.
   *
   * `now` is stamped onto any segment seen for the first time. Callers
   * should pass the same clock they use everywhere else in one request so a
   * test (and `X-Pqp-Playlist-Age-Ms`) can reason about it.
   */
  merge(
    playlist: ParsedMediaPlaylist,
    now = Date.now(),
    run: MergeRun = CURRENT_LEGACY_RUN,
  ): void {
    const base = run.base ?? 0;
    const index = run.index ?? 0;
    const current = run.current ?? true;
    // Only the run being written NOW describes the playlist: its header is
    // the one a viewer should see, and only it can say the stream ended. A
    // finished run's final playlist is read for its tail and nothing else.
    if (current || this.header.length === 0) {
      this.header = playlist.header.filter(
        (line) => !line.startsWith(DISCONTINUITY_SEQUENCE_TAG),
      );
    }
    if (current) {
      this.ended = playlist.ended;
    }
    const segments =
      run.limit === undefined
        ? playlist.segments
        : playlist.segments.filter((segment) => segment.seq < run.limit!);
    const last = segments[segments.length - 1];
    // Same numbering restarting under the same name is a different stream
    // (the camera's shared live playlist does that). A LATER RUN of a rung is
    // not: it was rebased onto its own `base` before it got here, so its
    // numbers never run backwards and nothing is thrown away.
    if (current && last && base + last.seq < this.newest && index === this.newestRun) {
      this.segments.clear();
      this.newest = -1;
    }
    for (const segment of segments) {
      const seq = base + segment.seq;
      if (!this.segments.has(seq)) {
        this.segments.set(seq, {
          segment: base === 0 ? segment : { ...segment, seq },
          firstSeenAt: now,
          run: index,
          firstOfRun: index > 0 && segment.seq === 0,
        });
      }
      if (seq > this.newest) {
        this.newest = seq;
        this.newestRun = index;
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
    return this.windowEntries(windowSegments).map((entry) => entry.segment);
  }

  private windowEntries(windowSegments: number): HistoryEntry[] {
    const out: HistoryEntry[] = [];
    for (let seq = this.newest; seq >= 0 && out.length < windowSegments; seq--) {
      const entry = this.segments.get(seq);
      if (!entry) {
        break;
      }
      out.push(entry);
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
   *
   * BROADCAST_PIPELINE B0.2: if the egress already writes
   * `#EXT-X-PROGRAM-DATE-TIME`, it is copied through untouched (it was
   * already preserved as a segment tag before this). If a segment's tags
   * carry none -- probed against a real production playlist and not
   * currently true, but a future LiveKit build or a self-host's own encoder
   * might not write one -- this synthesises one from `firstSeenAt`, the wall
   * clock this process first saw the segment listed. That is a later instant
   * than the segment's real encode time (T4), so a latency computed from a
   * synthesised PDT is a slight OVER-estimate of encode-to-paint, never an
   * under-estimate: the honest direction for a number nobody is meant to
   * treat as more precise than it is.
   */
  render(windowSegments: number): string {
    const entries = this.windowEntries(windowSegments);
    const lines = [...this.header];
    const first = entries[0];
    lines.push(
      `${MEDIA_SEQUENCE_TAG}${first ? first.segment.seq : Math.max(this.newest, 0)}`,
    );
    // RUNS: one discontinuity per egress restart, and the count of those that
    // already slid out of the window. Omitted while every listed segment is
    // from the first run, so a rung that never restarted renders exactly as
    // it always did.
    if (first && entries.some((entry) => entry.run > 0)) {
      lines.push(
        `${DISCONTINUITY_SEQUENCE_TAG}${first.run - (first.firstOfRun ? 1 : 0)}`,
      );
    }
    for (const entry of entries) {
      let tags = entry.segment.tags.some((tag) =>
        tag.startsWith(PROGRAM_DATE_TIME_PREFIX),
      )
        ? entry.segment.tags
        : [
            `${PROGRAM_DATE_TIME_PREFIX}${new Date(entry.firstSeenAt).toISOString()}`,
            ...entry.segment.tags,
          ];
      if (entry.firstOfRun && !tags.includes(DISCONTINUITY_TAG)) {
        tags = [DISCONTINUITY_TAG, ...tags];
      }
      lines.push(...tags, entry.segment.uri);
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

  /**
   * When the newest segment currently listed was first seen by this process,
   * or null when the history is empty. `X-Pqp-Playlist-Age-Ms` is `now` minus
   * this: how stale the freshest thing this proxy can offer already is.
   */
  get newestFirstSeenAt(): number | null {
    const entry = this.segments.get(this.newest);
    return entry ? entry.firstSeenAt : null;
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
  now = Date.now(),
): string {
  history.merge(parseMediaPlaylist(body), now);
  history.prune(windowSegments);
  return history.render(windowSegments);
}
