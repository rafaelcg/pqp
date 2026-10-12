import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readContainerDuration } from "./container-duration.js";

/**
 * The fixtures are 1.5 s of a 440 Hz tone at 16 kHz mono, made with the
 * local ffmpeg (8.1) and committed so CI needs none:
 *
 *   ffmpeg -f lavfi -i sine=f=440:d=1.5:sample_rate=16000 -ac 1 \
 *     -c:a aac    -b:a 16k -movflags +faststart                  note.m4a
 *     -c:a aac    -b:a 16k -movflags frag_keyframe+empty_moov+default_base_moof \
 *                 -frag_duration 500000                          note-fragmented.m4a
 *     -c:a libopus -b:a 16k                                      note.webm
 *     -c:a libopus -b:a 16k -live 1                              note-live.webm
 *     -c:a libopus -b:a 16k                                      note.ogg
 *
 * `note-live.webm` is the shape Chrome's MediaRecorder uploads: no Duration in
 * Info, unknown-size Segment and Cluster. `note-fragmented.m4a` is Safari's:
 * an `empty_moov` whose mvhd says 0, with the length only in the fragments.
 * Encoders pad (AAC priming, Opus pre-roll), so the answer is "about 1.5 s",
 * which is the precision a duration check needs.
 */
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const read = (name: string) => readFileSync(join(FIXTURES, name));

describe("readContainerDuration", () => {
  it.each([
    ["note.m4a", "mp4", "aac"],
    ["note-fragmented.m4a", "mp4", "aac"],
    ["note.webm", "webm", "opus"],
    ["note-live.webm", "webm", "opus"],
    ["note.ogg", "ogg", "opus"],
  ])("%s is about 1.5 s of %s/%s", (name, container, codec) => {
    const info = readContainerDuration(read(name));
    expect(info).not.toBeNull();
    expect(info!.container).toBe(container);
    expect(info!.codec).toBe(codec);
    expect(info!.durationMs).toBeGreaterThanOrEqual(1_400);
    expect(info!.durationMs).toBeLessThanOrEqual(1_650);
  });

  it("the fragmented file really has no length in its movie header", () => {
    // Pins the fixture to the case it exists for: if a future ffmpeg wrote a
    // duration into mvhd, the trun path would go untested without notice.
    const bytes = read("note-fragmented.m4a");
    const mvhd = bytes.indexOf("mvhd", 0, "latin1");
    expect(mvhd).toBeGreaterThan(0);
    const version = bytes[mvhd + 4];
    expect(version).toBe(0);
    expect(bytes.readUInt32BE(mvhd + 4 + 16)).toBe(0);
  });

  it("the live webm really has no Duration element", () => {
    expect(read("note-live.webm").includes(Buffer.from([0x44, 0x89]))).toBe(false);
  });

  it("a header that declares less than the samples hold is not believed", () => {
    // mvhd says one tick; the sample table still says 1.5 s.
    const mp4 = Buffer.from(read("note.m4a"));
    const mvhd = mp4.indexOf("mvhd", 0, "latin1");
    mp4.writeUInt32BE(1, mvhd + 4 + 16);
    expect(readContainerDuration(mp4)!.durationMs).toBeGreaterThanOrEqual(1_400);

    // Info/Duration says 1 ms; the blocks still run to 1.5 s.
    const webm = Buffer.from(read("note.webm"));
    const at = webm.indexOf(Buffer.from([0x44, 0x89]));
    expect(at).toBeGreaterThan(0);
    const size = webm[at + 2]! & 0x7f;
    if (size === 8) webm.writeDoubleBE(1, at + 3);
    else webm.writeFloatBE(1, at + 3);
    expect(readContainerDuration(webm)!.durationMs).toBeGreaterThanOrEqual(1_400);
  });

  it("returns null for bytes it does not know or cannot finish", () => {
    expect(readContainerDuration(Buffer.from("not audio at all"))).toBeNull();
    expect(readContainerDuration(Buffer.alloc(0))).toBeNull();
    expect(readContainerDuration(read("note.ogg").subarray(0, 40))).toBeNull();
    // A header with nothing after it is not a recording.
    expect(readContainerDuration(read("note-live.webm").subarray(0, 64))).toBeNull();
  });

  it("never throws on garbage behind a valid magic", () => {
    for (const name of ["note.m4a", "note-fragmented.m4a", "note.webm", "note.ogg"]) {
      const bytes = Buffer.from(read(name));
      for (let i = 12; i < bytes.length; i += 7) bytes[i] = (bytes[i]! * 31 + 7) & 0xff;
      expect(() => readContainerDuration(bytes)).not.toThrow();
    }
  });
});
