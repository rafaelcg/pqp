import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The download watchdog: what happens when one half of a download stops.
 *
 * This is the failure a review caught twice. The first version put a plain
 * deadline on each object, which kills a slow but perfectly healthy
 * download. The second restarted the clock whenever the destination was
 * backpressured, which is every stalled reader there is -- so a client that
 * simply stopped reading held a storage connection and a server pipeline
 * open for as long as it liked. What has to be true is both at once: a slow
 * client is never cut off, and a client that has stopped taking bytes is.
 *
 * Progress is therefore bytes the socket ACCEPTED (its `drain`) or bytes
 * storage delivered, and nothing else. The tests below are the two sides of
 * that, with the timeouts injected so neither one waits two real minutes.
 */

const { streamWatchPartyDownload } = await import("./hls-history.js");

const BODY = "x".repeat(64 * 1024);

function plan(keys: string[]) {
  return {
    kind: "film" as const,
    contentType: "video/mp2t",
    extension: "ts" as const,
    keys,
    bytes: BODY.length * keys.length,
  };
}

describe("streamWatchPartyDownload watchdog", () => {
  beforeEach(() => {
    process.env.LIVE_HLS_S3_BUCKET = "pqp-live-test";
    process.env.LIVE_HLS_S3_ACCESS_KEY_ID = "ak";
    process.env.LIVE_HLS_S3_SECRET_ACCESS_KEY = "sk";
    process.env.LIVE_HLS_S3_ENDPOINT = "https://s3.example.test";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_input: string | URL | Request, init?: RequestInit) =>
          new Response(BODY, {
            status: 200,
            // Honour the signal the way undici does, so an abort mid-transfer
            // is a rejected body rather than a silently complete one.
            ...(init?.signal?.aborted ? { status: 499 } : {}),
          }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.LIVE_HLS_S3_BUCKET;
    delete process.env.LIVE_HLS_S3_ACCESS_KEY_ID;
    delete process.env.LIVE_HLS_S3_SECRET_ACCESS_KEY;
    delete process.env.LIVE_HLS_S3_ENDPOINT;
  });

  it("gives up on a reader that has stopped taking bytes", async () => {
    // Accepts the first write and never calls back: the body is delivered,
    // the socket is full, and nothing will ever move again. Aborting the
    // storage fetch alone would not help here -- the fetch has finished --
    // which is why the abort drives the whole pipeline.
    const stalled = new Writable({
      highWaterMark: 1,
      write() {
        // Deliberately never completes.
      },
    });
    await expect(
      streamWatchPartyDownload(plan(["live/c/1-720p30_00000.ts"]), stalled, {
        idleMs: 300,
      }),
    ).rejects.toThrow();
  });

  it("does not give up on a reader that is merely slow", async () => {
    // Takes every chunk, but late: each write lands well after the idle
    // window would have fired if backpressure counted as silence.
    const slow = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, done) {
        setTimeout(done, 60);
      },
    });
    await expect(
      streamWatchPartyDownload(
        plan(["live/c/1-720p30_00000.ts", "live/c/1-720p30_00001.ts"]),
        slow,
        { idleMs: 400 },
      ),
    ).resolves.toBeUndefined();
  });

  it("ends a download that has outlived its absolute ceiling", async () => {
    const slow = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, done) {
        setTimeout(done, 200);
      },
    });
    await expect(
      streamWatchPartyDownload(
        plan([
          "live/c/1-720p30_00000.ts",
          "live/c/1-720p30_00001.ts",
          "live/c/1-720p30_00002.ts",
        ]),
        slow,
        { idleMs: 10_000, maxMs: 100 },
      ),
    ).rejects.toThrow();
  });
});

describe("streamWatchPartyDownload with shifted objects", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.LIVE_HLS_S3_BUCKET;
    delete process.env.LIVE_HLS_S3_ACCESS_KEY_ID;
    delete process.env.LIVE_HLS_S3_SECRET_ACCESS_KEY;
    delete process.env.LIVE_HLS_S3_ENDPOINT;
  });

  it("moves only the objects its plan says to, and keeps every length", async () => {
    process.env.LIVE_HLS_S3_BUCKET = "pqp-live-test";
    process.env.LIVE_HLS_S3_ACCESS_KEY_ID = "ak";
    process.env.LIVE_HLS_S3_SECRET_ACCESS_KEY = "sk";
    process.env.LIVE_HLS_S3_ENDPOINT = "https://s3.example.test";
    const { firstPts } = await import("./ts-timestamp-shift.js");
    const packet = (pts: number) => {
      const pkt = new Uint8Array(188).fill(0xff);
      pkt.set([0x47, 0x41, 0x00, 0x10, 0x00, 0x00, 0x01, 0xe0, 0x00, 0x00, 0x80, 0x80, 5]);
      pkt[13] = 0x21 | ((Math.floor(pts / 2 ** 30) & 7) << 1);
      pkt[14] = Math.floor(pts / 2 ** 22) & 0xff;
      pkt[15] = ((Math.floor(pts / 2 ** 15) & 0x7f) << 1) | 1;
      pkt[16] = Math.floor(pts / 2 ** 7) & 0xff;
      pkt[17] = ((pts & 0x7f) << 1) | 1;
      return pkt;
    };
    const body = Buffer.concat([packet(900_000), packet(903_000)]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(Uint8Array.from(body), { status: 200 })),
    );
    const out: Buffer[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, done) {
        out.push(chunk);
        done();
      },
    });
    await streamWatchPartyDownload(
      {
        kind: "camera",
        contentType: "video/mp2t",
        extension: "ts",
        keys: ["live/c/1-cam360p30_00000.ts", "live/c/1-cam360p30-r2_00000.ts"],
        ptsOffsets: [0, 9_000_000],
        bytes: body.length * 2,
      },
      sink,
    );
    const all = Buffer.concat(out);
    expect(all.length).toBe(body.length * 2);
    expect(firstPts(all.subarray(0, body.length))).toBe(900_000);
    expect(firstPts(all.subarray(body.length))).toBe(9_900_000);
  });
});
