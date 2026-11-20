import { randomBytes } from "node:crypto";
import net from "node:net";
import type { AddressInfo } from "node:net";
import zlib from "node:zlib";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer, type PerMessageDeflateOptions } from "ws";

import { broadcastEncoded, encodeFrame } from "../ws/fanout.js";
import { WS_PER_MESSAGE_DEFLATE } from "./ws-compression.js";
import {
  AUDITED_WS_MINORS,
  compressedTextFrameHeader,
  INSTALLED_WS_VERSION,
  resetSharedDeflateStats,
  setSharedDeflateUnauditedForTests,
  SHARED_DEFLATE_MIN_RECIPIENTS,
  sharedDeflateStats,
} from "./ws-shared-deflate.js";

/**
 * COMPRESS-ONCE FAN-OUT, WITH THE FLAG ON (CLAUDE.md pitfall 12: the path
 * production will run). Real `ws` servers, real `ws` clients, and raw TCP
 * clients that parse every frame themselves, so a frame the shared path gets
 * wrong cannot hide behind a lenient decoder.
 *
 * The raw client has two inflate modes, because receivers differ in what they
 * do with their window after a message:
 *
 *  - `reset`: a fresh inflater per message (what `ws` itself does when the
 *    server declared `server_no_context_takeover`).
 *  - `takeover`: the window is kept across messages, every compressed
 *    message's output appended to it (what a browser is allowed to do, and the
 *    strictest receiver there is: a frame that leaned on per-socket history
 *    would decode to garbage here). Implemented as a raw inflate with the last
 *    2^windowBits bytes of earlier output as its preset dictionary, which is
 *    exactly what a retained LZ77 window is.
 *
 * A negative control below proves the takeover receiver really does catch the
 * corruption this whole design exists to avoid.
 */

process.env.WS_SHARED_DEFLATE = "true";

const TRAILER = Buffer.from([0x00, 0x00, 0xff, 0xff]);

type InflateMode = "reset" | "takeover";

interface RawMessage {
  compressed: boolean;
  /** The frame's payload as it crossed the wire (compressed when RSV1). */
  wire: Buffer;
  text: string;
}

interface RawClient {
  messages: RawMessage[];
  errors: string[];
  negotiated: string;
  socket: net.Socket;
  waitForCount(count: number, timeoutMs?: number): Promise<void>;
}

function rawClient(
  port: number,
  extensions: string | null,
  mode: InflateMode,
  options: { paused?: boolean } = {},
): Promise<RawClient> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    const key = randomBytes(16).toString("base64");
    let buffered = Buffer.alloc(0);
    let upgraded = false;
    let windowBits = 15;
    let history = Buffer.alloc(0);
    const client: RawClient = {
      messages: [],
      errors: [],
      negotiated: "",
      socket,
      waitForCount(count, timeoutMs = 10_000) {
        return new Promise((done, fail) => {
          const started = Date.now();
          const tick = () => {
            if (client.messages.length >= count) {
              done();
            } else if (Date.now() - started > timeoutMs) {
              fail(new Error(`raw client got ${client.messages.length}/${count}`));
            } else {
              setTimeout(tick, 5);
            }
          };
          tick();
        });
      },
    };
    socket.on("error", (error) => {
      if (!upgraded) {
        reject(error);
      }
    });
    socket.on("connect", () => {
      socket.write(
        [
          "GET / HTTP/1.1",
          `Host: 127.0.0.1:${port}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${key}`,
          "Sec-WebSocket-Version: 13",
          ...(extensions ? [`Sec-WebSocket-Extensions: ${extensions}`] : []),
          "",
          "",
        ].join("\r\n"),
      );
    });
    const inflate = (payload: Buffer): Buffer => {
      const input = Buffer.concat([payload, TRAILER]);
      if (mode === "reset") {
        return zlib.inflateRawSync(input, { windowBits, finishFlush: zlib.constants.Z_SYNC_FLUSH });
      }
      const out = zlib.inflateRawSync(input, {
        windowBits,
        finishFlush: zlib.constants.Z_SYNC_FLUSH,
        ...(history.length > 0 ? { dictionary: history } : {}),
      });
      history = Buffer.concat([history, out]);
      if (history.length > 1 << windowBits) {
        history = history.subarray(history.length - (1 << windowBits));
      }
      return out;
    };
    const parseFrames = () => {
      for (;;) {
        if (buffered.length < 2) return;
        const b0 = buffered[0]!;
        const b1 = buffered[1]!;
        let length = b1 & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffered.length < 4) return;
          length = buffered.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffered.length < 10) return;
          length = buffered.readUInt32BE(2) * 2 ** 32 + buffered.readUInt32BE(6);
          offset = 10;
        }
        if (buffered.length < offset + length) return;
        const payload = Buffer.from(buffered.subarray(offset, offset + length));
        buffered = buffered.subarray(offset + length);
        const opcode = b0 & 0x0f;
        if ((b0 & 0x80) === 0 || (b1 & 0x80) !== 0) {
          client.errors.push("fragmented or masked server frame");
          continue;
        }
        if (opcode !== 1) {
          continue;
        }
        const compressed = (b0 & 0x40) !== 0;
        try {
          const bytes = compressed ? inflate(payload) : payload;
          const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          client.messages.push({ compressed, wire: payload, text });
        } catch (error) {
          client.errors.push(String(error));
          client.messages.push({ compressed, wire: payload, text: "<undecodable>" });
        }
      }
    };
    socket.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (!upgraded) {
        const end = buffered.indexOf("\r\n\r\n");
        if (end === -1) return;
        const head = buffered.subarray(0, end).toString("latin1");
        buffered = buffered.subarray(end + 4);
        if (!head.startsWith("HTTP/1.1 101")) {
          reject(new Error(head));
          return;
        }
        upgraded = true;
        client.negotiated =
          /sec-websocket-extensions: *(.*)/i.exec(head)?.[1]?.trim() ?? "";
        const bits = /server_max_window_bits=(\d+)/.exec(client.negotiated);
        if (bits) windowBits = Number(bits[1]);
        if (options.paused) socket.pause();
        resolve(client);
      }
      parseFrames();
    });
  });
}

interface Harness {
  wss: WebSocketServer;
  port: number;
  serverSockets: WebSocket[];
  waitForSockets(count: number): Promise<void>;
  close(): Promise<void>;
}

async function startServer(
  perMessageDeflate: PerMessageDeflateOptions | false = WS_PER_MESSAGE_DEFLATE,
): Promise<Harness> {
  const wss = new WebSocketServer({
    port: 0,
    host: "127.0.0.1",
    perMessageDeflate,
  });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  const serverSockets: WebSocket[] = [];
  wss.on("connection", (socket) => serverSockets.push(socket));
  return {
    wss,
    port: (wss.address() as AddressInfo).port,
    serverSockets,
    async waitForSockets(count) {
      while (serverSockets.length < count) {
        await new Promise((r) => setTimeout(r, 5));
      }
    },
    close() {
      for (const socket of serverSockets) socket.terminate();
      return new Promise((resolve) => wss.close(() => resolve()));
    },
  };
}

interface WsClient {
  socket: WebSocket;
  messages: string[];
  errors: string[];
}

async function wsClient(
  port: number,
  perMessageDeflate: boolean | PerMessageDeflateOptions = true,
): Promise<WsClient> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`, { perMessageDeflate });
  const client: WsClient = { socket, messages: [], errors: [] };
  socket.on("message", (data, isBinary) => {
    if (isBinary) client.errors.push("binary frame");
    client.messages.push(data.toString());
  });
  socket.on("error", (error) => client.errors.push(String(error)));
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  return client;
}

async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A roster-shaped frame: repetitive keys, random ids, about `people * 360` B. */
function rosterFrame(seq: number, people: number): { type: string; seq: number } & Record<string, unknown> {
  const participants = [];
  for (let i = 0; i < people; i += 1) {
    participants.push({
      peerId: randomBytes(16).toString("hex"),
      userId: randomBytes(16).toString("hex"),
      displayName: `player_${randomBytes(4).toString("hex")}`,
      avatarUrl: `https://img.example/${randomBytes(13).toString("hex")}`,
      muted: i % 3 === 0,
      deafened: false,
      canSpeak: true,
      handRaisedAt: i % 4 === 0 ? 1_700_000_000_000 + i : null,
    });
  }
  return { type: "voice-roster", seq, participants };
}

const flagOn = () => {
  process.env.WS_SHARED_DEFLATE = "true";
};

afterEach(() => {
  flagOn();
  setSharedDeflateUnauditedForTests(false);
});

describe("the ws internals the shared path reads", () => {
  it("were audited for the installed ws version", () => {
    // If this fails, ws was bumped. Re-read lib/sender.js (`_state`, `_queue`,
    // `_firstFragment`, `sendFrame`, `dispatch`) and lib/permessage-deflate.js
    // (`params`, `_threshold`, `_options`, `_compress` resetting the deflater
    // under `server_no_context_takeover`), then add the minor to
    // AUDITED_WS_MINORS. Until then the shared path is off by itself.
    const minor = INSTALLED_WS_VERSION?.split(".").slice(0, 2).join(".");
    expect(AUDITED_WS_MINORS).toContain(minor);
  });

  it("frames a header the way RFC 6455 says, at all three length encodings", () => {
    expect([...compressedTextFrameHeader(5)]).toEqual([0xc1, 5]);
    expect([...compressedTextFrameHeader(300)]).toEqual([0xc1, 126, 0x01, 0x2c]);
    expect([...compressedTextFrameHeader(70_000)]).toEqual([
      0xc1, 127, 0, 0, 0, 0, 0, 0x01, 0x11, 0x70,
    ]);
  });
});

describe("broadcastEncoded with ws_shared_deflate on", () => {
  let harness: Harness;
  beforeAll(async () => {
    harness = await startServer();
  });
  afterAll(async () => {
    await harness.close();
  });

  it("writes exactly the bytes ws's own per-socket compression writes", async () => {
    const before = harness.serverSockets.length;
    const raws: RawClient[] = [];
    for (let i = 0; i < SHARED_DEFLATE_MIN_RECIPIENTS; i += 1) {
      raws.push(await rawClient(harness.port, "permessage-deflate; client_max_window_bits", "takeover"));
    }
    await harness.waitForSockets(before + raws.length);
    const sockets = harness.serverSockets.slice(before);
    const frame = encodeFrame(rosterFrame(1, 250));

    process.env.WS_SHARED_DEFLATE = "false";
    resetSharedDeflateStats();
    broadcastEncoded(sockets, frame);
    await Promise.all(raws.map((raw) => raw.waitForCount(1)));
    expect(sharedDeflateStats().sockets).toBe(0);

    flagOn();
    broadcastEncoded(sockets, frame);
    await Promise.all(raws.map((raw) => raw.waitForCount(2)));
    const stats = sharedDeflateStats();
    expect(stats.sockets).toBe(raws.length);
    expect(stats.compressions).toBe(1);
    expect(stats.compressionsAvoided).toBe(raws.length - 1);
    expect(stats.broadcasts).toBe(1);

    for (const raw of raws) {
      expect(raw.errors).toEqual([]);
      const [viaWs, viaShared] = raw.messages;
      expect(viaWs!.compressed).toBe(true);
      expect(viaShared!.compressed).toBe(true);
      // Byte for byte: the shared path is not "a valid frame", it is the
      // same frame.
      expect(viaShared!.wire.equals(viaWs!.wire)).toBe(true);
      expect(viaShared!.text).toBe(frame.toString());
      raw.socket.destroy();
    }
  });

  it("serves a mixed population: plain, reset, takeover, a smaller window, and ws clients", async () => {
    const before = harness.serverSockets.length;
    const raws = [
      await rawClient(harness.port, null, "reset"),
      await rawClient(harness.port, "permessage-deflate", "takeover"),
      await rawClient(harness.port, "permessage-deflate; client_max_window_bits", "reset"),
      await rawClient(harness.port, "permessage-deflate; server_no_context_takeover", "takeover"),
      await rawClient(harness.port, "permessage-deflate; server_max_window_bits=10", "takeover"),
      await rawClient(harness.port, "permessage-deflate; server_max_window_bits=10", "reset"),
    ];
    const wsClients = [
      await wsClient(harness.port, true),
      await wsClient(harness.port, false),
      await wsClient(harness.port, { serverNoContextTakeover: true }),
      await wsClient(harness.port, { serverMaxWindowBits: 12 }),
    ];
    await harness.waitForSockets(before + raws.length + wsClients.length);
    const sockets = harness.serverSockets.slice(before);
    expect(raws[0]!.negotiated).toBe("");
    expect(raws[4]!.negotiated).toContain("server_max_window_bits=10");
    for (const raw of raws.slice(1)) {
      expect(raw.negotiated).toContain("server_no_context_takeover");
    }

    resetSharedDeflateStats();
    const sent: string[] = [];
    for (let seq = 0; seq < 6; seq += 1) {
      const frame = encodeFrame(rosterFrame(seq, 40 + seq * 30));
      sent.push(frame.toString());
      broadcastEncoded(sockets, frame);
    }
    await Promise.all(raws.map((raw) => raw.waitForCount(6)));
    await until(() => wsClients.every((client) => client.messages.length >= 6));

    for (const raw of raws) {
      expect(raw.errors).toEqual([]);
      expect(raw.messages.map((m) => m.text)).toEqual(sent);
    }
    expect(raws[0]!.messages.every((m) => !m.compressed)).toBe(true);
    expect(raws[1]!.messages.every((m) => m.compressed)).toBe(true);
    for (const client of wsClients) {
      expect(client.errors).toEqual([]);
      expect(client.messages).toEqual(sent);
    }
    const stats = sharedDeflateStats();
    // Three window sizes (15, 12 and 10), so three compressions per
    // broadcast and no more.
    expect(stats.compressions).toBe(18);
    expect(stats.plainSockets).toBe(6 * 2);
    expect(stats.sockets).toBe(6 * 8);
    expect(stats.fallbacks.senderBusy).toBe(0);
    for (const raw of raws) raw.socket.destroy();
    for (const client of wsClients) client.socket.terminate();
  });

  it("keeps per-socket order when shared broadcasts and ordinary sends interleave, both ways", async () => {
    const before = harness.serverSockets.length;
    const raws: RawClient[] = [];
    const wsClients: WsClient[] = [];
    for (let i = 0; i < 6; i += 1) {
      raws.push(await rawClient(harness.port, "permessage-deflate", "takeover"));
      raws.push(await rawClient(harness.port, "permessage-deflate; client_max_window_bits", "reset"));
      wsClients.push(await wsClient(harness.port, true));
    }
    raws.push(await rawClient(harness.port, null, "reset"));
    await harness.waitForSockets(before + raws.length + wsClients.length);
    const sockets = harness.serverSockets.slice(before);
    resetSharedDeflateStats();

    // Per socket, the list of texts it must receive, in this order.
    const expected = sockets.map(() => [] as string[]);
    const big = (tag: string) => JSON.stringify({ tag, pad: rosterFrame(0, 20) });
    const small = (tag: string) => JSON.stringify({ tag });
    const ordinary = (index: number, text: string) => {
      sockets[index]!.send(text);
      expected[index]!.push(text);
    };
    const broadcast = (text: string) => {
      broadcastEncoded(sockets, Buffer.from(text));
      for (const list of expected) list.push(text);
    };

    // Order A: an ordinary compressed send FIRST leaves the sender DEFLATING
    // (ws compresses on the thread pool), so the broadcast right behind it
    // must not overtake it: it falls back and queues.
    for (let i = 0; i < sockets.length; i += 2) ordinary(i, big(`ordinary-a-${i}`));
    broadcast(big("shared-a"));
    // Order B: the shared frame first, an ordinary compressed one right after,
    // which ws compresses with the deflater the shared path never touched.
    broadcast(big("shared-b"));
    for (let i = 0; i < sockets.length; i += 1) ordinary(i, big(`ordinary-b-${i}`));
    // Uncompressed ones in between, and a random tail of everything.
    broadcast(small("small-shared"));
    for (let round = 0; round < 40; round += 1) {
      const pick = Math.floor(Math.random() * 4);
      if (pick === 0) broadcast(big(`r${round}-big-shared`));
      else if (pick === 1) broadcast(small(`r${round}-small-shared`));
      else {
        const index = Math.floor(Math.random() * sockets.length);
        ordinary(index, pick === 2 ? big(`r${round}-big-${index}`) : small(`r${round}-small-${index}`));
      }
      if (round % 10 === 9) await new Promise((r) => setTimeout(r, 1));
    }

    const rawAt = (index: number) => raws[index];
    // The server sockets are in connection order: raw, raw, ws, ... then the
    // last raw.
    const received = (index: number): string[] => {
      const raw = index === sockets.length - 1 ? rawAt(raws.length - 1) : index % 3 === 2 ? null : rawAt(Math.floor(index / 3) * 2 + (index % 3));
      if (raw) return raw.messages.map((m) => m.text);
      return wsClients[Math.floor(index / 3)]!.messages;
    };
    await until(() => sockets.every((_, index) => received(index).length >= expected[index]!.length));
    for (let index = 0; index < sockets.length; index += 1) {
      expect(received(index)).toEqual(expected[index]);
    }
    for (const raw of raws) expect(raw.errors).toEqual([]);
    for (const client of wsClients) expect(client.errors).toEqual([]);
    const stats = sharedDeflateStats();
    expect(stats.sockets).toBeGreaterThan(0);
    // Order A guarantees at least the sockets that had an ordinary send in
    // flight were refused the shared write.
    expect(stats.fallbacks.senderBusy).toBeGreaterThan(0);
    for (const raw of raws) raw.socket.destroy();
    for (const client of wsClients) client.socket.terminate();
  });

  it("respects backpressure: a paused client's frames are dropped past the threshold and the rest decode in order", async () => {
    const before = harness.serverSockets.length;
    const slow = await rawClient(harness.port, "permessage-deflate", "takeover", { paused: true });
    const fast: RawClient[] = [];
    for (let i = 0; i < SHARED_DEFLATE_MIN_RECIPIENTS; i += 1) {
      fast.push(await rawClient(harness.port, "permessage-deflate", "takeover"));
    }
    await harness.waitForSockets(before + 1 + fast.length);
    const sockets = harness.serverSockets.slice(before);
    const slowServer = sockets[0]!;
    resetSharedDeflateStats();

    // Barely compressible, so the slow socket's buffer fills in a few frames.
    const frames = Array.from({ length: 40 }, (_, seq) =>
      encodeFrame({ type: "voice-roster", seq, noise: randomBytes(48_000).toString("base64") }),
    );
    const slowGot: number[] = [];
    let maxBuffered = 0;
    for (let seq = 0; seq < frames.length; seq += 1) {
      broadcastEncoded(sockets, frames[seq]!, {
        droppable: true,
        onSent: (socket) => {
          if (socket === slowServer) slowGot.push(seq);
        },
      });
      maxBuffered = Math.max(maxBuffered, slowServer.bufferedAmount);
      // A message is never droppable: it queues behind the shared frames.
      if (seq === 30) slowServer.send(JSON.stringify({ type: "message", seq }));
      // Let the fast clients read; only the paused one should back up.
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(maxBuffered).toBeGreaterThan(1024 * 1024);
    expect(slowGot.length).toBeLessThan(frames.length);
    // What the shared path wrote is visible to bufferedAmount immediately.
    expect(sharedDeflateStats().sockets).toBeGreaterThan(fast.length * 10);

    await Promise.all(fast.map((raw) => raw.waitForCount(frames.length)));
    for (const raw of fast) {
      expect(raw.errors).toEqual([]);
      expect(raw.messages.map((m) => JSON.parse(m.text).seq)).toEqual(frames.map((_, seq) => seq));
    }
    slow.socket.resume();
    await slow.waitForCount(slowGot.length + 1);
    expect(slow.errors).toEqual([]);
    const order = slow.messages.map((m) => JSON.parse(m.text) as { type: string; seq: number });
    expect(order.filter((m) => m.type === "voice-roster").map((m) => m.seq)).toEqual(slowGot);
    const messageAt = order.findIndex((m) => m.type === "message");
    expect(messageAt).toBe(slowGot.filter((seq) => seq <= 30).length);
    for (const raw of [slow, ...fast]) raw.socket.destroy();
  });

  it("leaves tiny frames and small audiences on the ordinary path", async () => {
    const before = harness.serverSockets.length;
    const raws: RawClient[] = [];
    for (let i = 0; i < SHARED_DEFLATE_MIN_RECIPIENTS; i += 1) {
      raws.push(await rawClient(harness.port, "permessage-deflate", "takeover"));
    }
    await harness.waitForSockets(before + raws.length);
    const sockets = harness.serverSockets.slice(before);
    resetSharedDeflateStats();
    const tiny = encodeFrame({ type: "pong" });
    broadcastEncoded(sockets, tiny);
    const big = encodeFrame(rosterFrame(1, 30));
    broadcastEncoded(sockets.slice(0, SHARED_DEFLATE_MIN_RECIPIENTS - 1), big);
    await Promise.all(raws.map((raw, i) => raw.waitForCount(i < SHARED_DEFLATE_MIN_RECIPIENTS - 1 ? 2 : 1)));
    const stats = sharedDeflateStats();
    expect(stats.sockets).toBe(0);
    expect(stats.compressions).toBe(0);
    expect(stats.skipped.fewRecipients).toBe(1);
    for (const raw of raws) {
      expect(raw.errors).toEqual([]);
      expect(raw.messages[0]).toMatchObject({ compressed: false, text: tiny.toString() });
      raw.socket.destroy();
    }
    // Compressed by ws itself, per socket, as before.
    expect(raws[0]!.messages[1]).toMatchObject({ compressed: true, text: big.toString() });
  });

  it("turns itself off, per socket, when the ws version was not audited", async () => {
    const before = harness.serverSockets.length;
    const raws: RawClient[] = [];
    for (let i = 0; i < SHARED_DEFLATE_MIN_RECIPIENTS; i += 1) {
      raws.push(await rawClient(harness.port, "permessage-deflate", "takeover"));
    }
    await harness.waitForSockets(before + raws.length);
    const sockets = harness.serverSockets.slice(before);
    resetSharedDeflateStats();
    setSharedDeflateUnauditedForTests(true);
    const frame = encodeFrame(rosterFrame(1, 30));
    broadcastEncoded(sockets, frame);
    await Promise.all(raws.map((raw) => raw.waitForCount(1)));
    expect(sharedDeflateStats().fallbacks.wsInternals).toBe(raws.length);
    expect(sharedDeflateStats().compressions).toBe(0);
    for (const raw of raws) {
      expect(raw.messages[0]).toMatchObject({ compressed: true, text: frame.toString() });
      raw.socket.destroy();
    }
  });

  it("fans out to 600 sockets of every kind and every one decodes every frame", async () => {
    const before = harness.serverSockets.length;
    const raws: RawClient[] = [];
    const wsClients: WsClient[] = [];
    let connects: Promise<unknown>[] = [];
    for (let i = 0; i < 600; i += 1) {
      // In batches: a listen backlog is 128 on macOS.
      if (connects.length === 50) {
        await Promise.all(connects);
        connects = [];
      }
      const kind = i % 6;
      if (kind === 0) connects.push(wsClient(harness.port, false).then((c) => wsClients.push(c)));
      else if (kind < 3) connects.push(wsClient(harness.port, true).then((c) => wsClients.push(c)));
      else if (kind === 3) connects.push(rawClient(harness.port, "permessage-deflate", "takeover").then((c) => raws.push(c)));
      else if (kind === 4) connects.push(rawClient(harness.port, "permessage-deflate; client_max_window_bits", "reset").then((c) => raws.push(c)));
      else connects.push(rawClient(harness.port, "permessage-deflate; server_max_window_bits=11", "takeover").then((c) => raws.push(c)));
    }
    await Promise.all(connects);
    await harness.waitForSockets(before + 600);
    const sockets = harness.serverSockets.slice(before);
    resetSharedDeflateStats();

    const sent: string[] = [];
    for (let seq = 0; seq < 5; seq += 1) {
      const big = encodeFrame(rosterFrame(seq, 250));
      const small = encodeFrame({ type: "typing", seq });
      sent.push(big.toString(), small.toString());
      broadcastEncoded(sockets, big, { droppable: true });
      broadcastEncoded(sockets, small);
    }
    await until(
      () =>
        raws.every((raw) => raw.messages.length >= sent.length) &&
        wsClients.every((client) => client.messages.length >= sent.length),
      30_000,
    );
    for (const raw of raws) {
      expect(raw.errors).toEqual([]);
      expect(raw.messages.map((m) => m.text)).toEqual(sent);
    }
    for (const client of wsClients) {
      expect(client.errors).toEqual([]);
      expect(client.messages).toEqual(sent);
    }
    const stats = sharedDeflateStats();
    expect(stats.broadcasts).toBe(5);
    expect(stats.sockets).toBe(5 * 500);
    expect(stats.plainSockets).toBe(5 * 100);
    expect(stats.compressions).toBe(5 * 2);
    expect(stats.fallbacks.senderBusy).toBe(0);
    for (const raw of raws) raw.socket.destroy();
    for (const client of wsClients) client.socket.terminate();
  }, 60_000);
});

describe("a server that kept context takeover", () => {
  let harness: Harness;
  beforeAll(async () => {
    harness = await startServer({
      ...WS_PER_MESSAGE_DEFLATE,
      serverNoContextTakeover: false,
      clientNoContextTakeover: false,
    });
  });
  afterAll(async () => {
    await harness.close();
  });

  it("is refused the shared path, socket by socket, and decodes as before", async () => {
    const before = harness.serverSockets.length;
    const raws: RawClient[] = [];
    for (let i = 0; i < SHARED_DEFLATE_MIN_RECIPIENTS; i += 1) {
      raws.push(await rawClient(harness.port, "permessage-deflate", "takeover"));
    }
    await harness.waitForSockets(before + raws.length);
    const sockets = harness.serverSockets.slice(before);
    expect(raws[0]!.negotiated).not.toContain("server_no_context_takeover");
    resetSharedDeflateStats();
    const sent: string[] = [];
    for (let seq = 0; seq < 4; seq += 1) {
      const frame = encodeFrame(rosterFrame(1, 30));
      sent.push(frame.toString());
      broadcastEncoded(sockets, frame);
    }
    await Promise.all(raws.map((raw) => raw.waitForCount(4)));
    expect(sharedDeflateStats().fallbacks.contextTakeover).toBe(4 * raws.length);
    expect(sharedDeflateStats().sockets).toBe(0);
    for (const raw of raws) {
      expect(raw.errors).toEqual([]);
      expect(raw.messages.map((m) => m.text)).toEqual(sent);
      raw.socket.destroy();
    }
  });

  it("NEGATIVE CONTROL: writing a fresh-context frame around that deflater corrupts the next message", async () => {
    // This is what the `contextTakeover` refusal prevents, shown happening,
    // so the takeover receiver above is known to catch it.
    const before = harness.serverSockets.length;
    const raw = await rawClient(harness.port, "permessage-deflate", "takeover");
    await harness.waitForSockets(before + 1);
    const server = harness.serverSockets[before]!;
    const a = JSON.stringify(rosterFrame(1, 20));
    server.send(a);
    await raw.waitForCount(1);
    const injected = zlib.deflateRawSync(Buffer.from(JSON.stringify(rosterFrame(2, 20))), {
      finishFlush: zlib.constants.Z_SYNC_FLUSH,
    });
    const body = injected.subarray(0, injected.length - 4);
    (server as unknown as { _sender: { sendFrame(list: Buffer[]): void } })._sender.sendFrame([
      compressedTextFrameHeader(body.length),
      body,
    ]);
    // The same text again: ws's deflater, which never saw the injected frame,
    // encodes it as one long back-reference into what it thinks is `a`.
    server.send(a);
    await raw.waitForCount(3);
    expect(raw.messages[1]!.text).not.toBe("<undecodable>");
    expect(raw.messages[2]!.text).not.toBe(a);
    raw.socket.destroy();
  });
});
