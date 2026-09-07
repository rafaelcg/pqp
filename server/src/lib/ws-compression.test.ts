import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";

import {
  WS_PER_MESSAGE_DEFLATE,
  wsCompressionEnabled,
  wsPerMessageDeflate,
} from "./ws-compression.js";

describe("wsCompressionEnabled", () => {
  it("is on when nothing is set, so a self-host gets the bandwidth win", () => {
    expect(wsCompressionEnabled({})).toBe(true);
  });

  it("is off for the rollback values an operator would reach for", () => {
    for (const value of ["off", "OFF", " off ", "false", "0"]) {
      expect(wsCompressionEnabled({ WS_COMPRESSION: value })).toBe(false);
    }
  });

  it("stays on for anything else, including the obvious on-values", () => {
    for (const value of ["on", "true", "1", "yes", ""]) {
      expect(wsCompressionEnabled({ WS_COMPRESSION: value })).toBe(true);
    }
  });

  it("hands ws its own `false` when off, which is the pre-compression wire", () => {
    expect(wsPerMessageDeflate({ WS_COMPRESSION: "off" })).toBe(false);
    expect(wsPerMessageDeflate({})).toBe(WS_PER_MESSAGE_DEFLATE);
  });
});

describe("the deflate options", () => {
  // These two assertions are the reason this file exists. Setting either key
  // to a number makes ws throw out of `acceptAsServer` for any client that did
  // not offer the matching parameter, and `websocket-server.js` turns that
  // throw into a 400 on the handshake. Measured, only Chromium offers
  // `client_max_window_bits`; Firefox, WebKit, iOS CFNetwork and Android
  // OkHttp all offer a bare `permessage-deflate`. A number here is therefore a
  // connection failure for four of the five stacks that reach this server,
  // which no compression ratio pays for.
  it("never pins a window-bits value, in either direction", () => {
    expect(WS_PER_MESSAGE_DEFLATE.serverMaxWindowBits).toBeUndefined();
    expect(WS_PER_MESSAGE_DEFLATE.clientMaxWindowBits).toBeUndefined();
  });

  it("disables context takeover, which is what makes `threshold` apply at all", () => {
    // ws only consults `threshold` when no-context-takeover is negotiated
    // (`sender.js`), so these three travel together: drop the takeover flags
    // and every 15-byte pong starts going through zlib.
    expect(WS_PER_MESSAGE_DEFLATE.serverNoContextTakeover).toBe(true);
    expect(WS_PER_MESSAGE_DEFLATE.clientNoContextTakeover).toBe(true);
    expect(WS_PER_MESSAGE_DEFLATE.threshold).toBeGreaterThan(0);
  });

  it("keeps zlib concurrency bounded", () => {
    // The `ws` README's memory-fragmentation warning is about unbounded
    // concurrent zlib on Linux. This is the bound.
    expect(WS_PER_MESSAGE_DEFLATE.concurrencyLimit).toBeGreaterThan(0);
    expect(WS_PER_MESSAGE_DEFLATE.concurrencyLimit).toBeLessThanOrEqual(64);
  });

  it("keeps the compression level and memLevel in the measured range", () => {
    const deflate = WS_PER_MESSAGE_DEFLATE.zlibDeflateOptions;
    // Level 3 was 92% of level 9's ratio for 27% of the time. Anything above
    // 6 spends real event-loop time for a fraction of a percent.
    expect(deflate?.level).toBeGreaterThanOrEqual(1);
    expect(deflate?.level).toBeLessThanOrEqual(6);
    // memLevel is the only per-socket memory lever that applies, because ws
    // overwrites `windowBits` with the negotiated value.
    expect(deflate?.memLevel).toBeGreaterThanOrEqual(5);
    expect(deflate?.memLevel).toBeLessThanOrEqual(8);
  });

  it("does not bother setting windowBits, which ws would overwrite anyway", () => {
    expect(
      WS_PER_MESSAGE_DEFLATE.zlibDeflateOptions?.windowBits,
    ).toBeUndefined();
  });
});

/**
 * The behaviour that actually ships, driven through a real `ws` server with the
 * real options, because the interesting parts of this feature live in the
 * handshake and none of them are visible in the option object.
 */
describe("negotiation against a real server", () => {
  let wss: WebSocketServer;
  let url: string;

  // Repetitive JSON shaped like a roster: a dozen field names repeated once per
  // participant is exactly the redundancy deflate is good at.
  const ROSTER = JSON.stringify({
    type: "voice-roster",
    participants: Array.from({ length: 60 }, (_, i) => ({
      peerId: `peer-${i}`,
      userId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      displayName: `Pessoa ${i}`,
      avatarUrl: null,
      sharingScreen: false,
      muted: false,
      deafened: false,
      serverMuted: false,
      canSpeak: true,
      canStream: true,
    })),
  });

  beforeAll(async () => {
    wss = new WebSocketServer({
      port: 0,
      perMessageDeflate: WS_PER_MESSAGE_DEFLATE,
      maxPayload: 128 * 1024,
    });
    wss.on("connection", (socket) => {
      socket.send(ROSTER);
    });
    await new Promise<void>((resolve) => wss.once("listening", resolve));
    url = `ws://localhost:${(wss.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  function connect(options: WebSocket.ClientOptions) {
    return new Promise<{ extensions: string; payload: string; wire: number }>(
      (resolve, reject) => {
        const ws = new WebSocket(url, options);
        const timer = setTimeout(() => reject(new Error("timed out")), 10_000);
        ws.on("message", (data) => {
          clearTimeout(timer);
          const raw = (ws as unknown as { _socket: { bytesRead: number } })
            ._socket;
          resolve({
            extensions: ws.extensions,
            payload: data.toString(),
            wire: raw.bytesRead,
          });
          ws.close();
        });
        ws.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
      },
    );
  }

  it("compresses for a client that offers the extension", async () => {
    const result = await connect({});
    expect(result.extensions).toContain("permessage-deflate");
    // What the application sees is the whole roster, unchanged.
    expect(JSON.parse(result.payload).participants).toHaveLength(60);
    // ... and it crossed the wire substantially smaller than it is.
    expect(result.wire).toBeLessThan(result.payload.length / 2);
  });

  it("serves a client that offers nothing, uncompressed, without failing", async () => {
    // The fallback requirement in one test: a stack with no permessage-deflate
    // must connect and work, not take a 400. `ws` only negotiates when the
    // request carries a `Sec-WebSocket-Extensions` header, so this is a
    // faithful stand-in for any client that does not implement the extension.
    const result = await connect({ perMessageDeflate: false });
    expect(result.extensions).toBe("");
    expect(JSON.parse(result.payload).participants).toHaveLength(60);
    // Uncompressed: the wire carries the payload plus framing, never less.
    expect(result.wire).toBeGreaterThanOrEqual(result.payload.length);
  });
});
