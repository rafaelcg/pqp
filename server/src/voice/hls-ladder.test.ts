import { afterEach, describe, expect, it } from "vitest";
import {
  buildMasterPlaylist,
  decideLadder,
  DEFAULT_MAX_LADDER_MBPS,
  HLS_RUNG_MBPS,
  LADDER_RUNGS,
  ladderBudgetMbps,
  parseLadder,
  rungEncodingOptions,
  type LadderRung,
} from "./hls-ladder.js";

const ORIGINAL = process.env.LIVE_HLS_MAX_LADDER_MBPS;

afterEach(() => {
  if (ORIGINAL === undefined) {
    delete process.env.LIVE_HLS_MAX_LADDER_MBPS;
  } else {
    process.env.LIVE_HLS_MAX_LADDER_MBPS = ORIGINAL;
  }
});

function names(rungs: readonly LadderRung[]): string[] {
  return rungs.map((rung) => rung.name);
}

describe("parseLadder", () => {
  it("defaults to 1080p30 + 720p30 + 480p30, lowest first", () => {
    expect(names(parseLadder({}).rungs)).toEqual([
      "480p30",
      "720p30",
      "1080p30",
    ]);
  });

  it("sorts by bitrate whatever order the operator wrote", () => {
    expect(names(parseLadder({ ladder: "480p30,1080p30,720p30" }).rungs)).toEqual(
      ["480p30", "720p30", "1080p30"],
    );
  });

  it("a single entry is a one-rung ladder, which is the old behaviour", () => {
    const parsed = parseLadder({ ladder: "720p30" });
    expect(names(parsed.rungs)).toEqual(["720p30"]);
    expect(parsed.invalid).toEqual([]);
  });

  it("LIVE_HLS_PRESET still names a one-rung ladder", () => {
    expect(names(parseLadder({ preset: "1080p30" }).rungs)).toEqual([
      "1080p30",
    ]);
    // An explicit ladder wins over the older variable.
    expect(
      names(parseLadder({ ladder: "480p30", preset: "1080p30" }).rungs),
    ).toEqual(["480p30"]);
  });

  it("is tolerant about case, spacing and duplicates", () => {
    expect(
      names(parseLadder({ ladder: " 1080P30 , 720p30 ,1080p30, " }).rungs),
    ).toEqual(["720p30", "1080p30"]);
  });

  it("reports what it could not read and still returns a usable ladder", () => {
    const parsed = parseLadder({ ladder: "4k,720p30" });
    expect(names(parsed.rungs)).toEqual(["720p30"]);
    expect(parsed.invalid).toEqual(["4k"]);
  });

  it("a list with nothing valid in it falls back to the default", () => {
    const parsed = parseLadder({ ladder: "4k,potato" });
    expect(names(parsed.rungs)).toEqual(["480p30", "720p30", "1080p30"]);
    expect(parsed.invalid).toEqual(["4k", "potato"]);
  });

  it("a rung can carry a bitrate override", () => {
    const parsed = parseLadder({ ladder: "1080p30@3000,720p30" });
    expect(parsed.rungs.map((rung) => rung.videoKbps)).toEqual([1800, 3000]);
    // The override changes the ORDER when it crosses another rung, because
    // the ladder is sorted by what it actually costs, not by its name.
    expect(
      names(parseLadder({ ladder: "1080p30@900,720p30" }).rungs),
    ).toEqual(["1080p30", "720p30"]);
  });

  it("a nonsense override is not a rung", () => {
    expect(parseLadder({ ladder: "1080p30@abc,720p30" }).invalid).toEqual([
      "1080p30@abc",
    ]);
  });

  it("the gap between the two default rungs is wide enough for hls.js", () => {
    // hls.js switches UP when estimate * abrBandWidthUpFactor (0.7) clears
    // the next level, and DOWN when estimate * abrBandWidthFactor (0.95)
    // falls under the current one. A narrow band between those two is where
    // a viewer oscillates. LiveKit's own presets (3000 and 4500) leave about
    // 1.10x; these leave about 1.36x.
    const rungs = parseLadder({}).rungs;
    const low = rungs.find((rung) => rung.name === "720p30");
    const high = rungs.find((rung) => rung.name === "1080p30");
    const up = high!.videoKbps / 0.7;
    const down = high!.videoKbps / 0.95;
    expect(up / down).toBeGreaterThan(1.3);
    expect(high!.videoKbps / low!.videoKbps).toBeGreaterThanOrEqual(2.5);
  });
});

describe("rungEncodingOptions", () => {
  it("asks the egress for exactly the rung's size and bitrate", () => {
    const options = rungEncodingOptions(LADDER_RUNGS["1080p30"]!);
    expect(options.width).toBe(1920);
    expect(options.height).toBe(1080);
    expect(options.framerate).toBe(30);
    expect(options.videoBitrate).toBe(4500);
  });

  it("leaves the keyframe interval to the egress", () => {
    // Zero means "the segment duration" for a segmented output, which is
    // what puts every rung's segment boundaries on a keyframe and lets a
    // player switch between them.
    expect(rungEncodingOptions(LADDER_RUNGS["720p30"]!).keyFrameInterval).toBe(
      0,
    );
  });
});

describe("ladderBudgetMbps", () => {
  it("defaults to three rungs' worth", () => {
    delete process.env.LIVE_HLS_MAX_LADDER_MBPS;
    expect(ladderBudgetMbps()).toBe(DEFAULT_MAX_LADDER_MBPS);
    expect(DEFAULT_MAX_LADDER_MBPS).toBe(HLS_RUNG_MBPS * 3);
  });

  it("reads the environment per call, so an operator needs no deploy", () => {
    process.env.LIVE_HLS_MAX_LADDER_MBPS = "450";
    expect(ladderBudgetMbps()).toBe(450);
    process.env.LIVE_HLS_MAX_LADDER_MBPS = "150";
    expect(ladderBudgetMbps()).toBe(150);
  });

  it("zero is a real value, not an empty one", () => {
    process.env.LIVE_HLS_MAX_LADDER_MBPS = "0";
    expect(ladderBudgetMbps()).toBe(0);
  });

  it("junk falls back to the default", () => {
    for (const junk of ["", "  ", "two hundred", "-40", "NaN"]) {
      process.env.LIVE_HLS_MAX_LADDER_MBPS = junk;
      expect(ladderBudgetMbps()).toBe(DEFAULT_MAX_LADDER_MBPS);
    }
  });
});

describe("decideLadder", () => {
  const base = {
    runningRungs: 0,
    sfuLoadMbps: 0,
    ladderBudgetMbps: DEFAULT_MAX_LADDER_MBPS,
    boxBudgetMbps: 600,
  };
  const twoRung = [LADDER_RUNGS["720p30"]!, LADDER_RUNGS["1080p30"]!];
  const defaultRungs = parseLadder({}).rungs;

  it("starts every rung when the box is idle", () => {
    const decisions = decideLadder({ ...base, rungs: defaultRungs });
    expect(decisions.map((d) => [d.rung.name, d.start])).toEqual([
      ["480p30", true],
      ["720p30", true],
      ["1080p30", true],
    ]);
  });

  it("considers rungs lowest first, whatever order they arrive in", () => {
    const decisions = decideLadder({
      ...base,
      rungs: [LADDER_RUNGS["1080p30"]!, LADDER_RUNGS["480p30"]!],
    });
    expect(decisions.map((d) => d.rung.name)).toEqual(["480p30", "1080p30"]);
  });

  it("refuses a rung over the ladder budget", () => {
    const decisions = decideLadder({
      ...base,
      rungs: twoRung,
      ladderBudgetMbps: HLS_RUNG_MBPS,
    });
    expect(decisions[0]!.start).toBe(true);
    expect(decisions[1]!.start).toBe(false);
    expect(decisions[1]!.refusal).toBe("ladder-budget");
  });

  it("the lowest rung starts even when the budget is zero", () => {
    const decisions = decideLadder({
      ...base,
      rungs: twoRung,
      ladderBudgetMbps: 0,
    });
    // A watch party with no rendition is a watch party nobody can see. One
    // rendition is what shipped before the ladder existed, and the budget
    // governs the EXTRA rungs, never the existence of the stream.
    expect(decisions[0]!.start).toBe(true);
    expect(decisions[1]!.start).toBe(false);
  });

  it("counts the WebRTC already on the box", () => {
    const decisions = decideLadder({
      ...base,
      rungs: twoRung,
      // Room enough for the ladder on its own, not enough once the cameras
      // on the same box are priced in.
      ladderBudgetMbps: 1000,
      boxBudgetMbps: 400,
      sfuLoadMbps: 150,
    });
    expect(decisions[0]!.start).toBe(true);
    expect(decisions[1]!.start).toBe(false);
    expect(decisions[1]!.refusal).toBe("box-budget");
  });

  it("counts renditions already running for other channels", () => {
    const decisions = decideLadder({
      ...base,
      rungs: twoRung,
      runningRungs: 1,
      ladderBudgetMbps: HLS_RUNG_MBPS * 2,
    });
    // The other party's rung plus this party's lowest is already the whole
    // budget, so the second rung of this one does not fit.
    expect(decisions[0]!.start).toBe(true);
    expect(decisions[1]!.start).toBe(false);
    expect(decisions[1]!.refusal).toBe("ladder-budget");
  });

  it("a refused rung does not spend budget the next one could have used", () => {
    const decisions = decideLadder({
      ...base,
      rungs: [
        LADDER_RUNGS["360p30"]!,
        LADDER_RUNGS["1080p30"]!,
        LADDER_RUNGS["480p30"]!,
      ],
      ladderBudgetMbps: HLS_RUNG_MBPS * 2,
    });
    expect(decisions.map((d) => [d.rung.name, d.start])).toEqual([
      ["360p30", true],
      ["480p30", true],
      ["1080p30", false],
    ]);
  });

  it("exactly at budget passes, like the promotion guard", () => {
    const decisions = decideLadder({
      ...base,
      rungs: twoRung,
      ladderBudgetMbps: HLS_RUNG_MBPS * 2,
    });
    expect(decisions.every((d) => d.start)).toBe(true);
  });

  it("refuses a rung taller than the published source", () => {
    const decisions = decideLadder({
      ...base,
      rungs: defaultRungs,
      sourceHeight: 720,
    });
    expect(decisions.map((d) => [d.rung.name, d.start, d.refusal])).toEqual([
      ["480p30", true, null],
      ["720p30", true, null],
      ["1080p30", false, "source-height"],
    ]);
  });

  it("a 1078-line window is still a 1080p source", () => {
    const decisions = decideLadder({
      ...base,
      rungs: defaultRungs,
      sourceHeight: 1078,
    });
    expect(decisions.every((d) => d.start)).toBe(true);
  });

  it("the lowest rung starts even when it is taller than the source", () => {
    const decisions = decideLadder({
      ...base,
      rungs: twoRung,
      sourceHeight: 360,
    });
    expect(decisions[0]!.start).toBe(true);
    expect(decisions[1]!.start).toBe(false);
    expect(decisions[1]!.refusal).toBe("source-height");
  });
});

describe("buildMasterPlaylist", () => {
  const variants = [
    { rung: LADDER_RUNGS["1080p30"]!, uri: "/one?t=abc" },
    { rung: LADDER_RUNGS["720p30"]!, uri: "/two?t=abc" },
  ];

  it("lists the rungs lowest bitrate first", () => {
    const lines = buildMasterPlaylist(variants).trim().split("\n");
    expect(lines[0]).toBe("#EXTM3U");
    expect(lines[2]).toContain("RESOLUTION=1280x720");
    expect(lines[3]).toBe("/two?t=abc");
    expect(lines[4]).toContain("RESOLUTION=1920x1080");
    expect(lines[5]).toBe("/one?t=abc");
  });

  it("carries the attributes a player needs to choose", () => {
    const body = buildMasterPlaylist([variants[0]!]);
    // BANDWIDTH is the PEAK, above the nominal average, so a player sizing
    // its buffer from it is not caught out by a busy two seconds.
    expect(body).toContain("BANDWIDTH=5322200");
    expect(body).toContain("AVERAGE-BANDWIDTH=4628000");
    expect(body).toContain("RESOLUTION=1920x1080");
    expect(body).toContain("FRAME-RATE=30.000");
    expect(body).toContain('CODECS="avc1.4d0028,mp4a.40.2"');
  });

  it("every variant declares both a video and an audio codec", () => {
    for (const rung of Object.values(LADDER_RUNGS)) {
      expect(rung.codecs).toMatch(/^avc1\.[0-9a-f]{6},mp4a\.40\.2$/);
    }
  });

  it("a one-rung ladder is still a valid master playlist", () => {
    const body = buildMasterPlaylist([variants[1]!]);
    expect(body.startsWith("#EXTM3U\n")).toBe(true);
    expect(body.match(/#EXT-X-STREAM-INF/g)).toHaveLength(1);
    expect(body.endsWith("\n")).toBe(true);
  });
});
