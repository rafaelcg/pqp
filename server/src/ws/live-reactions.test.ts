import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import {
  LIVE_REACTION_RATE_PER_SECOND,
  LIVE_REACTION_WINDOW_MS,
} from "@pqp/shared";
import type { DbUser } from "../db.js";

/**
 * Live reactions over the voice room: the three guards, each tested so that
 * REMOVING THE GUARD TURNS THE TEST RED rather than merely leaving it green by
 * coincidence.
 *
 *  - the limiter drops the surplus and, just as importantly, passes traffic
 *    under it (a limiter that refused everything would satisfy half of this);
 *  - the window folds taps into counts instead of relaying each one, so the
 *    assertion is on the NUMBER of frames as well as their contents;
 *  - the audience is the room, so a socket that never joined and a peer in a
 *    different room both hear nothing.
 *
 * The service layer is faked exactly as `watch-party.test.ts` fakes it. The
 * audience stub admits everybody on purpose: a fan-out that wrongly went out
 * through the roster path instead of the room would then be VISIBLE here
 * rather than hidden by a scoping rule that happens to exclude the same
 * sockets.
 */

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
const { deleteAuthenticatedSocket, setAuthenticatedSocket } = await import(
  "./sockets.js"
);
const { setCoalesceImmediate } = await import("./fanout.js");

// Roster sends are debounced on a real macrotask, which fake timers would
// freeze mid-join. Same seam the roster-delta suites use.
setCoalesceImmediate(true);

const STAGE = randomUUID();
const OTHER_ROOM = randomUUID();

interface ReactionsFrame {
  type: string;
  channelId?: string;
  items?: { emoji: string; count: number }[];
  seq?: number;
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

function reactionFrames(rec: Recorder): ReactionsFrame[] {
  return rec.received
    .map((raw) => JSON.parse(raw) as ReactionsFrame)
    .filter((frame) => frame.type === "live-reactions");
}

describe("live reactions over the voice room", () => {
  const joined: Recorder[] = [];
  const bystanders: Recorder[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    joined.length = 0;
    for (const rec of bystanders.splice(0)) {
      deleteAuthenticatedSocket(rec.socket);
    }
    resetVoicePeers();
    resetVoiceRateLimits();
    resetVoiceRoomTransports();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function join(
    userId: string,
    voiceChannelId = STAGE,
  ): Promise<Recorder> {
    const rec = recorder();
    joined.push(rec);
    await handleVoiceMessage(
      { socket: rec.socket, user: asUser(userId) },
      { type: "join-voice-room", voiceChannelId },
    );
    rec.received.length = 0;
    return rec;
  }

  /** An authenticated socket that never joined a room. */
  function bystander(userId: string): Recorder {
    const rec = recorder();
    bystanders.push(rec);
    setAuthenticatedSocket(rec.socket, asUser(userId));
    return rec;
  }

  function tap(
    rec: Recorder,
    userId: string,
    emoji: "👍" | "❤️" | "😂" | "😮" | "🔥" | "🎉",
    channelId = STAGE,
  ): Promise<void> {
    return handleVoiceMessage(
      { socket: rec.socket, user: asUser(userId) },
      { type: "live-reaction", channelId, emoji },
    );
  }

  /** Run out the coalescing window and let the flush's callback settle. */
  async function settleWindow(): Promise<void> {
    await vi.advanceTimersByTimeAsync(LIVE_REACTION_WINDOW_MS + 1);
  }

  // --- coalescing -----------------------------------------------------------

  it("folds a window of taps into one frame of counts per emoji", async () => {
    const a = await join("user-a");
    const b = await join("user-b");
    b.received.length = 0;

    await tap(a, "user-a", "🔥");
    await tap(b, "user-b", "🔥");
    await tap(b, "user-b", "😂");

    // Nothing goes out inside the window: coalescing is the feature, and a
    // frame arriving here would mean each tap was relayed.
    expect(reactionFrames(a)).toHaveLength(0);

    await settleWindow();

    const frames = reactionFrames(a);
    expect(frames).toHaveLength(1);
    const frame = frames[0]!;
    expect(frame.channelId).toBe(STAGE);
    expect(frame.seq).toBe(0);
    // Order is arrival order, so compare as a set of pairs.
    expect(new Map(frame.items!.map((item) => [item.emoji, item.count]))).toEqual(
      new Map([
        ["🔥", 2],
        ["😂", 1],
      ]),
    );
  });

  it("starts a fresh window after a flush and advances seq", async () => {
    const a = await join("user-a");

    await tap(a, "user-a", "👍");
    await settleWindow();
    await tap(a, "user-a", "🎉");
    await settleWindow();

    const frames = reactionFrames(a);
    expect(frames).toHaveLength(2);
    expect(frames[0]!.seq).toBe(0);
    expect(frames[1]!.seq).toBe(1);
    expect(frames[1]!.items).toEqual([{ emoji: "🎉", count: 1 }]);
  });

  it("sends nothing at all when nobody tapped", async () => {
    const a = await join("user-a");
    await settleWindow();
    expect(reactionFrames(a)).toHaveLength(0);
  });

  // --- rate limiting --------------------------------------------------------
  //
  // Both halves matter. A limiter that refuses everything would pass the drop
  // assertion on its own, so the first test pins the pass-through as well.

  it("passes a burst up to the per-second budget", async () => {
    const a = await join("user-a");

    for (let i = 0; i < LIVE_REACTION_RATE_PER_SECOND; i += 1) {
      await tap(a, "user-a", "👍");
    }
    await settleWindow();

    expect(reactionFrames(a)[0]!.items).toEqual([
      { emoji: "👍", count: LIVE_REACTION_RATE_PER_SECOND },
    ]);
  });

  it("silently drops the taps past the budget", async () => {
    const a = await join("user-a");

    for (let i = 0; i < LIVE_REACTION_RATE_PER_SECOND * 4; i += 1) {
      await tap(a, "user-a", "👍");
    }
    await settleWindow();

    const frames = reactionFrames(a);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.items).toEqual([
      { emoji: "👍", count: LIVE_REACTION_RATE_PER_SECOND },
    ]);
    // Silent: no refusal, no error frame, nothing but the counts that survived.
    const kinds = new Set(
      a.received.map((raw) => (JSON.parse(raw) as { type: string }).type),
    );
    expect(kinds).toEqual(new Set(["live-reactions"]));
  });

  it("budgets each socket separately, so one flooder cannot mute the room", async () => {
    const a = await join("user-a");
    const b = await join("user-b");
    b.received.length = 0;

    for (let i = 0; i < LIVE_REACTION_RATE_PER_SECOND * 4; i += 1) {
      await tap(a, "user-a", "👍");
    }
    await tap(b, "user-b", "❤️");
    await settleWindow();

    const counts = new Map(
      reactionFrames(b)[0]!.items!.map((item) => [item.emoji, item.count]),
    );
    expect(counts.get("❤️")).toBe(1);
    expect(counts.get("👍")).toBe(LIVE_REACTION_RATE_PER_SECOND);
  });

  // --- audience gating ------------------------------------------------------

  it("ignores a socket that is not in the room", async () => {
    const inside = await join("user-a");
    const outside = bystander("user-b");

    await tap(outside, "user-b", "🔥");
    await settleWindow();

    expect(reactionFrames(inside)).toHaveLength(0);
    expect(reactionFrames(outside)).toHaveLength(0);
  });

  it("ignores a peer whose room is not the channel they named", async () => {
    const inside = await join("user-a");
    const elsewhere = await join("user-b", OTHER_ROOM);
    elsewhere.received.length = 0;

    // A peer of OTHER_ROOM claiming the stage. The room is read from the peer,
    // never from the frame, so this is a drop rather than a cross-room spray.
    await tap(elsewhere, "user-b", "🔥", STAGE);
    await settleWindow();

    expect(reactionFrames(inside)).toHaveLength(0);
    expect(reactionFrames(elsewhere)).toHaveLength(0);
  });

  it("reaches the room and nobody outside it", async () => {
    const a = await join("user-a");
    const b = await join("user-b");
    const elsewhere = await join("user-c", OTHER_ROOM);
    const watching = bystander("user-d");
    b.received.length = 0;
    elsewhere.received.length = 0;

    await tap(a, "user-a", "🎉");
    await settleWindow();

    expect(reactionFrames(a)).toHaveLength(1);
    expect(reactionFrames(b)).toHaveLength(1);
    expect(reactionFrames(elsewhere)).toHaveLength(0);
    expect(reactionFrames(watching)).toHaveLength(0);
  });
});
