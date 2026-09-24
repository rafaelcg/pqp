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

/**
 * BROADCAST_PIPELINE B0.2/B0.3. The egress DOES write
 * `#EXT-X-PROGRAM-DATE-TIME` (see the fixture's own doc comment above,
 * copied from a real session), so `render` should leave it untouched. These
 * pin the defensive path for the day it is not there, and the `firstSeenAt`
 * stamp the age header and the synthesis both read from.
 */
describe("LiveWindowHistory PDT synthesis and firstSeenAt", () => {
  it("leaves an existing #EXT-X-PROGRAM-DATE-TIME exactly as the egress wrote it", () => {
    const history = new LiveWindowHistory();
    const body = widenLivePlaylist(history, egressPlaylist(0), 15, 1_000);
    expect(body).toContain(
      "#EXT-X-PROGRAM-DATE-TIME:2026-09-12T10:10:39.718Z",
    );
    // Not the synthesised form, which would be an ISO string derived from
    // the fake `now` of 1000 ms since epoch.
    expect(body).not.toContain(new Date(1_000).toISOString());
  });

  it("synthesises a PDT from firstSeenAt when a segment's tags carry none", () => {
    const history = new LiveWindowHistory();
    const noPdt = [
      "#EXTM3U",
      "#EXT-X-TARGETDURATION:2",
      "#EXT-X-MEDIA-SEQUENCE:0",
      "#EXTINF:2.000,",
      "a_00000.ts",
    ].join("\n");
    const now = 1_726_000_000_000;
    const body = widenLivePlaylist(history, noPdt, 15, now);
    const lines = body.split("\n");
    const uriAt = lines.indexOf("a_00000.ts");
    expect(lines[uriAt - 1]).toBe("#EXTINF:2.000,");
    expect(lines[uriAt - 2]).toBe(
      `#EXT-X-PROGRAM-DATE-TIME:${new Date(now).toISOString()}`,
    );
  });

  it("a synthesised PDT never moves once set, even if the segment is re-seen later", () => {
    const history = new LiveWindowHistory();
    const noPdt = [
      "#EXTM3U",
      "#EXT-X-MEDIA-SEQUENCE:0",
      "#EXTINF:2.0,",
      "a_00000.ts",
    ].join("\n");
    const firstSeen = 1_000;
    widenLivePlaylist(history, noPdt, 15, firstSeen);
    const second = widenLivePlaylist(history, noPdt, 15, firstSeen + 5_000);
    expect(second).toContain(
      `#EXT-X-PROGRAM-DATE-TIME:${new Date(firstSeen).toISOString()}`,
    );
    expect(second).not.toContain(new Date(firstSeen + 5_000).toISOString());
  });

  it("newestFirstSeenAt is null on an empty history and tracks the newest segment otherwise", () => {
    const history = new LiveWindowHistory();
    expect(history.newestFirstSeenAt).toBeNull();
    widenLivePlaylist(history, egressPlaylist(0), 15, 10_000);
    expect(history.newestFirstSeenAt).toBe(10_000);
    // A later fetch that only re-lists the same entries does not bump it:
    // firstSeenAt is stamped once, not refreshed on every poll.
    widenLivePlaylist(history, egressPlaylist(0), 15, 20_000);
    expect(history.newestFirstSeenAt).toBe(10_000);
    // A genuinely new segment arriving bumps it to when THAT one first showed.
    widenLivePlaylist(history, egressPlaylist(1), 15, 30_000);
    expect(history.newestFirstSeenAt).toBe(30_000);
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

/**
 * A LADDER RUNG THAT RESTARTED IN PLACE (`hls-runs.ts`). Each egress run
 * numbers from 0 under its own names; the history rebases a run onto its
 * durable `base`, caps a finished run where the next begins, and marks the
 * boundary with one discontinuity.
 */
describe("LiveWindowHistory across egress runs", () => {
  function runPlaylist(suffix: string, first: number, count = 5, ended = false): string {
    return egressPlaylist(first, count, ended).replaceAll(
      "1789207838217-720p30_",
      `1789207838217-720p30${suffix}_`,
    );
  }

  it("continues the sequence into the next run with one discontinuity", () => {
    const history = new LiveWindowHistory();
    // Run 0 wrote 0..11 and was stopped (its egress closed the playlist).
    history.merge(parseMediaPlaylist(runPlaylist("", 7, 5, true)), 0, {
      base: 0,
      index: 0,
      limit: 12,
      current: false,
    });
    // Run 1 (base 12) has written its first three segments.
    history.merge(parseMediaPlaylist(runPlaylist("-r1790235781814", 0, 3)), 0, {
      base: 12,
      index: 1,
      current: true,
    });
    const body = history.render(15);
    expect(sequenceOf(body)).toBe(7);
    expect(body).toContain("#EXT-X-DISCONTINUITY-SEQUENCE:0");
    expect(body).not.toContain("#EXT-X-ENDLIST");
    const lines = body.split("\n");
    const firstNew = lines.indexOf("1789207838217-720p30-r1790235781814_00000.ts");
    // The discontinuity belongs to the first segment of the new run, and to
    // nothing else.
    expect(lines.slice(0, firstNew).filter((l) => l === "#EXT-X-DISCONTINUITY")).toHaveLength(1);
    expect(lines.filter((l) => l === "#EXT-X-DISCONTINUITY")).toHaveLength(1);
    expect(urisOf(body)).toEqual([
      "1789207838217-720p30_00007.ts",
      "1789207838217-720p30_00008.ts",
      "1789207838217-720p30_00009.ts",
      "1789207838217-720p30_00010.ts",
      "1789207838217-720p30_00011.ts",
      "1789207838217-720p30-r1790235781814_00000.ts",
      "1789207838217-720p30-r1790235781814_00001.ts",
      "1789207838217-720p30-r1790235781814_00002.ts",
    ]);
  });

  it("counts the discontinuity once it slides out of the window", () => {
    const history = new LiveWindowHistory();
    history.merge(parseMediaPlaylist(runPlaylist("", 7)), 0, {
      base: 0,
      index: 0,
      limit: 12,
      current: false,
    });
    for (let first = 0; first <= 10; first += 1) {
      history.merge(parseMediaPlaylist(runPlaylist("-r1", first)), 0, {
        base: 12,
        index: 1,
        current: true,
      });
    }
    const body = history.render(5);
    // Only run 1 is listed: sequence continues from its base, and the one
    // discontinuity that already went by is counted in the header.
    expect(sequenceOf(body)).toBe(12 + 10);
    expect(body).toContain("#EXT-X-DISCONTINUITY-SEQUENCE:1");
    expect(body).not.toContain("#EXT-X-DISCONTINUITY\n");
  });

  it("never lists what a leftover egress wrote past the next run's base", () => {
    const history = new LiveWindowHistory();
    // Run 0's egress was asked to stop at 12 segments and wrote two more.
    history.merge(parseMediaPlaylist(runPlaylist("", 9, 5)), 0, {
      base: 0,
      index: 0,
      limit: 12,
      current: false,
    });
    history.merge(parseMediaPlaylist(runPlaylist("-r1", 0, 2)), 0, {
      base: 12,
      index: 1,
      current: true,
    });
    const uris = urisOf(history.render(15));
    expect(uris).not.toContain("1789207838217-720p30_00012.ts");
    expect(uris).not.toContain("1789207838217-720p30_00013.ts");
    expect(uris.at(-2)).toBe("1789207838217-720p30-r1_00000.ts");
  });

  it("renders the same bytes on a process that only ever saw the final playlists", () => {
    // Machine A watched the whole thing; machine B booted after the restart
    // and reads run 0's frozen final playlist from the bucket. A viewer
    // bouncing between them must see one sequence line.
    const a = new LiveWindowHistory();
    for (let first = 0; first <= 7; first += 1) {
      a.merge(parseMediaPlaylist(runPlaylist("", first)), 0, { base: 0, index: 0, current: true });
    }
    const final0 = runPlaylist("", 7, 5, true);
    const run1 = runPlaylist("-r1", 0, 4);
    a.merge(parseMediaPlaylist(final0), 0, { base: 0, index: 0, limit: 12, current: false });
    a.merge(parseMediaPlaylist(run1), 0, { base: 12, index: 1, current: true });

    const b = new LiveWindowHistory();
    b.merge(parseMediaPlaylist(final0), 0, { base: 0, index: 0, limit: 12, current: false });
    b.merge(parseMediaPlaylist(run1), 0, { base: 12, index: 1, current: true });

    // A's window is wider (it remembers older segments); the overlap and the
    // sequence numbers agree exactly.
    expect(a.render(9)).toBe(b.render(9));
    expect(sequenceOf(b.render(9))).toBe(7);
  });

  it("marks the boundary even for a process that first saw the new run past its segment 0", () => {
    const history = new LiveWindowHistory();
    // Run 1's local 0 was never listed here; its local 1 onwards were. With
    // run 0's tail rebased so the two touch, the boundary is still tagged.
    history.merge(parseMediaPlaylist(runPlaylist("", 7, 5)), 0, {
      base: 0,
      index: 0,
      limit: 12,
      current: false,
    });
    history.merge(parseMediaPlaylist(runPlaylist("-r1", 1, 3)), 0, {
      base: 11,
      index: 1,
      current: true,
    });
    const lines = history.render(15).split("\n");
    const boundary = lines.indexOf("1789207838217-720p30-r1_00001.ts");
    expect(lines.slice(boundary - 4, boundary)).toContain("#EXT-X-DISCONTINUITY");
    expect(lines.filter((l) => l === "#EXT-X-DISCONTINUITY")).toHaveLength(1);
  });

  it("leaves a rung that never restarted byte-for-byte as it was", () => {
    const legacy = new LiveWindowHistory();
    const runs = new LiveWindowHistory();
    for (let first = 0; first <= 4; first += 1) {
      widenLivePlaylist(legacy, egressPlaylist(first), 15, 0);
      runs.merge(parseMediaPlaylist(egressPlaylist(first)), 0, { base: 0, index: 0, current: true });
    }
    expect(runs.render(15)).toBe(legacy.render(15));
    expect(runs.render(15)).not.toContain("DISCONTINUITY");
  });
});
