import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { WatchPartyState } from "@pqp/shared";
import type { DbUser } from "../db.js";

/**
 * The server half of the watch-party contract, as behaviour over the signalling
 * socket: the echo the sender gets back, the state a mid-video joiner is handed,
 * the teardown the last person out triggers, and the one rule that separates
 * this from `set-voice-state` (a hot limiter coalesces positions and never
 * drops a play, a pause or a change of video).
 *
 * No database and no browser: the service layer under the peer bookkeeping is
 * faked exactly as `voice-state.test.ts` fakes it, and the peers are recording
 * stubs. The audience stub admits everyone on purpose, so that a fan-out which
 * wrongly went out through the roster path would be VISIBLE here rather than
 * hidden by a scoping rule that happens to exclude the same sockets.
 */

vi.mock("../services/users.js", () => ({
  canAccessChannel: async () => true,
}));

vi.mock("../services/sanctions.js", () => ({
  findTimeoutForChannel: async () => null,
  timeoutMessage: () => "",
}));

vi.mock("../services/dms.js", () => ({
  isDmSendBlocked: async () => false,
  resolveRingableConversation: async () => null,
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
}));

vi.mock("../voice/backends.js", () => ({
  getServerVoiceBackend: () => "mesh",
  isLiveKitConfigured: () => false,
}));

const {
  handleVoiceMessage,
  resetVoicePeers,
  resetVoiceRateLimits,
  resetVoiceRoomTransports,
} = await import("./voice.js");
const { resetWatchParties } = await import("./watch-party.js");
const { deleteAuthenticatedSocket, setAuthenticatedSocket } = await import(
  "./sockets.js"
);

const CINEMA = randomUUID();
const OTHER_ROOM = randomUUID();

interface WatchFrame {
  type: string;
  channelId?: string;
  state?: WatchPartyState | null;
}

interface Recorder {
  socket: WebSocket;
  received: string[];
}

function recorder(): Recorder {
  const received: string[] = [];
  const socket = {
    readyState: 1,
    send: (payload: string) => received.push(payload),
    on: () => {},
  } as unknown as WebSocket;
  return { socket, received };
}

function asUser(id: string): DbUser {
  return {
    id,
    display_name: `User ${id}`,
    avatar_url: null,
  } as unknown as DbUser;
}

function watchFrames(rec: Recorder): WatchFrame[] {
  return rec.received
    .map((raw) => JSON.parse(raw) as WatchFrame)
    .filter((frame) => frame.type === "watch-party");
}

function lastWatchFrame(rec: Recorder): WatchFrame {
  const all = watchFrames(rec);
  expect(all.length).toBeGreaterThan(0);
  return all[all.length - 1]!;
}

function stateFor(
  actorId: string,
  over: Partial<WatchPartyState> = {},
): WatchPartyState {
  return {
    videoId: "dQw4w9WgXcQ",
    status: "paused",
    positionMs: 0,
    // A fixed sender clock. Nothing on the server reads it, which is the point:
    // `atMs` is diagnostic only and the server must never do arithmetic on it.
    atMs: 1_700_000_000_000,
    rev: 1,
    actorId,
    ...over,
  };
}

describe("watch party over the voice room", () => {
  const sockets: Recorder[] = [];
  const viewers: Recorder[] = [];

  beforeEach(() => {
    sockets.length = 0;
    resetVoicePeers();
    for (const rec of viewers.splice(0)) {
      deleteAuthenticatedSocket(rec.socket);
    }
    resetVoiceRateLimits();
    resetVoiceRoomTransports();
    resetWatchParties();
  });

  async function join(
    userId: string,
    voiceChannelId = CINEMA,
  ): Promise<Recorder> {
    const rec = recorder();
    sockets.push(rec);
    await handleVoiceMessage(
      { socket: rec.socket, user: asUser(userId) },
      { type: "join-voice-room", voiceChannelId },
    );
    return rec;
  }

  /** An authenticated socket that never joined a room. */
  function bystander(userId: string): Recorder {
    const rec = recorder();
    viewers.push(rec);
    setAuthenticatedSocket(rec.socket, asUser(userId));
    return rec;
  }

  function write(
    rec: Recorder,
    userId: string,
    state: WatchPartyState | null,
  ): Promise<void> {
    return handleVoiceMessage(
      { socket: rec.socket, user: asUser(userId) },
      { type: "set-watch-party", state },
    );
  }

  it("echoes the write back to its sender", async () => {
    const a = await join("user-a");
    a.received.length = 0;

    await write(a, "user-a", stateFor("peer-a", { status: "playing" }));

    const echo = lastWatchFrame(a);
    expect(echo.channelId).toBe(CINEMA);
    expect(echo.state).toMatchObject({ actorId: "peer-a", status: "playing" });
  });

  it("reaches the room and nobody outside it", async () => {
    const a = await join("user-a");
    const b = await join("user-b");
    const elsewhere = await join("user-c", OTHER_ROOM);
    const watching = bystander("user-d");
    b.received.length = 0;
    elsewhere.received.length = 0;
    watching.received.length = 0;

    await write(a, "user-a", stateFor("peer-a", { positionMs: 1_000 }));

    expect(lastWatchFrame(b).state).toMatchObject({ positionMs: 1_000 });
    expect(watchFrames(elsewhere)).toHaveLength(0);
    expect(watchFrames(watching)).toHaveLength(0);
  });

  it("hands a peer joining mid video the state the room is at", async () => {
    const a = await join("user-a");
    await write(
      a,
      "user-a",
      stateFor("peer-a", { status: "playing", positionMs: 42_000, rev: 7 }),
    );

    const late = await join("user-b");

    expect(lastWatchFrame(late).state).toMatchObject({
      positionMs: 42_000,
      rev: 7,
      status: "playing",
    });
  });

  it("tears the party down when the last participant leaves, and says so", async () => {
    const a = await join("user-a");
    const b = await join("user-b");
    await write(a, "user-a", stateFor("peer-a", { status: "playing" }));

    await handleVoiceMessage(
      { socket: a.socket, user: asUser("user-a") },
      { type: "leave-voice-room" },
    );
    // One left: the party is still on.
    expect(watchFrames(b).some((frame) => frame.state === null)).toBe(false);

    b.received.length = 0;
    await handleVoiceMessage(
      { socket: b.socket, user: asUser("user-b") },
      { type: "leave-voice-room" },
    );

    expect(lastWatchFrame(b)).toMatchObject({ channelId: CINEMA, state: null });

    const fresh = await join("user-c");
    expect(watchFrames(fresh)).toHaveLength(0);
  });

  it("never drops a change of status, however hot the limiter is", async () => {
    const a = await join("user-a");
    const b = await join("user-b");
    await write(a, "user-a", stateFor("peer-a", { status: "playing" }));

    // A scrub's worth of position-only writes, which is what empties the
    // budget in real life.
    for (let i = 0; i < 60; i += 1) {
      await write(
        a,
        "user-a",
        stateFor("peer-a", {
          status: "playing",
          positionMs: i * 250,
          rev: i + 2,
        }),
      );
    }
    b.received.length = 0;

    // The frame that must survive: everyone else keeps playing without it.
    await write(
      a,
      "user-a",
      stateFor("peer-a", { status: "paused", positionMs: 15_000, rev: 100 }),
    );

    expect(lastWatchFrame(b).state).toMatchObject({
      status: "paused",
      rev: 100,
    });
  });

  it("never drops a change of video, however hot the limiter is", async () => {
    const a = await join("user-a");
    const b = await join("user-b");
    await write(a, "user-a", stateFor("peer-a", { status: "playing" }));
    for (let i = 0; i < 60; i += 1) {
      await write(
        a,
        "user-a",
        stateFor("peer-a", {
          status: "playing",
          positionMs: i * 250,
          rev: i + 2,
        }),
      );
    }
    b.received.length = 0;

    await write(
      a,
      "user-a",
      stateFor("peer-a", {
        videoId: "M7lc1UVf-VE",
        status: "playing",
        positionMs: 0,
        rev: 100,
      }),
    );

    expect(lastWatchFrame(b).state).toMatchObject({ videoId: "M7lc1UVf-VE" });
  });

  it("coalesces position-only writes rather than dropping them", async () => {
    const a = await join("user-a");
    const b = await join("user-b");
    await write(a, "user-a", stateFor("peer-a", { status: "playing" }));
    b.received.length = 0;

    const scrub = 60;
    for (let i = 0; i < scrub; i += 1) {
      await write(
        a,
        "user-a",
        stateFor("peer-a", {
          status: "playing",
          positionMs: (i + 1) * 250,
          rev: i + 2,
        }),
      );
    }

    // Coalesced, not relayed one for one: that is the whole point of holding
    // the state rather than forwarding it.
    expect(watchFrames(b).length).toBeLessThan(scrub);
    expect(watchFrames(b).length).toBeGreaterThan(0);

    // And a coalesced position is still HELD, so the next person through the
    // door lands where the room actually is rather than where its last
    // broadcast was.
    const late = await join("user-c");
    expect(lastWatchFrame(late).state).toMatchObject({
      positionMs: scrub * 250,
    });
  });

  it("refuses a write that lost to the held state, and hands back the winner", async () => {
    const a = await join("user-a");
    const b = await join("user-b");
    await write(
      a,
      "user-a",
      stateFor("peer-a", { status: "playing", positionMs: 30_000, rev: 9 }),
    );
    b.received.length = 0;

    // A straggler from a peer that had not heard rev 9 yet.
    await write(b, "user-b", stateFor("peer-b", { status: "paused", rev: 4 }));

    // The room is not dragged backwards...
    expect(watchFrames(b).every((frame) => frame.state?.rev !== 4)).toBe(true);
    // ...the loser is told what won, so it stops retrying...
    expect(lastWatchFrame(b).state).toMatchObject({ rev: 9 });
    // ...and a late joiner still gets rev 9.
    const late = await join("user-c");
    expect(lastWatchFrame(late).state).toMatchObject({ rev: 9, positionMs: 30_000 });
  });

  it("echoes a resend at the rev it already holds", async () => {
    const a = await join("user-a");
    const state = stateFor("peer-a", { status: "playing", rev: 3 });
    await write(a, "user-a", state);
    a.received.length = 0;

    // The retry the contract describes: same rev, same actor, because the
    // client never saw its echo. Refusing this as stale would leave it
    // retrying forever.
    await write(a, "user-a", { ...state, positionMs: 4_000 });

    expect(lastWatchFrame(a).state).toMatchObject({ rev: 3, positionMs: 4_000 });
  });

  it("ends the party for a room emptied by an eviction, not just by leaving", async () => {
    const { evictVoiceChannel } = await import("./voice.js");
    const a = await join("user-a");
    await write(a, "user-a", stateFor("peer-a", { status: "playing" }));
    a.received.length = 0;

    evictVoiceChannel(CINEMA);

    expect(lastWatchFrame(a)).toMatchObject({ state: null });
    const fresh = await join("user-b");
    expect(watchFrames(fresh)).toHaveLength(0);
  });
});
