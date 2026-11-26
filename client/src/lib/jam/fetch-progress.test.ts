import { afterEach, describe, expect, it, vi } from "vitest";
import { JamPlayer } from "./player";
import { announcedBytes, megabytes, readWithProgress, songBytes, songFraction } from "./fetch-progress";

function streamed(chunks: number[], headers: Record<string, string> = {}): Response {
  let at = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(new Uint8Array(chunks[at++]!).fill(7));
    },
  });
  return new Response(body, { headers });
}

describe("announcedBytes", () => {
  it("reads Content-Length", () => {
    expect(announcedBytes(new Headers({ "content-length": "5400000" }))).toBe(5_400_000);
  });
  it("says nothing when the header is missing, zero or not a number", () => {
    expect(announcedBytes(new Headers())).toBeNull();
    expect(announcedBytes(new Headers({ "content-length": "0" }))).toBeNull();
    expect(announcedBytes(new Headers({ "content-length": "abc" }))).toBeNull();
  });
  it("does not trust a length that counts encoded bytes", () => {
    expect(announcedBytes(new Headers({ "content-length": "100", "content-encoding": "gzip" }))).toBeNull();
    expect(announcedBytes(new Headers({ "content-length": "100", "content-encoding": "identity" }))).toBe(100);
  });
});

describe("readWithProgress", () => {
  it("reports each chunk against the announced size and returns every byte in order", async () => {
    const seen: Array<[number, number | null]> = [];
    const bytes = await readWithProgress(streamed([10, 20, 30], { "content-length": "60" }), (loaded, total) =>
      seen.push([loaded, total]),
    );
    expect(bytes.byteLength).toBe(60);
    expect(seen[0]).toEqual([0, 60]);
    expect(seen.map(([loaded]) => loaded)).toEqual([0, 10, 30, 60, 60]);
    expect(seen.at(-1)).toEqual([60, 60]);
  });

  it("reports an unknown size as null, and settles the total at the end", async () => {
    const seen: Array<[number, number | null]> = [];
    await readWithProgress(streamed([5, 5]), (loaded, total) => seen.push([loaded, total]));
    expect(seen.slice(0, 3)).toEqual([
      [0, null],
      [5, null],
      [10, null],
    ]);
    expect(seen.at(-1)).toEqual([10, 10]);
  });

  it("drops a total the body has run past instead of showing more than 100%", async () => {
    const seen: Array<[number, number | null]> = [];
    await readWithProgress(streamed([30, 30], { "content-length": "40" }), (loaded, total) => seen.push([loaded, total]));
    expect(seen[1]).toEqual([30, 40]);
    expect(seen[2]).toEqual([60, null]);
  });
});

describe("songBytes", () => {
  it("is null before anything has reported", () => {
    expect(songBytes([], 5)).toBeNull();
    expect(songBytes([{ loaded: 0, total: null }], 0)).toBeNull();
  });

  it("is exact when every stem has said its size", () => {
    const bytes = songBytes(
      [
        { loaded: 5, total: 10 },
        { loaded: 10, total: 10 },
      ],
      2,
    );
    expect(bytes).toEqual({ loaded: 15, total: 20, exact: true });
    expect(songFraction(bytes)).toBeCloseTo(0.75);
  });

  it("guesses the stems that have not started at the mean of those that have", () => {
    const bytes = songBytes(
      [
        { loaded: 1, total: 10 },
        { loaded: 1, total: 30 },
      ],
      5,
    );
    // 40 known + 3 unknown x 20 mean
    expect(bytes).toEqual({ loaded: 2, total: 100, exact: false });
  });

  it("has loaded bytes but no total while no stem knows its size", () => {
    const bytes = songBytes([{ loaded: 4, total: null }], 3);
    expect(bytes).toEqual({ loaded: 4, total: 0, exact: false });
    expect(songFraction(bytes)).toBeNull();
  });

  it("never lets the total sit under what has arrived, and the fraction stops at 1", () => {
    const bytes = songBytes([{ loaded: 12, total: 10 }], 1);
    expect(bytes!.total).toBeGreaterThanOrEqual(bytes!.loaded);
    expect(songFraction(bytes)).toBe(1);
  });
});

describe("megabytes", () => {
  it("keeps one decimal under 10 and none above", () => {
    expect(megabytes(1_240_000, "en")).toBe("1.2");
    expect(megabytes(12_400_000, "en")).toBe("12");
    expect(megabytes(53_600_000, "en")).toBe("54");
  });
  it("uses the reader's decimal separator", () => {
    expect(megabytes(1_240_000, "pt-BR")).toBe("1,2");
  });
});

describe("JamPlayer.decode: progress is opt-in", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function player() {
    const decodeAudioData = vi.fn(async (bytes: ArrayBuffer) => ({ length: bytes.byteLength }) as unknown as AudioBuffer);
    const node = { connect: vi.fn(), gain: { value: 1 } };
    const context = {
      createGain: () => node,
      destination: {},
      decodeAudioData,
    } as unknown as AudioContext;
    return { jam: new JamPlayer(context), decodeAudioData };
  }

  it("reads the whole body with arrayBuffer() when nobody asks, as the studio does", async () => {
    const res = streamed([4, 4], { "content-length": "8" });
    const arrayBuffer = vi.spyOn(res, "arrayBuffer");
    vi.stubGlobal("fetch", vi.fn(async () => res));
    const { jam, decodeAudioData } = player();
    await jam.decode("https://media.test/a.flac");
    expect(arrayBuffer).toHaveBeenCalledTimes(1);
    expect(decodeAudioData).toHaveBeenCalledTimes(1);
  });

  it("reads the stream and reports when asked, and decodes the same bytes", async () => {
    const res = streamed([4, 4], { "content-length": "8" });
    const arrayBuffer = vi.spyOn(res, "arrayBuffer");
    vi.stubGlobal("fetch", vi.fn(async () => res));
    const { jam, decodeAudioData } = player();
    const seen: Array<[number, number | null]> = [];
    await jam.decode("https://media.test/a.flac", { onProgress: (loaded, total) => seen.push([loaded, total]) });
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(seen).toContainEqual([4, 8]);
    expect(seen.at(-1)).toEqual([8, 8]);
    expect((decodeAudioData.mock.calls[0]![0] as ArrayBuffer).byteLength).toBe(8);
  });

  it("does not touch the network for bytes or a Blob, with or without a listener", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { jam, decodeAudioData } = player();
    const onProgress = vi.fn();
    await jam.decode(new ArrayBuffer(3), { onProgress });
    await jam.decode(new Blob([new Uint8Array(5)]), { onProgress });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(onProgress).not.toHaveBeenCalled();
    expect(decodeAudioData).toHaveBeenCalledTimes(2);
  });

  it("still refuses a failed response with the same error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 403 })));
    const { jam } = player();
    await expect(jam.decode("https://media.test/a.flac", { onProgress: () => undefined })).rejects.toThrow("jam: fetch 403");
  });
});
