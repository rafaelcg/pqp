import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_LIVE_WINDOW_SEGMENTS,
  LiveWindowHistory,
  liveWindowSegments,
  parseMediaPlaylist,
  widenLivePlaylist,
} from "./hls-live-window.js";

/**
 * What LiveKit egress v1.14.1 writes to the LIVE playlist: a fixed window of
 * five entries, `#EXT-X-VERSION:4`, one `#EXT-X-PROGRAM-DATE-TIME` per entry.
 * Copied from a real session on the staging bucket, 2026-09-12.
 */
function egressPlaylist(first: number, count = 5, ended = false): string {
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:4",
    "#EXT-X-ALLOW-CACHE:NO",
    "#EXT-X-TARGETDURATION:2",
    `#EXT-X-MEDIA-SEQUENCE:${first}`,
  ];
  for (let i = 0; i < count; i++) {
    const seq = first + i;
    lines.push(
      `#EXT-X-PROGRAM-DATE-TIME:2026-09-12T10:10:${String(39 + seq).padStart(2, "0")}.718Z`,
      "#EXTINF:2.000,",
      `1789207838217-720p30_${String(seq).padStart(5, "0")}.ts`,
    );
  }
  if (ended) {
    lines.push("#EXT-X-ENDLIST");
  }
  return lines.join("\n") + "\n";
}

function sequenceOf(body: string): number {
  return Number(body.match(/^#EXT-X-MEDIA-SEQUENCE:(\d+)$/m)![1]);
}

function urisOf(body: string): string[] {
  return body.split("\n").filter((l) => l !== "" && !l.startsWith("#"));
}

describe("parseMediaPlaylist", () => {
  it("splits header, per-segment tags and URIs, numbering from MEDIA-SEQUENCE", () => {
    const parsed = parseMediaPlaylist(egressPlaylist(1623));
    expect(parsed.header).toEqual([
      "#EXTM3U",
      "#EXT-X-VERSION:4",
      "#EXT-X-ALLOW-CACHE:NO",
      "#EXT-X-TARGETDURATION:2",
    ]);
    expect(parsed.mediaSequence).toBe(1623);
    expect(parsed.segments.map((s) => s.seq)).toEqual([1623, 1624, 1625, 1626, 1627]);
    expect(parsed.segments[0]!.uri).toBe("1789207838217-720p30_01623.ts");
    expect(parsed.segments[0]!.tags).toEqual([
      "#EXT-X-PROGRAM-DATE-TIME:2026-09-12T10:10:1662.718Z",
      "#EXTINF:2.000,",
    ]);
    expect(parsed.ended).toBe(false);
  });

  it("keeps a discontinuity or map tag with the segment that follows it", () => {
    const parsed = parseMediaPlaylist(
      [
        "#EXTM3U",
        "#EXT-X-TARGETDURATION:2",
        "#EXT-X-MEDIA-SEQUENCE:7",
        "#EXTINF:2.0,",
        "a_00007.ts",
        "#EXT-X-DISCONTINUITY",
        "#EXT-X-MAP:URI=\"init.mp4\"",
        "#EXTINF:2.0,",
        "a_00008.ts",
        "#EXT-X-ENDLIST",
      ].join("\r\n"),
    );
    expect(parsed.segments[1]!.tags).toEqual([
      "#EXT-X-DISCONTINUITY",
      "#EXT-X-MAP:URI=\"init.mp4\"",
      "#EXTINF:2.0,",
    ]);
    expect(parsed.ended).toBe(true);
  });

  it("an empty or headerless body is an empty playlist, not a throw", () => {
    expect(parseMediaPlaylist("").segments).toEqual([]);
    expect(parseMediaPlaylist("#EXTM3U\n").segments).toEqual([]);
  });
});

describe("LiveWindowHistory", () => {
  it("first sight of a playlist is the playlist itself", () => {
    const history = new LiveWindowHistory();
    const body = widenLivePlaylist(history, egressPlaylist(0), 15);
    expect(sequenceOf(body)).toBe(0);
    expect(urisOf(body)).toHaveLength(5);
    expect(body).toContain("#EXT-X-VERSION:4");
    expect(body).toContain("#EXT-X-TARGETDURATION:2");
  });

  it("grows the window one segment per fetched playlist, up to the configured size", () => {
    const history = new LiveWindowHistory();
    let body = "";
    // The proxy refetches every second and the egress adds one entry every
    // two, so the same playlist is often seen twice and sometimes a fetch
    // sees two new entries at once. Both shapes are folded in below.
    const firsts = [0, 0, 1, 2, 2, 4, 5, 5, 6, 8, 9, 10, 11, 11, 12, 14, 15];
    for (const first of firsts) {
      body = widenLivePlaylist(history, egressPlaylist(first), 15);
    }
    const uris = urisOf(body);
    expect(uris).toHaveLength(15);
    expect(sequenceOf(body)).toBe(5);
    expect(uris[0]).toBe("1789207838217-720p30_00005.ts");
    expect(uris[14]).toBe("1789207838217-720p30_00019.ts");
  });

  it("MEDIA-SEQUENCE is the first LISTED entry, so hls.js bookkeeping is unchanged", () => {
    const history = new LiveWindowHistory();
    widenLivePlaylist(history, egressPlaylist(100), 8);
    const body = widenLivePlaylist(history, egressPlaylist(103), 8);
    // Seen 100..107, window 8: all of them.
    expect(sequenceOf(body)).toBe(100);
    expect(urisOf(body)).toHaveLength(8);
    const tags = body.split("\n");
    const firstUriAt = tags.indexOf("1789207838217-720p30_00100.ts");
    expect(tags[firstUriAt - 1]).toBe("#EXTINF:2.000,");
    expect(tags[firstUriAt - 2]).toMatch(/^#EXT-X-PROGRAM-DATE-TIME:/);
  });

  it("never lists across a gap: a segment this process never saw ends the window", () => {
    const history = new LiveWindowHistory();
    widenLivePlaylist(history, egressPlaylist(0), 15);
    // The process was busy for twelve seconds (or restarted the tab it
    // serves): the next playlist it sees starts past what it holds.
    const body = widenLivePlaylist(history, egressPlaylist(9), 15);
    expect(sequenceOf(body)).toBe(9);
    expect(urisOf(body)).toHaveLength(5);
  });

  it("a playlist that restarted its numbering starts the history over", () => {
    const history = new LiveWindowHistory();
    widenLivePlaylist(history, egressPlaylist(500), 15);
    const body = widenLivePlaylist(history, egressPlaylist(0), 15);
    expect(sequenceOf(body)).toBe(0);
    expect(urisOf(body)).toHaveLength(5);
    expect(history.newestSequence).toBe(4);
  });

  it("a window of five is exactly what the egress wrote (the rollback)", () => {
    const history = new LiveWindowHistory();
    for (const first of [0, 1, 2, 3, 4, 5]) {
      widenLivePlaylist(history, egressPlaylist(first), 5);
    }
    const body = widenLivePlaylist(history, egressPlaylist(6), 5);
    expect(sequenceOf(body)).toBe(6);
    expect(urisOf(body)).toHaveLength(5);
  });

  it("keeps ENDLIST when the session is over, and forgets nothing before it", () => {
    const history = new LiveWindowHistory();
    for (const first of [0, 1, 2, 3]) {
      widenLivePlaylist(history, egressPlaylist(first), 15);
    }
    const body = widenLivePlaylist(history, egressPlaylist(4, 5, true), 15);
    expect(body.trimEnd().endsWith("#EXT-X-ENDLIST")).toBe(true);
    expect(urisOf(body)).toHaveLength(9);
  });

  it("prunes what no window could list, so a long party does not grow the map", () => {
    const history = new LiveWindowHistory();
    for (let first = 0; first < 400; first++) {
      widenLivePlaylist(history, egressPlaylist(first), 15);
    }
    expect(history.size).toBeLessThanOrEqual(15 * 2 + 5);
    expect(history.newestSequence).toBe(403);
  });
});

describe("liveWindowSegments", () => {
  afterEach(() => {
    delete process.env.LIVE_HLS_WINDOW_SEGMENTS;
  });

  it("defaults to 15 segments, which is 30 s at the egress's 2 s", () => {
    expect(liveWindowSegments()).toBe(DEFAULT_LIVE_WINDOW_SEGMENTS);
    expect(DEFAULT_LIVE_WINDOW_SEGMENTS).toBe(15);
  });

  it("reads the operator's number, refuses nonsense, caps the absurd", () => {
    process.env.LIVE_HLS_WINDOW_SEGMENTS = "5";
    expect(liveWindowSegments()).toBe(5);
    process.env.LIVE_HLS_WINDOW_SEGMENTS = "0";
    expect(liveWindowSegments()).toBe(15);
    process.env.LIVE_HLS_WINDOW_SEGMENTS = "banana";
    expect(liveWindowSegments()).toBe(15);
    process.env.LIVE_HLS_WINDOW_SEGMENTS = "100000";
    expect(liveWindowSegments()).toBe(120);
  });
});
