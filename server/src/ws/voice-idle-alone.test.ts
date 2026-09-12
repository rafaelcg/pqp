import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { DbUser } from "../db.js";

/**
 * THE IDLE HANGUP: ALONE FOR TEN MINUTES, WARNED AT NINE, DISCONNECTED AT TEN.
 *
 * What is pinned here:
 *  - a room with two people never starts the clock;
 *  - the last person left behind is warned once, a minute before the limit,
 *    and released at it through the moderator's disconnect path (so the
 *    frame that reaches them is the `voice-moderation` notice, with
 *    `reason: "idle"` so the client can say it in Portuguese);
 *  - the warning's button (`voice-still-here`) starts the clock over, and
 *    so does any self-initiated frame, such as a mute toggle;
 *  - somebody joining cancels a pending warning silently;
 *  - `VOICE_IDLE_ALONE_MINUTES=0` turns the whole thing off.
 *
 * Registry off, production's single-instance shape. `now` is passed to the
 * sweep rather than faked system-wide, except where the reset path reads
 * the real clock (it uses `Date.now()`), which is what the fake timers are
 * for.
 */

vi.mock("../voice/backends.js", () => ({
  getServerVoiceBackend: () => "mesh",
  isLiveKitConfigured: () => false,
}));

vi.mock("../services/users.js", () => ({
  resolveMemberName: async (
    _serverId: string | null,
    user: { display_name: string },
  ) => user.display_name,
  canAccessChannel: async () => true,
}));

vi.mock("../services/sanctions.js", () => ({
  findTimeoutForChannel: async () => null,
  timeoutMessage: () => "",
}));

vi.mock("../services/dms.js", () => ({
  isDmSendBlocked: async () => false,
}));

vi.mock("../services/servers.js", () => ({
  getChannel: async () => ({ kind: "server", type: "voice" }),
  getChannelAudience: async () => ({
    serverId: null,
    kind: "server",
    has: () => true,
  }),
}));

vi.mock("../voice/admin.js", () => ({
  evictSfuRoom: vi.fn(() => Promise.resolve()),
  evictSfuUser: vi.fn(() => Promise.resolve()),
  evictSfuUsersExcept: vi.fn(() => Promise.resolve()),
  tickSfuResweeps: vi.fn(() => Promise.resolve(0)),
}));

const {
  handleVoiceMessage,
  resetVoicePeers,
  resetVoiceRateLimits,
  resetVoiceRoomTransports,
  sweepIdleAloneSeats,
} = await import("./voice.js");
const { setCoalesceImmediate } = await import("./fanout.js");
setCoalesceImmediate(true);
const { deleteAuthenticatedSocket, setAuthenticatedSocket } = await import(
  "./sockets.js"
);

interface Frame {
  type: string;
  [key: string]: unknown;
}

interface Recorder {
  socket: WebSocket;
  frames: Frame[];
}

const open: Recorder[] = [];

function recorder(): Recorder {
  const frames: Frame[] = [];
  const socket = {
    readyState: 1,
    send: (payload: string) => frames.push(JSON.parse(payload) as Frame),
    on: () => {},
  } as unknown as WebSocket;
  const rec = { socket, frames };
  open.push(rec);
  return rec;
}

function asUser(id: string): DbUser {
  return {
    id,
    display_name: `User ${id.slice(0, 8)}`,
    avatar_url: null,
  } as unknown as DbUser;
}

const MINUTE = 60_000;
const T0 = 1_800_000_000_000;

const previousClerk = process.env.CLERK_SECRET_KEY;
const previousLimit = process.env.VOICE_IDLE_ALONE_MINUTES;

beforeEach(() => {
  process.env.CLERK_SECRET_KEY = "sk_test_voice_idle";
  delete process.env.VOICE_IDLE_ALONE_MINUTES;
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  resetVoicePeers();
  resetVoiceRateLimits();
  resetVoiceRoomTransports();
});

afterEach(() => {
  process.env.CLERK_SECRET_KEY = previousClerk;
  if (previousLimit === undefined) {
    delete process.env.VOICE_IDLE_ALONE_MINUTES;
  } else {
    process.env.VOICE_IDLE_ALONE_MINUTES = previousLimit;
  }
  for (const rec of open.splice(0)) {
    deleteAuthenticatedSocket(rec.socket);
  }
  resetVoicePeers();
  vi.useRealTimers();
});

async function join(userId: string, channel: string): Promise<Recorder> {
  const rec = recorder();
  const user = asUser(userId);
  setAuthenticatedSocket(rec.socket, user);
  await handleVoiceMessage(
    { socket: rec.socket, user },
    { type: "join-voice-room", voiceChannelId: channel, resume: true },
  );
  if (!rec.frames.some((f) => f.type === "welcome")) {
    throw new Error(`join refused: ${JSON.stringify(rec.frames)}`);
  }
  return rec;
}

async function leave(rec: Recorder, userId: string) {
  await handleVoiceMessage(
    { socket: rec.socket, user: asUser(userId) },
    { type: "leave-voice-room" },
  );
}

function warnings(rec: Recorder): Frame[] {
  return rec.frames.filter((f) => f.type === "voice-idle-warning");
}

function hangups(rec: Recorder): Frame[] {
  return rec.frames.filter(
    (f) => f.type === "voice-moderation" && f.action === "disconnected",
  );
}

describe("idle hangup", () => {
  it("leaves a two-person room alone forever", async () => {
    const channel = randomUUID();
    const a = await join(randomUUID(), channel);
    const b = await join(randomUUID(), channel);
    for (const minutes of [0, 5, 9, 10, 60]) {
      await sweepIdleAloneSeats(T0 + minutes * MINUTE);
    }
    expect(warnings(a)).toHaveLength(0);
    expect(warnings(b)).toHaveLength(0);
    expect(hangups(a)).toHaveLength(0);
    expect(hangups(b)).toHaveLength(0);
  });

  it("warns the last person at nine minutes and hangs up at ten", async () => {
    const channel = randomUUID();
    const alice = randomUUID();
    const a = await join(alice, channel);
    const bobId = randomUUID();
    const b = await join(bobId, channel);
    await leave(b, bobId);

    await sweepIdleAloneSeats(T0); // clock starts
    await sweepIdleAloneSeats(T0 + 8 * MINUTE);
    expect(warnings(a)).toHaveLength(0);

    await sweepIdleAloneSeats(T0 + 9 * MINUTE);
    expect(warnings(a)).toHaveLength(1);
    expect(warnings(a)[0]).toMatchObject({
      voiceChannelId: channel,
      disconnectAt: T0 + 10 * MINUTE,
    });
    // One warning per stretch, however many ticks pass inside the window.
    await sweepIdleAloneSeats(T0 + 9.5 * MINUTE);
    expect(warnings(a)).toHaveLength(1);
    expect(hangups(a)).toHaveLength(0);

    await sweepIdleAloneSeats(T0 + 10 * MINUTE);
    expect(hangups(a)).toHaveLength(1);
    expect(hangups(a)[0]).toMatchObject({
      voiceChannelId: channel,
      reason: "idle",
    });
    expect(typeof hangups(a)[0]!.message).toBe("string");

    // The seat is gone: a further tick has nothing to say.
    await sweepIdleAloneSeats(T0 + 20 * MINUTE);
    expect(hangups(a)).toHaveLength(1);
  });

  it("starts over when the person answers the warning", async () => {
    const channel = randomUUID();
    const alice = randomUUID();
    const a = await join(alice, channel);

    await sweepIdleAloneSeats(T0);
    await sweepIdleAloneSeats(T0 + 9 * MINUTE);
    expect(warnings(a)).toHaveLength(1);

    vi.setSystemTime(T0 + 9.5 * MINUTE);
    await handleVoiceMessage(
      { socket: a.socket, user: asUser(alice) },
      { type: "voice-still-here" },
    );

    await sweepIdleAloneSeats(T0 + 10 * MINUTE);
    await sweepIdleAloneSeats(T0 + 18 * MINUTE);
    expect(hangups(a)).toHaveLength(0);
    expect(warnings(a)).toHaveLength(1);

    // Nine minutes after the answer: warned again; ten: gone.
    await sweepIdleAloneSeats(T0 + 18.5 * MINUTE);
    expect(warnings(a)).toHaveLength(2);
    await sweepIdleAloneSeats(T0 + 19.5 * MINUTE);
    expect(hangups(a)).toHaveLength(1);
  });

  it("counts a mute toggle as being there", async () => {
    const channel = randomUUID();
    const alice = randomUUID();
    const a = await join(alice, channel);

    await sweepIdleAloneSeats(T0);
    vi.setSystemTime(T0 + 8 * MINUTE);
    await handleVoiceMessage(
      { socket: a.socket, user: asUser(alice) },
      { type: "set-voice-state", muted: true, deafened: false },
    );
    await sweepIdleAloneSeats(T0 + 10 * MINUTE);
    expect(warnings(a)).toHaveLength(0);
    expect(hangups(a)).toHaveLength(0);
  });

  it("forgets a pending warning when somebody joins", async () => {
    const channel = randomUUID();
    const alice = randomUUID();
    const a = await join(alice, channel);

    await sweepIdleAloneSeats(T0);
    await sweepIdleAloneSeats(T0 + 9 * MINUTE);
    expect(warnings(a)).toHaveLength(1);

    const bobId = randomUUID();
    const b = await join(bobId, channel);
    await sweepIdleAloneSeats(T0 + 10 * MINUTE);
    await sweepIdleAloneSeats(T0 + 30 * MINUTE);
    expect(hangups(a)).toHaveLength(0);

    // Bob leaves: a fresh ten minutes, not the remainder of the old stretch.
    await leave(b, bobId);
    await sweepIdleAloneSeats(T0 + 31 * MINUTE);
    await sweepIdleAloneSeats(T0 + 39 * MINUTE);
    expect(warnings(a)).toHaveLength(1);
    await sweepIdleAloneSeats(T0 + 40 * MINUTE);
    expect(warnings(a)).toHaveLength(2);
    await sweepIdleAloneSeats(T0 + 41 * MINUTE);
    expect(hangups(a)).toHaveLength(1);
  });

  it("is off at VOICE_IDLE_ALONE_MINUTES=0", async () => {
    process.env.VOICE_IDLE_ALONE_MINUTES = "0";
    const channel = randomUUID();
    const a = await join(randomUUID(), channel);
    await sweepIdleAloneSeats(T0);
    await sweepIdleAloneSeats(T0 + 600 * MINUTE);
    expect(warnings(a)).toHaveLength(0);
    expect(hangups(a)).toHaveLength(0);
  });
});
