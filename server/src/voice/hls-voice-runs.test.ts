import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { Writable } from "node:stream";
import {
  newOggStitchState,
  oggCrc32,
  oggSilenceBytes,
  oggSilencePages,
  OggRunRewriter,
  parseOggPages,
  readOggRunEnd,
  readOggRunHead,
} from "./ogg-stitch.js";

/**
 * The host's voice over more than one archive run (an egress that ended and
 * came back in place, a replaced mic track): the runs' Ogg Opus pages joined
 * into ONE stream, with silence where the archive was down, so the voice
 * after a restart plays at the moment it was spoken.
 */

// ---------------------------------------------------------------------------
// Synthetic runs, the shape a LiveKit Track Egress writes: OpusHead page,
// OpusTags page, audio pages, EOS on the last one.
// ---------------------------------------------------------------------------

function oggPage(input: {
  serial: number;
  sequence: number;
  granule: bigint;
  flags?: number;
  packets: Uint8Array[];
}): Buffer {
  const lacing: number[] = [];
  for (const packet of input.packets) {
    let left = packet.length;
    while (left >= 255) {
      lacing.push(255);
      left -= 255;
    }
    lacing.push(left);
  }
  const body = Buffer.concat(input.packets.map((packet) => Buffer.from(packet)));
  const page = Buffer.alloc(27 + lacing.length + body.length);
  page.write("OggS", 0, "latin1");
  page[5] = input.flags ?? 0;
  page.writeBigUInt64LE(input.granule, 6);
  page.writeUInt32LE(input.serial, 14);
  page.writeUInt32LE(input.sequence, 18);
  page[26] = lacing.length;
  Buffer.from(lacing).copy(page, 27);
  body.copy(page, 27 + lacing.length);
  page.writeUInt32LE(oggCrc32(page), 22);
  return page;
}

/** `packets` 20 ms packets (TOC 0xF8 then a `marker` byte), ten to a page. */
function opusRun(serial: number, packets: number, marker: number, preSkip = 312): Buffer {
  const head = Buffer.alloc(19);
  head.write("OpusHead", 0, "latin1");
  head[8] = 1;
  head[9] = 1;
  head.writeUInt16LE(preSkip, 10);
  head.writeUInt32LE(48_000, 12);
  const tags = Buffer.alloc(20);
  tags.write("OpusTags", 0, "latin1");
  tags.writeUInt32LE(4, 8);
  tags.write("test", 12, "latin1");
  const pages = [
    oggPage({ serial, sequence: 0, granule: 0n, flags: 0x02, packets: [head] }),
    oggPage({ serial, sequence: 1, granule: 0n, packets: [tags] }),
  ];
  let written = 0;
  while (written < packets) {
    const count = Math.min(10, packets - written);
    written += count;
    pages.push(
      oggPage({
        serial,
        sequence: pages.length,
        granule: BigInt(preSkip + written * 960),
        flags: written === packets ? 0x04 : 0,
        packets: Array.from({ length: count }, () => Uint8Array.of(0xf8, marker, 0)),
      }),
    );
  }
  return Buffer.concat(pages);
}

function crcOk(buf: Uint8Array, offset: number, length: number): boolean {
  const page = Buffer.from(buf.subarray(offset, offset + length));
  const stated = page.readUInt32LE(22);
  page.writeUInt32LE(0, 22);
  return oggCrc32(page) === stated;
}

/** Everything a player cares about in the joined file. */
function describeStream(out: Uint8Array) {
  const pages = parseOggPages(out);
  const covered = pages.reduce((sum, page) => sum + page.length, 0);
  const packets: number[] = [];
  for (const page of pages) {
    const bodyAt = page.offset + 27 + out[page.offset + 26]!;
    for (const packet of page.packets) {
      const bytes = out.subarray(bodyAt + packet.start, bodyAt + packet.end);
      // 0xFF for a silence packet (F8 FF FE), else the run's marker byte.
      packets.push(bytes.length === 3 && bytes[2] === 0xfe ? 0xff : bytes[1]!);
    }
  }
  return {
    covered,
    serials: new Set(pages.map((page) => page.serial)),
    sequences: pages.map((page) => new DataView(out.buffer, out.byteOffset + page.offset).getUint32(18, true)),
    bos: pages.filter((page) => page.flags & 0x02).map((page) => pages.indexOf(page)),
    eos: pages.filter((page) => page.flags & 0x04).map((page) => pages.indexOf(page)),
    crcs: pages.every((page) => crcOk(out, page.offset, page.length)),
    granules: pages
      .map((page) => page.granule)
      .filter((granule) => granule !== 0xffffffffffffffffn),
    packets,
    pages,
  };
}

describe("ogg-stitch", () => {
  it("reads a run's header pages, its first sample and its last granule", () => {
    const run = opusRun(7, 25, 0x01);
    const head = readOggRunHead(run)!;
    expect(head.serial).toBe(7);
    expect(head.headerPages).toBe(2);
    expect(head.origin).toBe(312n);
    expect(readOggRunEnd(run.subarray(run.length - 200), 7)).toBe(BigInt(312 + 25 * 960));
  });

  it("joins two runs into one stream with the gap as silence", async () => {
    const a = opusRun(111, 20, 0x0a);
    const b = opusRun(222, 15, 0x0b);
    const headB = readOggRunHead(b)!;
    const state = newOggStitchState();
    const chunks: Buffer[] = [];
    const push = async (stream: NodeJS.ReadableStream) => {
      for await (const chunk of stream) {
        chunks.push(chunk as Buffer);
      }
    };
    // In pieces that split pages, as a network body does.
    const pieceA = new OggRunRewriter(state, { dropPages: 0, granuleDelta: 0, clearEos: true });
    const collectA = push(pieceA);
    for (let at = 0; at < a.length; at += 37) {
      pieceA.write(a.subarray(at, at + 37));
    }
    pieceA.end();
    await collectA;
    const endA = 312 + 20 * 960;
    for (const page of oggSilencePages(state, 30, endA)) {
      chunks.push(page);
    }
    const startB = endA + 30 * 960;
    const pieceB = new OggRunRewriter(state, {
      dropPages: headB.headerPages,
      granuleDelta: startB - Number(headB.origin),
      clearEos: false,
    });
    const collectB = push(pieceB);
    pieceB.end(b);
    await collectB;
    const out = Buffer.concat(chunks);

    expect(out.length).toBe(a.length + oggSilenceBytes(30) + b.length - headB.headerBytes);
    const stream = describeStream(out);
    expect(stream.covered).toBe(out.length);
    expect([...stream.serials]).toEqual([111]);
    expect(stream.sequences).toEqual(stream.sequences.map((_, index) => index));
    expect(stream.bos).toEqual([0]);
    expect(stream.eos).toEqual([stream.pages.length - 1]);
    expect(stream.crcs).toBe(true);
    // OpusHead, OpusTags, run A, the gap, run B: in that order.
    expect(stream.packets.slice(2)).toEqual([
      ...Array(20).fill(0x0a),
      ...Array(30).fill(0xff),
      ...Array(15).fill(0x0b),
    ]);
    const granules = stream.granules.filter((granule) => granule > 0n);
    expect(granules).toEqual([...granules].sort((x, y) => (x < y ? -1 : 1)));
    expect(granules.at(-1)).toBe(BigInt(312 + (20 + 30 + 15) * 960));
  });
});

// ---------------------------------------------------------------------------
// The download itself, against a real `hls_sessions` row and a stubbed bucket.
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;
if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("../services/users.js");
const {
  buildWatchPartyDownloadPlan,
  micArchiveRunKeys,
  resetWatchPartyDownloadCacheForTests,
  streamWatchPartyDownload,
  watchPartyDownloadSizes,
} = await import("./hls-history.js");

const STARTED_AT = 1_790_266_962_477;

describe("micArchiveRunKeys", () => {
  it("puts the first run first and the restarts in start order, ignoring anything else", () => {
    const prefix = "live/c/1-mic";
    expect(
      micArchiveRunKeys(prefix, [
        "live/c/1-mic-r300.ogg",
        "live/c/1-mic.ogg",
        "live/c/1-mic-r20.ogg",
        "live/c/1-mic-r20.ogg.tmp",
        "live/c/1-mic-rX.ogg",
      ]),
    ).toEqual([
      { key: "live/c/1-mic.ogg", startMs: null },
      { key: "live/c/1-mic-r20.ogg", startMs: 20 },
      { key: "live/c/1-mic-r300.ogg", startMs: 300 },
    ]);
  });
});

describeDb("the voice download over archive runs", () => {
  let channelId: string;
  let objects: Record<string, Buffer>;
  const prefix = () => `live/${channelId}/${STARTED_AT}-mic`;

  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    resetWatchPartyDownloadCacheForTests();
    delete process.env.LIVE_HLS_RETENTION_MINUTES;
    delete process.env.LIVE_HLS_REPLAY_HOURS;
    process.env.LIVE_HLS_S3_BUCKET = "pqp-live-test";
    process.env.LIVE_HLS_S3_ACCESS_KEY_ID = "ak";
    process.env.LIVE_HLS_S3_SECRET_ACCESS_KEY = "sk";
    process.env.LIVE_HLS_S3_ENDPOINT = "https://s3.example.test";
    process.env.LIVE_HLS_S3_FORCE_PATH_STYLE = "true";
    await getPool().query(
      `TRUNCATE users, servers, channels, hls_sessions RESTART IDENTITY CASCADE`,
    );
    const user = await upsertUser({
      clerkId: "clerk_hls_voice_runs",
      displayName: "Voice Runs",
      avatarUrl: null,
    });
    const server = await getPool().query<{ id: string }>(
      `INSERT INTO servers (name, owner_id) VALUES ('test', $1) RETURNING id`,
      [user.id],
    );
    const channel = await getPool().query<{ id: string }>(
      `INSERT INTO channels (server_id, name, type, position)
       VALUES ($1, 'watch', 'voice', 0) RETURNING id`,
      [server.rows[0]!.id],
    );
    channelId = channel.rows[0]!.id;
    objects = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input instanceof Request ? input.url : input));
        const key = decodeURIComponent(url.pathname.replace(/^\/pqp-live-test\//, ""));
        if (url.searchParams.get("list-type") === "2") {
          const listPrefix = url.searchParams.get("prefix") ?? "";
          const contents = Object.keys(objects)
            .filter((name) => name.startsWith(listPrefix))
            .map((name) => `<Contents><Key>${name}</Key><Size>${objects[name]!.length}</Size></Contents>`)
            .join("");
          return new Response(
            `<ListBucketResult><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`,
          );
        }
        const body = objects[key];
        if (!body) {
          return new Response("NoSuchKey", { status: 404 });
        }
        const range = new Headers(init?.headers).get("range");
        const match = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
        if (!match) {
          return new Response(new Uint8Array(body));
        }
        const [from, to] = match[1]
          ? [Number(match[1]), Math.min(body.length - 1, Number(match[2]))]
          : [Math.max(0, body.length - Number(match[2])), body.length - 1];
        return new Response(new Uint8Array(body.subarray(from, to + 1)), { status: 206 });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.LIVE_HLS_S3_BUCKET;
    delete process.env.LIVE_HLS_S3_ACCESS_KEY_ID;
    delete process.env.LIVE_HLS_S3_SECRET_ACCESS_KEY;
    delete process.env.LIVE_HLS_S3_ENDPOINT;
    delete process.env.LIVE_HLS_S3_FORCE_PATH_STYLE;
  });

  async function micRow(runs: unknown) {
    await getPool().query(
      `INSERT INTO hls_sessions
         (channel_id, object_prefix, started_at, ended_at, keep_replay, rung, runs)
       VALUES ($1, $2, to_timestamp($3 / 1000.0), NOW() - interval '1 hour', TRUE, 'mic', $4::jsonb)`,
      [channelId, prefix(), STARTED_AT, runs === null ? null : JSON.stringify(runs)],
    );
  }

  async function download(): Promise<{ bytes: number; out: Buffer }> {
    const plan = await buildWatchPartyDownloadPlan(channelId, STARTED_AT, "voice");
    expect(plan).not.toBeNull();
    const chunks: Buffer[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, done) {
        chunks.push(chunk);
        done();
      },
    });
    await streamWatchPartyDownload(plan!, sink);
    return { bytes: plan!.bytes, out: Buffer.concat(chunks) };
  }

  it("hands a single run back byte for byte, as before", async () => {
    await micRow(null);
    const only = opusRun(1, 30, 0x01);
    objects[`${prefix()}.ogg`] = only;
    const { bytes, out } = await download();
    expect(bytes).toBe(only.length);
    expect(out.equals(only)).toBe(true);
  });

  /**
   * The 2026-09-24 shape: the first run from 16:22:43 until its egress ended,
   * then the archive back in place a few seconds later, and the download has
   * to be the whole show on one clock.
   */
  it("stitches two runs into one file with the time between them as silence", async () => {
    // The first run started 1 s into the session and recorded 2 s; the second
    // started 8 s in, so the archive was down for 5 s.
    await micRow([
      { suffix: "", base: 1_000 },
      { suffix: `-r${STARTED_AT + 8_000}`, base: 8_000 },
    ]);
    const first = opusRun(1, 100, 0x0a);
    const second = opusRun(2, 50, 0x0b);
    objects[`${prefix()}.ogg`] = first;
    objects[`${prefix()}-r${STARTED_AT + 8_000}.ogg`] = second;

    const sizes = await watchPartyDownloadSizes(channelId, STARTED_AT);
    expect(sizes.voice).toBe(first.length + second.length);

    const { bytes, out } = await download();
    // The promised Content-Length is what was sent.
    expect(out.length).toBe(bytes);
    const stream = describeStream(out);
    expect(stream.covered).toBe(out.length);
    expect(stream.serials.size).toBe(1);
    expect(stream.bos).toEqual([0]);
    expect(stream.eos).toEqual([stream.pages.length - 1]);
    expect(stream.crcs).toBe(true);
    expect(stream.sequences).toEqual(stream.sequences.map((_, index) => index));
    // One OpusHead and one OpusTags, then the first run, 5 s of silence (250
    // packets of 20 ms), then the second run.
    expect(stream.packets.slice(2)).toEqual([
      ...Array(100).fill(0x0a),
      ...Array(250).fill(0xff),
      ...Array(50).fill(0x0b),
    ]);
    expect(stream.granules.at(-1)).toBe(BigInt(312 + (100 + 250 + 50) * 960));
  });

  it("places a run by its own start even when the first run's is not known", async () => {
    // A row from before restarts wrote starts: the first run is followed at
    // once, the third is still placed against the second on the wall clock.
    await micRow(null);
    const r2 = STARTED_AT + 60_000;
    const r3 = r2 + 1_000 + 2_000; // 1 s of audio, then 2 s down
    objects[`${prefix()}.ogg`] = opusRun(1, 10, 0x0a);
    objects[`${prefix()}-r${r2}.ogg`] = opusRun(2, 50, 0x0b);
    objects[`${prefix()}-r${r3}.ogg`] = opusRun(3, 10, 0x0c);

    const { bytes, out } = await download();
    expect(out.length).toBe(bytes);
    expect(describeStream(out).packets.slice(2)).toEqual([
      ...Array(10).fill(0x0a),
      ...Array(50).fill(0x0b),
      ...Array(100).fill(0xff),
      ...Array(10).fill(0x0c),
    ]);
  });

  it("never puts a run earlier than the previous one ended", async () => {
    // A clock that says the second run began before the first finished.
    await micRow([{ suffix: "", base: 1_000 }]);
    objects[`${prefix()}.ogg`] = opusRun(1, 100, 0x0a);
    objects[`${prefix()}-r${STARTED_AT + 1_500}.ogg`] = opusRun(2, 10, 0x0b);

    const { bytes, out } = await download();
    expect(out.length).toBe(bytes);
    expect(describeStream(out).packets.slice(2)).toEqual([
      ...Array(100).fill(0x0a),
      ...Array(10).fill(0x0b),
    ]);
  });
});
