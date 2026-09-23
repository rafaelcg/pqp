import { randomUUID } from "node:crypto";
import { MESH_VOICE_LIMIT } from "@pqp/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { RELAY_BUDGET } from "./frame-budget.js";

/**
 * The per-connection flood guard, driven through the real router.
 *
 * Production closed 11 sockets with 4429 in the week to 2026-09-23, every one
 * whose close was logged was in voice, and several went within a second of a
 * reconnect: the guard was sized for a human and mesh signaling is a browser.
 * This pins both halves of the fix end to end: a full mesh room's join with
 * production-sized trickle ICE keeps its socket, and a flood still loses it.
 *
 * No database: auth, both handlers and the status registry are faked, the same
 * way `routing.test.ts` does it.
 */

const chatFrames: unknown[] = [];
const voiceFrames: unknown[] = [];
const events: { event: string; fields: Record<string, unknown> }[] = [];

vi.mock("../lib/log.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/log.js")>();
  return {
    ...actual,
    logEvent: (event: string, fields: Record<string, unknown> = {}) => {
      events.push({ event, fields });
    },
  };
});

vi.mock("../auth/clerk.js", () => ({
  DEV_AUTH_TOKEN: "dev-local-token",
  isDevAuthBypassEnabled: () => false,
  resolveAuthUser: async () => ({
    user: { id: "00000000-0000-4000-8000-000000000001", clerk_id: "clerk_1" },
  }),
}));

vi.mock("./chat.js", () => ({
  handleChatMessage: async (_conn: unknown, payload: unknown) => {
    chatFrames.push(payload);
  },
}));

vi.mock("./voice.js", () => ({
  handleVoiceMessage: async (_conn: unknown, payload: unknown) => {
    voiceFrames.push(payload);
  },
  isSocketInVoice: () => true,
  removeVoicePeerBySocket: () => {},
  sendAllVoiceRosters: async () => {},
}));

vi.mock("./status.js", () => ({
  registerStatusSocket: async () => {},
  unregisterStatusSocket: () => {},
}));

const { handleWsConnection } = await import("./index.js");

function fakeSocket() {
  const handlers = new Map<string, (...args: never[]) => void>();
  const sent: string[] = [];
  const closes: number[] = [];

  const socket = {
    readyState: 1,
    send: (payload: string) => {
      sent.push(payload);
    },
    ping: () => {},
    terminate: () => {},
    close: (code: number) => {
      closes.push(code);
      socket.readyState = 3;
    },
    on: (event: string, fn: (...args: never[]) => void) => {
      handlers.set(event, fn);
      return socket;
    },
  };

  return {
    socket: socket as unknown as WebSocket,
    sent,
    closes,
    deliver: (frame: unknown) => {
      handlers.get("message")?.(JSON.stringify(frame) as never);
    },
    deliverRaw: (raw: string) => {
      handlers.get("message")?.(raw as never);
    },
  };
}

async function connected() {
  // Freeze the clock the buckets read, so an exact count is exact: a slow
  // runner otherwise refills a token between two frames. Only `Date`, so
  // `setImmediate` keeps running, and `drain` rather than `vi.waitFor`,
  // which advances fake time by its polling interval.
  vi.useFakeTimers({ toFake: ["Date"] });
  const fake = fakeSocket();
  handleWsConnection(fake.socket, `test-${randomUUID()}`);
  fake.deliver({ type: "auth", token: "any" });
  await drain();
  expect(fake.sent.some((raw) => raw.includes('"ready"'))).toBe(true);
  return fake;
}

/** Let every queued frame through the socket's ordering chain. */
async function drain() {
  for (let i = 0; i < 50; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const PEER_ID = randomUUID();

function candidate(to: string, n: number | null) {
  return {
    type: "ice-candidate",
    from: PEER_ID,
    to,
    candidate:
      n === null
        ? null
        : {
            candidate: `candidate:${n} 1 udp 2122260223 192.0.2.${n % 250} ${50_000 + n} typ relay`,
            sdpMid: "0",
            sdpMLineIndex: 0,
          },
  };
}

describe("per-connection flood guard", () => {
  beforeEach(() => {
    chatFrames.length = 0;
    voiceFrames.length = 0;
    events.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the socket of a browser joining a full mesh room with trickle ICE", async () => {
    const fake = await connected();
    const channelId = randomUUID();
    fake.deliver({ type: "join-channel", channelId });
    fake.deliver({ type: "join-voice-room", voiceChannelId: channelId });
    fake.deliver({ type: "set-voice-state", muted: false, deafened: false });
    // A reconnect flush's first burst lands in the same second.
    for (let i = 0; i < 30; i += 1) {
      fake.deliver({ type: "typing", channelId });
    }
    const others = Array.from({ length: MESH_VOICE_LIMIT - 1 }, () => randomUUID());
    for (const to of others) {
      fake.deliver({ type: "offer", from: PEER_ID, to, sdp: "v=0" });
      for (let n = 0; n < 30; n += 1) {
        fake.deliver(candidate(to, n));
      }
      fake.deliver(candidate(to, null));
    }
    await drain();

    expect(fake.closes).toEqual([]);
    expect(events.some((e) => e.event === "ws.flood")).toBe(false);
    // Every signaling frame reached the voice handler: none was dropped to
    // stay under a budget.
    expect(
      voiceFrames.filter((f) =>
        ["offer", "ice-candidate"].includes((f as { type: string }).type),
      ),
    ).toHaveLength(others.length * 32);
  });

  it("closes a socket flooding relay frames, once, and says what it was", async () => {
    const fake = await connected();
    const to = randomUUID();
    for (let n = 0; n < RELAY_BUDGET.capacity + 200; n += 1) {
      fake.deliver(candidate(to, n));
    }
    await drain();

    expect(fake.closes).toEqual([4429]);
    expect(voiceFrames).toHaveLength(RELAY_BUDGET.capacity);
    const floods = events.filter((e) => e.event === "ws.flood");
    // One line, not one per frame still in flight behind the close.
    expect(floods).toHaveLength(1);
    expect(floods[0]!.fields).toMatchObject({
      bucket: "relay",
      inVoice: true,
      userId: "00000000-0000-4000-8000-000000000001",
    });
    expect(String(floods[0]!.fields.recent)).toMatch(/^ice-candidate:\d+$/);
  });

  it("still closes a typing flood at the budget chat always had", async () => {
    const fake = await connected();
    const channelId = randomUUID();
    for (let i = 0; i < 200; i += 1) {
      fake.deliver({ type: "typing", channelId });
    }
    await drain();

    expect(fake.closes).toEqual([4429]);
    // `auth` spent one of the 60.
    expect(chatFrames).toHaveLength(59);
    const floods = events.filter((e) => e.event === "ws.flood");
    expect(floods).toHaveLength(1);
    expect(floods[0]!.fields.bucket).toBe("general");
  });

  it("does not let relay frames buy room for chat spam", async () => {
    const fake = await connected();
    const channelId = randomUUID();
    const to = randomUUID();
    for (let n = 0; n < 100; n += 1) {
      fake.deliver(candidate(to, n));
    }
    for (let i = 0; i < 200; i += 1) {
      fake.deliver({ type: "typing", channelId });
    }
    await drain();

    expect(fake.closes).toEqual([4429]);
    expect(chatFrames).toHaveLength(59);
  });

  it("charges frames that do not parse to the general bucket", async () => {
    const fake = await connected();
    for (let i = 0; i < 100; i += 1) {
      fake.deliverRaw("{not json");
    }
    await drain();

    expect(fake.closes).toEqual([4429]);
    expect(events.find((e) => e.event === "ws.flood")?.fields).toMatchObject({
      bucket: "general",
      recent: expect.stringContaining("unparsed:"),
    });
  });
});
