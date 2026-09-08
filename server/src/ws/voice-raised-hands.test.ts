import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { raisedHandQueue } from "@pqp/shared";
import type { DbUser } from "../db.js";

/**
 * RAISE YOUR HAND, AND THE ROOM AGREES ON THE QUEUE.
 *
 * Asked for in the QG: "levantar a mão e aí forma a fila de quem levantou
 * primeiro". These pin the server half, which is the half that has to be
 * right, because it is the only place the order is decided.
 *
 * What is here and nowhere else:
 *  - the order is the order the hands went up, and nothing anybody else does
 *    to their own hand reshuffles the ones above them;
 *  - the queue is carried by the roster, so a socket that joins mid-call is
 *    told the whole thing without asking;
 *  - a hand survives a resume inside the orphan window, because losing your
 *    place for a socket blip is the complaint this feature exists to answer;
 *  - leaving lowers it, because a queue full of people who have gone is worse
 *    than no queue at all;
 *  - and an emptied room forgets the whole thing.
 *
 * Registry off, which is production's single-instance shape. The two-machine
 * half is the "raised hands across instances" group of voice-cluster.test.ts.
 * The moderator's lower is a route, and lives in api/voice-moderation.test.ts.
 * SPEAKING lowering your own hand is the client's (the server never sees
 * speaking): client/src/hooks/use-voice.test.ts.
 */

const backend = vi.hoisted(() => ({ configured: "mesh" as "mesh" | "livekit" }));

vi.mock("../voice/backends.js", () => ({
  getServerVoiceBackend: () => backend.configured,
  isLiveKitConfigured: () => backend.configured === "livekit",
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
  removeVoicePeerBySocket,
  resetVoicePeers,
  resetVoiceRateLimits,
  resetVoiceRoomTransports,
  setVoiceUserHandRaised,
  voiceUserHandRaisedAt,
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

interface RosterPerson {
  peerId: string;
  userId: string;
  handRaisedAt?: number | null;
}

/** The newest whole roster this socket was sent for the channel. */
function lastRoster(rec: Recorder, channel: string): RosterPerson[] {
  const all = rec.frames.filter(
    (f) => f.type === "voice-roster" && f.voiceChannelId === channel,
  );
  expect(all.length).toBeGreaterThan(0);
  return all[all.length - 1]!.participants as RosterPerson[];
}

/** The queue as a client watching that socket would draw it. */
function queueOn(rec: Recorder, channel: string): string[] {
  return raisedHandQueue(lastRoster(rec, channel)).map((p) => p.userId);
}

const previousClerk = process.env.CLERK_SECRET_KEY;

beforeEach(() => {
  process.env.CLERK_SECRET_KEY = "sk_test_voice_hands";
  resetVoicePeers();
  resetVoiceRateLimits();
  resetVoiceRoomTransports();
  backend.configured = "mesh";
});

afterEach(() => {
  process.env.CLERK_SECRET_KEY = previousClerk;
  for (const rec of open.splice(0)) {
    deleteAuthenticatedSocket(rec.socket);
  }
  resetVoicePeers();
});

async function join(
  userId: string,
  channel: string,
  extra?: { resumePeerId?: string; resumeToken?: string },
): Promise<Recorder & { peerId: string; resumeToken: string }> {
  const rec = recorder();
  const user = asUser(userId);
  setAuthenticatedSocket(rec.socket, user);
  await handleVoiceMessage(
    { socket: rec.socket, user },
    {
      type: "join-voice-room",
      voiceChannelId: channel,
      resume: true,
      ...(extra?.resumePeerId ? { resumePeerId: extra.resumePeerId } : {}),
      ...(extra?.resumeToken ? { resumeToken: extra.resumeToken } : {}),
    },
  );
  const welcome = rec.frames.find((f) => f.type === "welcome");
  if (!welcome) {
    throw new Error(`join refused: ${JSON.stringify(rec.frames)}`);
  }
  return {
    ...rec,
    peerId: welcome.peerId as string,
    resumeToken: welcome.resumeToken as string,
  };
}

async function raise(rec: Recorder, userId: string, raised: boolean) {
  await handleVoiceMessage(
    { socket: rec.socket, user: asUser(userId) },
    { type: "set-raised-hand", raised },
  );
}

async function leave(rec: Recorder, userId: string) {
  await handleVoiceMessage(
    { socket: rec.socket, user: asUser(userId) },
    { type: "leave-voice-room" },
  );
  // `removePeer` fires its roster without awaiting it (a departure must not
  // wait on a fan-out); one tick is what the room's sockets need to have it.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Raises in a fixed order with a real gap between them.
 *
 * `Date.now()` has millisecond resolution and three calls in one tick can
 * land on the same number; the tie-break in `raisedHandQueue` makes that
 * deterministic but it would make these tests assert the tie-break instead
 * of the ordering. One millisecond apart is what a person clicking is.
 */
async function raiseInOrder(entries: [Recorder, string][]) {
  for (const [rec, userId] of entries) {
    await raise(rec, userId, true);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

describe("raised hands", () => {
  it("orders the queue by when each hand went up", async () => {
    const channel = randomUUID();
    const alice = randomUUID();
    const bob = randomUUID();
    const carol = randomUUID();
    const a = await join(alice, channel);
    const b = await join(bob, channel);
    const c = await join(carol, channel);

    await raiseInOrder([
      [c, carol],
      [a, alice],
      [b, bob],
    ]);

    // Every socket in the room reads the same queue, in the same order, and
    // it is the order the hands went up rather than the roster's order.
    for (const rec of [a, b, c]) {
      expect(queueOn(rec, channel)).toEqual([carol, alice, bob]);
    }
  });

  it("keeps the order when somebody else raises or lowers", async () => {
    const channel = randomUUID();
    const alice = randomUUID();
    const bob = randomUUID();
    const carol = randomUUID();
    const a = await join(alice, channel);
    const b = await join(bob, channel);
    const c = await join(carol, channel);

    await raiseInOrder([
      [a, alice],
      [b, bob],
    ]);
    expect(queueOn(a, channel)).toEqual([alice, bob]);

    // A latecomer goes to the back, not into the middle.
    await raise(c, carol, true);
    expect(queueOn(a, channel)).toEqual([alice, bob, carol]);

    // Somebody lowering theirs does not move the ones above them.
    await raise(b, bob, false);
    expect(queueOn(a, channel)).toEqual([alice, carol]);

    // And raising again is going to the BACK, not back to where they were.
    await new Promise((resolve) => setTimeout(resolve, 2));
    await raise(b, bob, true);
    expect(queueOn(a, channel)).toEqual([alice, carol, bob]);
  });

  it("does not move a hand that is already up when it is raised again", async () => {
    const channel = randomUUID();
    const alice = randomUUID();
    const bob = randomUUID();
    const a = await join(alice, channel);
    const b = await join(bob, channel);

    await raiseInOrder([
      [a, alice],
      [b, bob],
    ]);
    const at = voiceUserHandRaisedAt(channel, alice);

    // A client redeclaring after a reconnect must not send itself to the back
    // of its own queue.
    await new Promise((resolve) => setTimeout(resolve, 3));
    await raise(a, alice, true);
    expect(voiceUserHandRaisedAt(channel, alice)).toBe(at);
    expect(queueOn(b, channel)).toEqual([alice, bob]);
  });

  it("tells a socket that joins mid-call the whole queue", async () => {
    const channel = randomUUID();
    const alice = randomUUID();
    const bob = randomUUID();
    const a = await join(alice, channel);
    await raise(a, alice, true);

    const b = await join(bob, channel);
    const welcome = b.frames.find((f) => f.type === "welcome");
    const peers = welcome?.peers as RosterPerson[];
    expect(raisedHandQueue(peers).map((p) => p.userId)).toEqual([alice]);
    expect(queueOn(b, channel)).toEqual([alice]);
  });

  it("keeps the place across a socket blip and a resume", async () => {
    const channel = randomUUID();
    const alice = randomUUID();
    const bob = randomUUID();
    const a = await join(alice, channel);
    const b = await join(bob, channel);

    await raiseInOrder([
      [a, alice],
      [b, bob],
    ]);
    const at = voiceUserHandRaisedAt(channel, alice);

    // The socket dies. An orphan is still in the call, and still in the
    // queue: nothing about a dropped WebSocket says the person stopped
    // wanting to talk.
    removeVoicePeerBySocket(a.socket);
    expect(voiceUserHandRaisedAt(channel, alice)).toBe(at);

    const again = await join(alice, channel, {
      resumePeerId: a.peerId,
      resumeToken: a.resumeToken,
    });
    expect(again.frames.find((f) => f.type === "welcome")?.resumed).toBe(true);
    expect(voiceUserHandRaisedAt(channel, alice)).toBe(at);
    // Still first, and still first for everybody else too.
    expect(queueOn(b, channel)).toEqual([alice, bob]);
  });

  it("keeps the place when the tab is refreshed inside the orphan window", async () => {
    const channel = randomUUID();
    const alice = randomUUID();
    const bob = randomUUID();
    const a = await join(alice, channel);
    const b = await join(bob, channel);

    await raiseInOrder([
      [a, alice],
      [b, bob],
    ]);
    const at = voiceUserHandRaisedAt(channel, alice);

    // A RELOAD IS A COLD JOIN. The resume token is memory-only, so a refreshed
    // tab comes back with a brand new peer id while the old seat is still an
    // orphan. This is why the hand is keyed on the person and not on the seat:
    // held on the peer it would die here, which is exactly the "I refreshed and
    // lost my place" complaint.
    removeVoicePeerBySocket(a.socket);
    const fresh = await join(alice, channel);
    expect(fresh.peerId).not.toBe(a.peerId);
    expect(voiceUserHandRaisedAt(channel, alice)).toBe(at);
    const self = fresh.frames.find((f) => f.type === "welcome")
      ?.self as RosterPerson;
    expect(self.handRaisedAt).toBe(at);
    expect(queueOn(b, channel)).toEqual([alice, bob]);
  });

  it("lowers the hand when the person leaves the room", async () => {
    const channel = randomUUID();
    const alice = randomUUID();
    const bob = randomUUID();
    const a = await join(alice, channel);
    const b = await join(bob, channel);

    await raiseInOrder([
      [a, alice],
      [b, bob],
    ]);
    expect(queueOn(b, channel)).toEqual([alice, bob]);

    await leave(a, alice);
    expect(voiceUserHandRaisedAt(channel, alice)).toBeNull();
    expect(queueOn(b, channel)).toEqual([bob]);
  });

  it("forgets the queue when the room empties, so it is not waiting for the next call", async () => {
    const channel = randomUUID();
    const alice = randomUUID();
    const a = await join(alice, channel);
    await raise(a, alice, true);
    expect(voiceUserHandRaisedAt(channel, alice)).not.toBeNull();

    await leave(a, alice);
    expect(voiceUserHandRaisedAt(channel, alice)).toBeNull();

    const back = await join(alice, channel);
    const welcome = back.frames.find((f) => f.type === "welcome");
    expect((welcome?.self as RosterPerson).handRaisedAt ?? null).toBeNull();
  });

  it("ignores a raise from a socket that is not in the room", async () => {
    const channel = randomUUID();
    const alice = randomUUID();
    const outsider = randomUUID();
    await join(alice, channel);
    const rec = recorder();
    setAuthenticatedSocket(rec.socket, asUser(outsider));

    await raise(rec, outsider, true);
    expect(voiceUserHandRaisedAt(channel, outsider)).toBeNull();
  });

  it("lets the moderation helper lower a hand that a person put up", async () => {
    const channel = randomUUID();
    const alice = randomUUID();
    const bob = randomUUID();
    const a = await join(alice, channel);
    const b = await join(bob, channel);
    await raiseInOrder([
      [a, alice],
      [b, bob],
    ]);

    // The route's own permission checks are in api/voice-moderation.test.ts;
    // this is the state change it performs, and the fan-out that follows it.
    await setVoiceUserHandRaised(channel, alice, false);
    expect(voiceUserHandRaisedAt(channel, alice)).toBeNull();
    expect(queueOn(b, channel)).toEqual([bob]);
    expect(queueOn(a, channel)).toEqual([bob]);
  });
});
