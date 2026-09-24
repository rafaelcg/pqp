import { describe, expect, it } from "vitest";
import {
  LEGACY_RUNS,
  nextRun,
  parseHlsRuns,
  segmentsWritten,
  serializeHlsRuns,
  stitchRunPlaylists,
} from "./hls-runs.js";

describe("parseHlsRuns", () => {
  it("reads NULL, garbage and an empty array as the legacy single run", () => {
    for (const raw of [null, undefined, "", "not json", [], {}, 3]) {
      expect(parseHlsRuns(raw)).toEqual([{ suffix: "", base: 0 }]);
    }
  });

  it("reads an array or its JSON string", () => {
    const runs = [
      { suffix: "", base: 0 },
      { suffix: "-r1790000000000", base: 40 },
    ];
    expect(parseHlsRuns(runs)).toEqual(runs);
    expect(parseHlsRuns(JSON.stringify(runs))).toEqual(runs);
  });

  it("keeps a suffixed first run (a rung that joined after a restart)", () => {
    expect(parseHlsRuns([{ suffix: "-r5", base: 12 }])).toEqual([
      { suffix: "-r5", base: 12 },
    ]);
  });

  it("refuses bases that do not climb, repeated or malformed suffixes", () => {
    for (const raw of [
      [{ suffix: "", base: 0 }, { suffix: "-r1", base: 0 }],
      [{ suffix: "-r1", base: 0 }, { suffix: "-r1", base: 5 }],
      [{ suffix: "-x1", base: 0 }],
      [{ suffix: "", base: -1 }],
      [{ suffix: "", base: 1.5 }],
      [null],
    ]) {
      expect(parseHlsRuns(raw)).toEqual([...LEGACY_RUNS]);
    }
  });

  it("round-trips through serializeHlsRuns, the legacy run as NULL", () => {
    expect(serializeHlsRuns(LEGACY_RUNS)).toBeNull();
    const runs = [
      { suffix: "", base: 0 },
      { suffix: "-r9", base: 3 },
    ];
    expect(parseHlsRuns(serializeHlsRuns(runs))).toEqual(runs);
  });
});

describe("segmentsWritten", () => {
  it("is the media sequence plus the entries listed", () => {
    const body = [
      "#EXTM3U",
      "#EXT-X-MEDIA-SEQUENCE:37",
      "#EXTINF:4.0,",
      "a_00037.ts",
      "#EXTINF:4.0,",
      "a_00038.ts",
      "",
    ].join("\n");
    expect(segmentsWritten(body)).toBe(39);
  });

  it("counts from 0 without a sequence tag, and handles CRLF", () => {
    expect(segmentsWritten("#EXTM3U\r\n#EXTINF:4.0,\r\na.ts\r\n")).toBe(1);
  });

  it("is null for a body that lists nothing and says nothing", () => {
    expect(segmentsWritten("#EXTM3U\n")).toBeNull();
    expect(segmentsWritten("#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:7\n")).toBe(7);
  });
});

describe("nextRun", () => {
  const started = 1_790_000_000_000;

  it("places the next run after what the previous one wrote", () => {
    const runs = nextRun(LEGACY_RUNS, started + 60_000, 15, started);
    expect(runs).toEqual([
      { suffix: "", base: 0 },
      { suffix: `-r${started + 60_000}`, base: 15 },
    ]);
    expect(nextRun(runs, started + 90_000, 4, started)[2]).toEqual({
      suffix: `-r${started + 90_000}`,
      base: 19,
    });
  });

  it("estimates an unread count high: one per elapsed second, plus one", () => {
    const runs = nextRun(LEGACY_RUNS, started + 60_000, null, started);
    expect(runs[1]!.base).toBe(61);
    // Measured from the previous run's own start when it has one.
    const again = nextRun(runs, started + 70_000, null, started);
    expect(again[2]!.base).toBe(61 + 11);
  });

  it("never reuses a suffix, even inside one millisecond", () => {
    const first = nextRun(LEGACY_RUNS, started + 1_000, 1, started);
    const second = nextRun(first, started + 1_000, 0, started);
    expect(second[2]!.suffix).toBe(`-r${started + 1_001}`);
    // A run that wrote nothing still moves the base on by one.
    expect(second[2]!.base).toBe(second[1]!.base + 1);
  });
});

function runBody(
  names: string[],
  options: { target?: number; pdt?: string; ended?: boolean } = {},
): string {
  return [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    `#EXT-X-TARGETDURATION:${options.target ?? 4}`,
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-PLAYLIST-TYPE:EVENT",
    ...names.flatMap((name, index) => [
      ...(options.pdt && index === 0
        ? [`#EXT-X-PROGRAM-DATE-TIME:${options.pdt}`]
        : []),
      "#EXTINF:4.000,",
      name,
    ]),
    ...(options.ended ? ["#EXT-X-ENDLIST"] : []),
    "",
  ].join("\n");
}

describe("stitchRunPlaylists", () => {
  it("joins runs in order with one DISCONTINUITY per later run and one ENDLIST", () => {
    const stitched = stitchRunPlaylists([
      runBody(["a_00000.ts", "a_00001.ts"], { pdt: "2026-09-24T20:00:00.000Z", ended: true }),
      runBody(["a-r1_00000.ts"], { target: 6, pdt: "2026-09-24T20:01:00.000Z" }),
      runBody(["a-r2_00000.ts", "a-r2_00001.ts"], { ended: true }),
    ]);
    expect(stitched).toBe(
      [
        "#EXTM3U",
        "#EXT-X-VERSION:3",
        "#EXT-X-TARGETDURATION:6",
        "#EXT-X-PLAYLIST-TYPE:VOD",
        "#EXT-X-MEDIA-SEQUENCE:0",
        "#EXT-X-PROGRAM-DATE-TIME:2026-09-24T20:00:00.000Z",
        "#EXTINF:4.000,",
        "a_00000.ts",
        "#EXTINF:4.000,",
        "a_00001.ts",
        "#EXT-X-DISCONTINUITY",
        "#EXT-X-PROGRAM-DATE-TIME:2026-09-24T20:01:00.000Z",
        "#EXTINF:4.000,",
        "a-r1_00000.ts",
        "#EXT-X-DISCONTINUITY",
        "#EXTINF:4.000,",
        "a-r2_00000.ts",
        "#EXTINF:4.000,",
        "a-r2_00001.ts",
        "#EXT-X-ENDLIST",
        "",
      ].join("\n"),
    );
  });

  it("skips a run that lists nothing and caps a run at its successor's base", () => {
    const stitched = stitchRunPlaylists(
      [
        runBody(["a_00000.ts", "a_00001.ts", "a_00002.ts"]),
        "",
        runBody(["a-r2_00000.ts"]),
      ],
      [2, null, null],
    )!;
    const uris = stitched.split("\n").filter((line) => line.endsWith(".ts"));
    expect(uris).toEqual(["a_00000.ts", "a_00001.ts", "a-r2_00000.ts"]);
    expect(stitched.match(/#EXT-X-DISCONTINUITY$/gm)).toHaveLength(1);
  });

  it("never copies an input's sequence tags or doubles a DISCONTINUITY", () => {
    const later = [
      "#EXTM3U",
      "#EXT-X-TARGETDURATION:4",
      "#EXT-X-MEDIA-SEQUENCE:9",
      "#EXT-X-DISCONTINUITY-SEQUENCE:2",
      "#EXT-X-DISCONTINUITY",
      "#EXTINF:4.0,",
      "b_00009.ts",
      "",
    ].join("\n");
    const stitched = stitchRunPlaylists([runBody(["a.ts"]), later])!;
    expect(stitched).not.toContain("DISCONTINUITY-SEQUENCE");
    expect(stitched.match(/^#EXT-X-MEDIA-SEQUENCE:/gm)).toEqual([
      "#EXT-X-MEDIA-SEQUENCE:",
    ]);
    expect(stitched).toContain("#EXT-X-MEDIA-SEQUENCE:0");
    expect(stitched.match(/^#EXT-X-DISCONTINUITY$/gm)).toHaveLength(1);
  });

  it("is null when no run lists anything", () => {
    expect(stitchRunPlaylists(["", "#EXTM3U\n#EXT-X-ENDLIST\n"])).toBeNull();
    expect(stitchRunPlaylists([])).toBeNull();
  });
});
