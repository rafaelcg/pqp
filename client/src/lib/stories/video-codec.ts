/**
 * Which codec a picked MP4 or QuickTime file holds, read from its boxes before anything is
 * uploaded, so a file the server is going to refuse is refused here, with the reason.
 *
 * The server only takes H.264 (`docs/plans/STORIES.md` 17.8). An iPhone's `.mov` is HEVC unless the
 * phone is set to "Most Compatible", and a browser (Safari, Chrome on a Mac) can still play and
 * preview it, so the file would look fine right up to the moment the server's video job refuses it.
 *
 * The walk reads only box headers until it finds `moov` (an iPhone writes it at the END of the
 * file), then looks at the sample entry of the first video track (`stsd`). Anything it cannot
 * make sense of answers `null` and the server decides, as it always did.
 */

export type VideoCodec = "h264" | "unsupported" | null;

const H264 = new Set(["avc1", "avc3"]);
/** Sample entries of a video track that is NOT H.264: HEVC, Dolby Vision, ProRes, MPEG-4 part 2, AV1... */
const OTHER_VIDEO = new Set([
  "hvc1",
  "hev1",
  "dvh1",
  "dvhe",
  "apch",
  "apcn",
  "apco",
  "apcs",
  "ap4h",
  "ap4x",
  "mp4v",
  "av01",
  "vp09",
  "jpeg",
  "mjpa",
]);

const MOOV_MAX_BYTES = 16 * 1024 * 1024;
const MAX_BOXES = 256;

const ascii = (bytes: Uint8Array, at: number, length = 4) => String.fromCharCode(...bytes.subarray(at, at + length));

/** The codec named by the first video sample entry inside a `moov` box's bytes, or null. */
export function codecOfMoov(moov: Uint8Array): VideoCodec {
  for (let at = 0; at + 20 <= moov.length; at += 1) {
    if (moov[at] !== 0x73 || ascii(moov, at) !== "stsd") {
      continue;
    }
    // stsd: type, version+flags (4), entry count (4), then the first entry: size (4) and its type.
    const entry = ascii(moov, at + 16);
    if (H264.has(entry)) {
      return "h264";
    }
    if (OTHER_VIDEO.has(entry)) {
      return "unsupported";
    }
    // An audio (or other) track's entry: keep looking for the video one.
  }
  return null;
}

/** Reads `file` (a Blob) far enough to find the video codec. Never throws. */
export async function sniffVideoCodec(file: Blob): Promise<VideoCodec> {
  try {
    let offset = 0;
    for (let boxes = 0; boxes < MAX_BOXES && offset + 8 <= file.size; boxes += 1) {
      const head = new Uint8Array(await file.slice(offset, offset + 16).arrayBuffer());
      const view = new DataView(head.buffer);
      let size = view.getUint32(0);
      const type = ascii(head, 4);
      if (size === 1 && head.length >= 16) {
        size = Number(view.getBigUint64(8));
      } else if (size === 0) {
        size = file.size - offset;
      }
      if (size < 8) {
        return null;
      }
      if (type === "moov") {
        if (size > MOOV_MAX_BYTES) {
          return null;
        }
        return codecOfMoov(new Uint8Array(await file.slice(offset, offset + size).arrayBuffer()));
      }
      offset += size;
    }
  } catch {
    // Unreadable: the server decides.
  }
  return null;
}
