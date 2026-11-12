import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JAM_VIDEO_MAX_BYTES } from "@pqp/shared";
import { UnsupportedContainerError } from "./transcode.js";
import {
  conversionArgs,
  convertVideoToMp4,
  demuxerOf,
  inspectMp4File,
  isJamTranscodeAvailable,
  planFor,
  type Mp4Facts,
} from "./video-transcode.js";

/**
 * The MP4 copy of a Jam camera video, on REAL ffmpeg. The claim that matters
 * is not "an MP4 comes out" but "the picture and the sound come out WHERE THEY
 * WENT IN": the take's audio is placed against the video's time zero
 * (`client/src/lib/jam/video-take.ts`), so a copy that starts a frame late, or
 * trims the first 100 ms of silence, plays out of sync on an iPhone for ever.
 *
 * The fixture is a 3 s clip with a white flash on the picture from t = 1.0 s
 * and a 4 ms click on the sound at the same instant (or 120 ms later, in the
 * second one, the way a recorder's audio and video tracks start apart). The
 * test finds the flash and the click again in the output, with ffmpeg's own
 * decoder, and compares them with where they were in the input.
 *
 * Skipped where ffmpeg lacks libx264, AAC, libvpx or libopus; CI installs a
 * full ffmpeg for it (`.github/workflows/ci.yml`).
 */

const FFMPEG = process.env.FFMPEG_PATH?.trim() || "ffmpeg";

function encoders(): string {
  try {
    return execFileSync(FFMPEG, ["-hide_banner", "-encoders"], { encoding: "utf8" });
  } catch {
    return "";
  }
}
const list = encoders();
const complete = /\blibx264\b/.test(list) && /\baac\b/.test(list) && /\blibvpx\b/.test(list) && /\blibopus\b/.test(list);
const describeFfmpeg = complete ? describe : describe.skip;

// ---------------------------------------------------------------- the boxes

function box(type: string, ...payload: Buffer[]): Buffer {
  const body = Buffer.concat(payload);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + body.length, 0);
  header.write(type, 4, "latin1");
  return Buffer.concat([header, body]);
}

const ftyp = box("ftyp", Buffer.from("isom\0\0\0\0isomiso2avc1mp41", "latin1"));
const mdat = box("mdat", Buffer.from("frames"));
const moov = (...entries: string[]) => box("moov", ...entries.map((entry) => box("stsd", Buffer.from(entry, "latin1"))));

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pqp-jam-video-test-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function file(name: string, ...parts: Buffer[]): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, Buffer.concat(parts));
  return path;
}

describe("what the worker does with a recorded file", () => {
  it("copies nothing that is already a regular faststart H.264 + AAC MP4", async () => {
    const facts = await inspectMp4File(await file("ok.mp4", ftyp, moov("avc1", "mp4a"), mdat));
    expect(facts).toEqual({ fragmented: false, faststart: true, h264: true, aac: true, otherCodec: false });
    expect(planFor("mov", facts)).toBe("none");
  });

  it("only re-wraps the right codecs in a wrapper phones scrub badly (MediaRecorder's fragmented MP4, or a moov at the end)", async () => {
    const fragmented = await inspectMp4File(
      await file("frag.mp4", ftyp, moov("avc1", "mp4a"), box("moof", Buffer.from("x")), mdat),
    );
    expect(fragmented).toMatchObject({ fragmented: true, h264: true });
    expect(planFor("mov", fragmented)).toBe("remux");
    const moovLast = await inspectMp4File(await file("last.mp4", ftyp, mdat, moov("avc1", "mp4a")));
    expect(moovLast).toMatchObject({ fragmented: false, faststart: false });
    expect(planFor("mov", moovLast)).toBe("remux");
  });

  it("re-encodes whatever a phone cannot be trusted with: WebM, and MP4 holding VP9 or Opus", async () => {
    expect(planFor("matroska", null)).toBe("transcode");
    const vp9 = await inspectMp4File(await file("vp9.mp4", ftyp, moov("vp09", "Opus"), mdat));
    expect(planFor("mov", vp9)).toBe("transcode");
    const hevc = await inspectMp4File(await file("hevc.mp4", ftyp, moov("hvc1", "mp4a"), mdat));
    expect(planFor("mov", hevc)).toBe("transcode");
    const opusAudio = await inspectMp4File(await file("opus.mp4", ftyp, moov("avc1", "Opus"), mdat));
    expect(planFor("mov", opusAudio)).toBe("transcode");
    expect(planFor("mov", null)).toBe("transcode");
  });

  it("a picture with no sound is fine: AAC is not required", async () => {
    const silent = await inspectMp4File(await file("mute.mp4", ftyp, moov("avc1"), mdat));
    expect(silent).toMatchObject({ h264: true, aac: false });
    expect(planFor("mov", silent)).toBe("none");
  });

  it("names the demuxer from the bytes and refuses anything else, so ffmpeg never probes an upload", async () => {
    expect(await demuxerOf(await file("a.mp4", ftyp, mdat))).toBe("mov");
    expect(await demuxerOf(await file("a.webm", Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2])))).toBe("matroska");
    // An HLS playlist, which ffmpeg would follow to the URLs inside it.
    const playlist = await file("evil.webm", Buffer.from("#EXTM3U\n#EXT-X-VERSION:3\nhttp://169.254.169.254/\n"));
    await expect(demuxerOf(playlist)).rejects.toBeInstanceOf(UnsupportedContainerError);
  });

  it("knows a file with no moov is not an MP4 at all", async () => {
    expect(await inspectMp4File(await file("nomoov.mp4", ftyp, mdat))).toBeNull();
  });
});

// ------------------------------------------------------- real ffmpeg, end to end

interface Probe {
  /** Seconds, media time, of the first picture that is white. */
  flashAt: number;
  /** Seconds, media time, of the first loud sample. */
  clickAt: number;
  firstFrameAt: number;
  frames: number;
  duration: number;
  /** ffmpeg's one-line description of each stream. */
  video: string;
  audio: string;
}

/** What `ffmpeg` decodes out of a file: where the flash and the click are, in the file's own clock. */
function probe(path: string): Probe {
  const decoded = spawnSync(
    FFMPEG,
    // `first_pts=0` pads a late start with silence, so sample 0 is media time 0.
    ["-v", "error", "-i", path, "-vn", "-af", "aresample=async=1:first_pts=0", "-ac", "1", "-ar", "48000", "-f", "f32le", "-"],
    { maxBuffer: 1 << 28 },
  );
  // No audio stream: ffmpeg has nothing to write, and there is no click to find.
  const pcm = decoded.status === 0 ? decoded.stdout : Buffer.alloc(0);
  const samples = new Float32Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.length));
  let clickAt = -1;
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i]!) > 0.15) {
      clickAt = i / 48000;
      break;
    }
  }
  const shown = spawnSync(
    FFMPEG,
    ["-hide_banner", "-i", path, "-an", "-vf", "scale=2:2,format=gray,showinfo", "-f", "null", "-"],
    { encoding: "utf8", maxBuffer: 1 << 26 },
  ).stderr;
  const frames: { pts: number; mean: number }[] = [];
  for (const line of shown.split("\n")) {
    const m = /pts_time:([\d.]+).*mean:\[(\d+)/.exec(line);
    if (m) frames.push({ pts: Number(m[1]), mean: Number(m[2]) });
  }
  const flash = frames.find((frame) => frame.mean > 128);
  const header = spawnSync(FFMPEG, ["-hide_banner", "-i", path], { encoding: "utf8" }).stderr;
  const dur = /Duration: (\d+):(\d+):([\d.]+)/.exec(header);
  return {
    flashAt: flash?.pts ?? -1,
    clickAt,
    firstFrameAt: frames[0]?.pts ?? -1,
    frames: frames.length,
    duration: dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : -1,
    video: /Stream #0:\d.*Video: ([^\n]*)/.exec(header)?.[1] ?? "",
    audio: /Stream #0:\d.*Audio: ([^\n]*)/.exec(header)?.[1] ?? "",
  };
}

/** The 3 s fixture: a flash from 1.0 s and a click at 1.0 s + `audioDelay`. */
function render(path: string, codecs: string[], audioDelay = 0): void {
  execFileSync(
    FFMPEG,
    [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=320x180:r=30:d=3,drawbox=x=0:y=0:w=320:h=180:color=white:t=fill:enable='between(t,1,1.2)'",
      ...(audioDelay > 0 ? ["-itsoffset", String(audioDelay)] : []),
      "-f",
      "lavfi",
      "-i",
      "aevalsrc='if(between(t,1,1.004),0.9*sin(2*PI*3000*t),0)':s=48000:d=3",
      "-t",
      "3.3",
      ...codecs,
      path,
    ],
    { stdio: "ignore" },
  );
}

const WEBM_CODECS = ["-c:v", "libvpx", "-b:v", "600k", "-c:a", "libopus", "-b:a", "64k"];

const FRAME = 1 / 30;

describeFfmpeg("the MP4 copy keeps the picture and the sound where they were", () => {
  it("is available here (the worker's own check)", async () => {
    expect(await isJamTranscodeAvailable()).toBe(true);
  });

  for (const audioDelay of [0, 0.12]) {
    it(`WebM to H.264 + AAC, faststart, same duration, flash and click on the same instants (audio ${audioDelay * 1000} ms late)`, async () => {
      const input = join(dir, `in-${audioDelay}.webm`);
      const output = join(dir, `out-${audioDelay}.mp4`);
      render(input, WEBM_CODECS, audioDelay);
      const before = probe(input);
      // The fixture really is what it claims: the flash at 1 s, the click `audioDelay` later.
      expect(before.flashAt).toBeGreaterThan(0.95);
      expect(before.flashAt).toBeLessThan(1.1);
      expect(before.clickAt).toBeGreaterThan(1 + audioDelay - 0.02);
      expect(before.clickAt).toBeLessThan(1 + audioDelay + 0.02);

      const demuxer = await demuxerOf(input);
      expect(demuxer).toBe("matroska");
      await convertVideoToMp4(input, output, demuxer, planFor(demuxer, null) as "transcode");
      const after = probe(output);

      // What a phone needs from the file.
      expect(after.video).toMatch(/^h264 \((Constrained Baseline|Main|High)\)/);
      expect(after.video).toContain("yuv420p");
      expect(after.audio).toMatch(/^aac \(LC\)/);
      expect(await inspectMp4File(output)).toEqual({
        fragmented: false,
        faststart: true,
        h264: true,
        aac: true,
        otherCodec: false,
      });

      // Same duration, and a constant 30 frames a second over it.
      expect(Math.abs(after.duration - before.duration)).toBeLessThan(0.1);
      expect(Math.abs(after.frames - before.frames)).toBeLessThanOrEqual(3);
      // The first frame keeps its time, and the flash is on the same frame.
      expect(Math.abs(after.firstFrameAt - before.firstFrameAt)).toBeLessThanOrEqual(FRAME);
      expect(Math.abs(after.flashAt - before.flashAt)).toBeLessThanOrEqual(FRAME);
      // The click is on the same sample, give or take what a lossy encoder smears.
      expect(Math.abs(after.clickAt - before.clickAt)).toBeLessThan(0.01);
      // And so the sound is where it was AGAINST the picture, which is what a take's offset is.
      expect(Math.abs(after.clickAt - after.flashAt - (before.clickAt - before.flashAt))).toBeLessThan(FRAME + 0.01);
    }, 60_000);
  }

  it("a fragmented H.264 + AAC MP4 (what MediaRecorder writes) is re-wrapped with its streams copied, in place on the timeline", async () => {
    const input = join(dir, "frag.mp4");
    const output = join(dir, "frag-out.mp4");
    render(input, ["-c:v", "libx264", "-c:a", "aac", "-movflags", "frag_keyframe+empty_moov+default_base_moof"], 0.12);
    const facts = await inspectMp4File(input);
    expect(facts).toMatchObject({ fragmented: true, h264: true, aac: true });
    const plan = planFor("mov", facts);
    expect(plan).toBe("remux");
    const before = probe(input);
    await convertVideoToMp4(input, output, "mov", "remux");
    const after = probe(output);
    expect(await inspectMp4File(output)).toMatchObject({ fragmented: false, faststart: true });
    expect(after.video).toMatch(/^h264/);
    expect(Math.abs(after.flashAt - before.flashAt)).toBeLessThanOrEqual(FRAME);
    expect(Math.abs(after.clickAt - before.clickAt)).toBeLessThan(0.005);
    expect(Math.abs(after.duration - before.duration)).toBeLessThan(0.1);
  }, 60_000);

  it("a picture with no sound at all still converts", async () => {
    const input = join(dir, "mute.webm");
    const output = join(dir, "mute.mp4");
    execFileSync(
      FFMPEG,
      ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=160x90:r=30:d=1", "-c:v", "libvpx", input],
      { stdio: "ignore" },
    );
    await convertVideoToMp4(input, output, "matroska", "transcode");
    const after = probe(output);
    expect(after.video).toMatch(/^h264/);
    expect(after.audio).toBe("");
  }, 60_000);

  it("a file ffmpeg cannot read fails with a reason, not a hang", async () => {
    const input = await file("broken.webm", Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0]));
    await expect(convertVideoToMp4(input, join(dir, "broken.mp4"), "matroska", "transcode")).rejects.toThrow(/ffmpeg exited/);
  }, 30_000);

  it("odd picture sizes are made even, which H.264 requires", async () => {
    const input = join(dir, "odd.webm");
    const output = join(dir, "odd.mp4");
    execFileSync(
      FFMPEG,
      ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=161x91:r=30:d=1", "-c:v", "libvpx", input],
      { stdio: "ignore" },
    );
    await convertVideoToMp4(input, output, "matroska", "transcode");
    expect(probe(output).video).toMatch(/160x90/);
  }, 30_000);

  it("a picture past 1920x1080 is scaled into it, where a fixed H.264 level would have refused it", async () => {
    const input = join(dir, "big.webm");
    const output = join(dir, "big.mp4");
    execFileSync(
      FFMPEG,
      ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=2560x1440:r=5:d=1", "-c:v", "libvpx", "-b:v", "300k", input],
      { stdio: "ignore" },
    );
    await convertVideoToMp4(input, output, "matroska", "transcode");
    expect(probe(output).video).toMatch(/1920x1080/);
  }, 60_000);

  it("a header that declares more than a 4K picture is refused by the decoder, before it allocates the frame", async () => {
    const input = join(dir, "huge.webm");
    execFileSync(
      FFMPEG,
      ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=4096x2304:r=1:d=1", "-c:v", "libvpx", "-b:v", "50k", input],
      { stdio: "ignore" },
    );
    await expect(convertVideoToMp4(input, join(dir, "huge.mp4"), "matroska", "transcode")).rejects.toThrow(/ffmpeg exited/);
  }, 60_000);
});

describe("the ffmpeg command line", () => {
  it("bounds what a hostile file can cost: decoded pixels, one allocation, the output's size, and nothing but local files", () => {
    for (const plan of ["transcode", "remux"] as const) {
      const line = conversionArgs("/in", "/out.mp4", "matroska", plan);
      expect(line).toContain("-max_alloc");
      expect(line.join(" ")).toContain("-protocol_whitelist file");
      expect(line.join(" ")).toContain(`-fs ${JAM_VIDEO_MAX_BYTES + 1}`);
      // The demuxer is named, never probed.
      expect(line.join(" ")).toContain("-f matroska -");
    }
    expect(conversionArgs("/in", "/out.mp4", "matroska", "transcode")).toContain("-max_pixels");
    // A fixed level refuses a picture bigger than it allows; x264 picks its own.
    expect(conversionArgs("/in", "/out.mp4", "matroska", "transcode")).not.toContain("-level");
  });
});

// Types only: keep the import used when the ffmpeg block is skipped.
void (null as unknown as Mp4Facts);
