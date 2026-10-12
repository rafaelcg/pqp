import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { combineScans, realStoryVideoTools } from "./story-media.js";

/**
 * The parts of the video job that are not about the database (those are in
 * `api/stories.test.ts`): how four verdicts become one, and the real ffmpeg
 * seam on a real file. The ffmpeg half is skipped where there is no ffmpeg
 * (CI's runner image may not carry it; the worker image does).
 */

const pass = { status: "pass" as const, provider: "t", score: 0.1, labels: [], illegal: false };

describe("combineScans", () => {
  it("takes the worst verdict, the top score and every label", () => {
    const combined = combineScans([
      pass,
      { status: "flagged", provider: "t", score: 0.6, labels: ["gore"], illegal: false },
      { status: "rejected", provider: "iwf", score: 1, labels: ["illegal"], illegal: true },
      pass,
    ]);
    expect(combined).toEqual({
      status: "rejected",
      provider: "iwf",
      score: 1,
      labels: ["gore", "illegal"],
      illegal: true,
    });
  });

  it("an error outranks a flag, so a broken scanner fails closed", () => {
    expect(
      combineScans([
        { status: "flagged", provider: "t", score: 0.6, labels: ["gore"], illegal: false },
        { status: "error", provider: "t", score: null, labels: [], illegal: false },
      ]).status,
    ).toBe("error");
  });

  it("all passes pass", () => {
    expect(combineScans([pass, pass, pass, pass]).status).toBe("pass");
  });
});

const hasFfmpeg =
  spawnSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" }).stdout?.includes(
    "libx264",
  ) === true &&
  spawnSync("ffprobe", ["-version"]).status === 0;

describe.skipIf(!hasFfmpeg)("the real ffmpeg seam", () => {
  it("probes length and codec and cuts a JPEG frame", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pqp-story-test-"));
    try {
      const video = join(dir, "clip.mp4");
      const made = spawnSync("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=320x240:rate=10",
        "-t",
        "2",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-y",
        video,
      ]);
      expect(made.status).toBe(0);
      const probed = await realStoryVideoTools.probe(video);
      expect(probed.videoCodec).toBe("h264");
      expect(probed.durationMs).toBeGreaterThan(1500);
      expect(probed.durationMs).toBeLessThan(2500);
      expect([probed.width, probed.height]).toEqual([320, 240]);
      const frame = join(dir, "frame.jpg");
      await realStoryVideoTools.frame(video, 1, frame);
      const bytes = await readFile(frame);
      expect([...bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a file that is not a video is refused by the probe", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pqp-story-test-"));
    try {
      const path = join(dir, "x.mp4");
      spawnSync("sh", ["-c", `printf 'not a video' > ${path}`]);
      await expect(realStoryVideoTools.probe(path)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
