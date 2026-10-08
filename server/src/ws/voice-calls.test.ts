import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import type { WebSocket } from "ws";
import type { DbUser } from "../db.js";
import { createMemoryHub } from "../lib/bus.js";

/**
 * Conversation calls: a DM rings, and nothing about it leaks to any server.
 *
 * The mechanics under test are the `// --- conversation calls ---` section of
 * `ws/voice.ts`: `call-ring` fans an incoming-call frame out to the absent
 * participants (their sockets only), accepting is joining the room, declining
 * tells the caller, an unanswered ring becomes a missed-call message, DND is
 * never rung, and a block refuses the call the way it refuses a message.
 *
 * No database: every service underneath is faked, the way
 * `voice-transport.test.ts` does it. The SQL truths these fakes stand in for
 * (participant resolution, block predicates, `findTimeoutForChannel` having
 * no scope over a conversation) are proved against a real database in
 * `services/dms.test.ts` and `services/sanctions.test.ts`.
 */

const CONVERSATION = randomUUID();
const SERVER_CHANNEL = randomUUID();

// The "across two instances" group at the bottom needs Postgres; the rest
// of the file never touches it, so pointing `DATABASE_URL` at the test copy
// changes nothing for them.
const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;
if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const CALLER = randomUUID();
const CALLEE = randomUUID();
const THIRD = randomUUID();
const STRANGER = randomUUID();

const fakes = vi.hoisted(() => ({
  backend: "mesh" as "mesh" | "livekit",
  /** channelId → participant user ids (null = ring refused). */
  participants: new Map<string, string[] | null>(),
  blocked: false,
  blockersOfCaller: new Set<string>(),
  dndUserIds: new Set<string>(),
  channels: new Map<string, { kind: string; type: string }>(),
  createMessageCalls: [] as { channelId: string; authorId: string; body: string }[],
  broadcasts: [] as { channelId: string; message: { type: string } }[],
  /** Every `pushIncomingCall` the ring handed to the push module. */
  callPushes: [] as {
    conversationId: string;
    kind: string;
    rungUserIds: readonly string[];
    callerName: string | null;
  }[],
  /** Every `pushChannelActivity` the missed-call record handed over. */
  activityPushes: [] as {
    channelId: string;
    authorId: string;
    blockerIds: ReadonlySet<string>;
    mentionedUsernames: readonly string[];
  }[],
}));

vi.mock("../voice/backends.js", () => ({
  getServerVoiceBackend: () => fakes.backend,
  isLiveKitConfigured: () => fakes.backend === "livekit",
}));

vi.mock("../services/users.js", () => ({
  // Voice resolves the name to show through here now; the real one
  // reads `server_members.nickname`, which these tests have no table for.
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
  isDmSendBlocked: async () => fakes.blocked,
  resolveRingableConversation: async (channelId: string) =>
    fakes.participants.get(channelId) ?? null,
}));

vi.mock("../services/blocks.js", () => ({
  listBlockersOf: async () => fakes.blockersOfCaller,
}));

vi.mock("../services/servers.js", () => ({
  getChannel: async (channelId: string) => fakes.channels.get(channelId) ?? null,
  getChannelAudience: async (channelId: string) => {
    const participants = fakes.participants.get(channelId);
    if (!participants) {
      return null;
    }
    return {
      serverId: null,
      kind: "dm",
      has: (userId: string) => participants.includes(userId),
      get userIds() {
        return [...participants];
      },
    };
  },
}));

vi.mock("../services/messages.js", () => ({
  createMessage: vi.fn(
    async (channelId: string, author: DbUser, body: string) => {
      fakes.createMessageCalls.push({ channelId, authorId: author.id, body });
      return { id: "missed-call-message", channel_id: channelId, body };
    },
  ),
  mapMessage: (message: unknown) => message,
}));

vi.mock("./chat.js", () => ({
  broadcastToChannel: vi.fn(
    (channelId: string, message: { type: string }) => {
      fakes.broadcasts.push({ channelId, message });
    },
  ),
  // Voice subscribes to permission bumps at import (SPEAK re-check); this
  // suite never bumps one.
  onPermissionsUpdate: () => () => {},
}));

vi.mock("./status.js", () => ({
  resolveStatus: (userId: string) =>
    fakes.dndUserIds.has(userId) ? "dnd" : "online",
}));

vi.mock("../services/push.js", () => ({
  pushIncomingCall: vi.fn(
    (event: (typeof fakes.callPushes)[number]) => {
      fakes.callPushes.push(event);
    },
  ),
  pushChannelActivity: vi.fn(
    (event: (typeof fakes.activityPushes)[number]) => {
      fakes.activityPushes.push(event);
    },
  ),
}));

vi.mock("../voice/admin.js", () => ({
  evictSfuRoom: vi.fn(() => Promise.resolve()),
  evictSfuUser: vi.fn(() => Promise.resolve()),
  evictSfuUsersExcept: vi.fn(() => Promise.resolve()),
}));

const {
  CALL_EMPTY_ROOM_GRACE_MS,
  CALL_HANGUP_CONFIRM_MS,
  CALL_RING_TIMEOUT_MS,
  MISSED_CALL_BODY,
  handleVoiceMessage,
  isConversationRinging,
  removeVoicePeerBySocket,
  resetConversationCalls,
  resetVoicePeers,
  resetVoiceRateLimits,
  resetVoiceRoomTransports,
} = await import("./voice.js");

const { callMetricsSnapshot, resetCallMetrics } = await import(
  "../voice/call-metrics.js"
);

const { setCoalesceImmediate } = await import("./fanout.js");
// Fake timers below would freeze the roster's coalescing window.
setCoalesceImmediate(true);
const { setAuthenticatedSocket, deleteAuthenticatedSocket } = await import(
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

const registered: WebSocket[] = [];

function recorder(): Recorder {
  const frames: Frame[] = [];
  const socket = {
    readyState: 1,
    send: (payload: string) => frames.push(JSON.parse(payload) as Frame),
    on: () => {},
  } as unknown as WebSocket;
  return { socket, frames };
}

function asUser(id: string, name = `User ${id.slice(0, 4)}`): DbUser {
  return {
    id,
    display_name: name,
    avatar_url: null,
  } as unknown as DbUser;
}

/** A recorder whose socket is also in the authenticated registry, so the
 *  ring fan-out (which walks every authenticated socket) can see it. */
function authedRecorder(userId: string): Recorder {
  const rec = recorder();
  setAuthenticatedSocket(rec.socket, asUser(userId));
  registered.push(rec.socket);
  return rec;
}

function framesOf(rec: Recorder, type: string): Frame[] {
  return rec.frames.filter((f) => f.type === type);
}

function frame(rec: Recorder, type: string): Frame | undefined {
  return framesOf(rec, type)[0];
}

async function join(rec: Recorder, userId: string, voiceChannelId: string) {
  await handleVoiceMessage(
    { socket: rec.socket, user: asUser(userId) },
    { type: "join-voice-room", voiceChannelId },
  );
}

async function ring(rec: Recorder, userId: string, conversationId: string) {
  await handleVoiceMessage(
    { socket: rec.socket, user: asUser(userId) },
    { type: "call-ring", conversationId },
  );
}

async function decline(rec: Recorder, userId: string, conversationId: string) {
  await handleVoiceMessage(
    { socket: rec.socket, user: asUser(userId) },
    { type: "call-decline", conversationId },
  );
}

/** Start a call: caller joins the conversation room and rings it. */
async function startCall(callerRec: Recorder) {
  await join(callerRec, CALLER, CONVERSATION);
  expect(frame(callerRec, "welcome")).toBeDefined();
  await ring(callerRec, CALLER, CONVERSATION);
}

beforeEach(() => {
  vi.useFakeTimers();
  fakes.backend = "mesh";
  fakes.blocked = false;
  fakes.blockersOfCaller = new Set();
  fakes.dndUserIds = new Set();
  fakes.createMessageCalls = [];
  fakes.broadcasts = [];
  fakes.callPushes = [];
  fakes.activityPushes = [];
  fakes.participants = new Map([[CONVERSATION, [CALLER, CALLEE, THIRD]]]);
  fakes.channels = new Map([
    [CONVERSATION, { kind: "dm", type: "text" }],
    [SERVER_CHANNEL, { kind: "server", type: "voice" }],
  ]);
  resetVoiceRateLimits();
  resetVoiceRoomTransports();
  resetVoicePeers();
  resetConversationCalls();
  resetCallMetrics();
});

afterEach(() => {
  resetVoicePeers();
  for (const socket of registered.splice(0)) {
    deleteAuthenticatedSocket(socket);
  }
  resetConversationCalls();
  vi.useRealTimers();
});

describe("call metrics", () => {
  it("counts a DM ring started and the caller's connected mesh join", async () => {
    const caller = authedRecorder(CALLER);
    await startCall(caller);

    const m = callMetricsSnapshot();
    // The ring: one DM ring committed.
    expect(m.rings).toBe(1);
    expect(m.ringsByKind.dm).toBe(1);
    expect(m.ringsByKind.group).toBe(0);
    // The join underneath it: the caller connected to a mesh DM room.
    expect(m.joinAttempts).toBeGreaterThanOrEqual(1);
    expect(m.joinConnected).toBeGreaterThanOrEqual(1);
    expect(m.joinConnectedByTransport.mesh).toBeGreaterThanOrEqual(1);
    expect(m.joinConnectedByScope.dm).toBeGreaterThanOrEqual(1);
  });

  it("counts a ring as answered when a callee joins the room", async () => {
    const caller = authedRecorder(CALLER);
    const callee = authedRecorder(CALLEE);
    await startCall(caller);
    await join(callee, CALLEE, CONVERSATION);

    const m = callMetricsSnapshot();
    expect(m.ringsAnswered).toBe(1);
    expect(m.ringsAnsweredByKind.dm).toBe(1);
    // Answered, so it is not counted as an unanswered end.
    expect(m.ringsEndedByReason.timeout).toBe(0);
    expect(m.ringsEndedByReason.cancelled).toBe(0);
  });

  it("counts an unanswered ring that rings out as a timeout end", async () => {
    const caller = authedRecorder(CALLER);
    authedRecorder(CALLEE);
    await startCall(caller);
    await vi.advanceTimersByTimeAsync(CALL_RING_TIMEOUT_MS + 1);

    const m = callMetricsSnapshot();
    expect(m.ringsAnswered).toBe(0);
    expect(m.ringsEndedByReason.timeout).toBe(1);
  });

  it("counts a decline", async () => {
    const caller = authedRecorder(CALLER);
    const callee = authedRecorder(CALLEE);
    await startCall(caller);
    await decline(callee, CALLEE, CONVERSATION);

    expect(callMetricsSnapshot().ringsDeclined).toBe(1);
  });
});

describe("ringing", () => {
  it("rings every socket of the absent participants and nobody else", async () => {
    const caller = authedRecorder(CALLER);
    const calleePhone = authedRecorder(CALLEE);
    const calleeDesktop = authedRecorder(CALLEE);
    const third = authedRecorder(THIRD);
    const stranger = authedRecorder(STRANGER);

    await startCall(caller);

    expect(isConversationRinging(CONVERSATION)).toBe(true);
    for (const rec of [calleePhone, calleeDesktop, third]) {
      const incoming = frame(rec, "call-incoming");
      expect(incoming).toBeDefined();
      expect(incoming!.conversationId).toBe(CONVERSATION);
      expect(incoming!.kind).toBe("dm");
      expect((incoming!.caller as { userId: string }).userId).toBe(CALLER);
    }
    // The caller does not ring themself, and a non-participant hears nothing.
    expect(frame(caller, "call-incoming")).toBeUndefined();
    expect(stranger.frames).toEqual([]);
  });

  it("refuses to ring for a socket that is not in the conversation's room", async () => {
    const caller = authedRecorder(CALLER);
    const callee = authedRecorder(CALLEE);

    // Never joined the room: the ring frame is dropped.
    await ring(caller, CALLER, CONVERSATION);
    expect(isConversationRinging(CONVERSATION)).toBe(false);
    expect(frame(callee, "call-incoming")).toBeUndefined();

    // In a *different* room: still refused.
    await join(caller, CALLER, SERVER_CHANNEL);
    await ring(caller, CALLER, CONVERSATION);
    expect(frame(callee, "call-incoming")).toBeUndefined();
  });

  it("never rings a server channel", async () => {
    fakes.participants.set(SERVER_CHANNEL, [CALLER, CALLEE, THIRD]);
    const caller = authedRecorder(CALLER);
    const callee = authedRecorder(CALLEE);

    await join(caller, CALLER, SERVER_CHANNEL);
    await ring(caller, CALLER, SERVER_CHANNEL);

    expect(isConversationRinging(SERVER_CHANNEL)).toBe(false);
    expect(frame(callee, "call-incoming")).toBeUndefined();
  });

  it("does not ring somebody on do-not-disturb, but still records the miss quietly", async () => {
    fakes.participants.set(CONVERSATION, [CALLER, CALLEE]);
    fakes.dndUserIds.add(CALLEE);
    const caller = authedRecorder(CALLER);
    const callee = authedRecorder(CALLEE);

    await startCall(caller);

    expect(frame(callee, "call-incoming")).toBeUndefined();

    await vi.advanceTimersByTimeAsync(CALL_RING_TIMEOUT_MS + 1);

    // The missed call lands as an ordinary quiet message: a channel-activity
    // badge with no mention, never an incoming-call surface.
    expect(fakes.createMessageCalls).toEqual([
      { channelId: CONVERSATION, authorId: CALLER, body: MISSED_CALL_BODY },
    ]);
    const activity = frame(callee, "channel-activity");
    expect(activity).toBeDefined();
    expect(activity!.mention).toBe(false);
    expect(activity!.serverId).toBeNull();
  });

  it("does not ring somebody who blocked the caller", async () => {
    fakes.blockersOfCaller = new Set([THIRD]);
    const caller = authedRecorder(CALLER);
    const callee = authedRecorder(CALLEE);
    const third = authedRecorder(THIRD);

    await startCall(caller);

    expect(frame(callee, "call-incoming")).toBeDefined();
    expect(frame(third, "call-incoming")).toBeUndefined();
  });

  it("a blocked pair cannot even open the call: the join is refused", async () => {
    fakes.blocked = true;
    const caller = authedRecorder(CALLER);
    const callee = authedRecorder(CALLEE);

    await join(caller, CALLER, CONVERSATION);
    expect(frame(caller, "welcome")).toBeUndefined();

    await ring(caller, CALLER, CONVERSATION);
    expect(isConversationRinging(CONVERSATION)).toBe(false);
    expect(frame(callee, "call-incoming")).toBeUndefined();
  });
});

describe("answering, declining, missing", () => {
  it("accepting is joining: the ring resolves and other devices stop ringing", async () => {
    const caller = authedRecorder(CALLER);
    const calleePhone = authedRecorder(CALLEE);
    const calleeDesktop = authedRecorder(CALLEE);
    const third = authedRecorder(THIRD);

    await startCall(caller);
    await join(calleePhone, CALLEE, CONVERSATION);

    // The device that answered joined; the other one is told why the ringing
    // stopped; the third participant keeps ringing.
    expect(frame(calleePhone, "welcome")).toBeDefined();
    const cancelled = frame(calleeDesktop, "call-ring-cancelled");
    expect(cancelled).toBeDefined();
    expect(cancelled!.reason).toBe("answered");
    expect(frame(third, "call-ring-cancelled")).toBeUndefined();
    expect(isConversationRinging(CONVERSATION)).toBe(true);

    // An answered call is never a missed call, even when the third participant
    // lets it ring out.
    await vi.advanceTimersByTimeAsync(CALL_RING_TIMEOUT_MS + 1);
    expect(fakes.createMessageCalls).toEqual([]);
  });

  it("declining tells the room and the decliner's other devices", async () => {
    fakes.participants.set(CONVERSATION, [CALLER, CALLEE]);
    const caller = authedRecorder(CALLER);
    const calleePhone = authedRecorder(CALLEE);
    const calleeDesktop = authedRecorder(CALLEE);

    await startCall(caller);
    await decline(calleePhone, CALLEE, CONVERSATION);

    const declined = frame(caller, "call-declined");
    expect(declined).toBeDefined();
    expect(declined!.userId).toBe(CALLEE);
    expect(frame(calleeDesktop, "call-ring-cancelled")?.reason).toBe(
      "declined",
    );
    expect(isConversationRinging(CONVERSATION)).toBe(false);
    // Everybody said no and nobody came: that is a missed call.
    expect(fakes.createMessageCalls).toEqual([
      { channelId: CONVERSATION, authorId: CALLER, body: MISSED_CALL_BODY },
    ]);
  });

  it("a stranger cannot decline a call they were not rung for", async () => {
    const caller = authedRecorder(CALLER);
    const callee = authedRecorder(CALLEE);
    const stranger = authedRecorder(STRANGER);

    await startCall(caller);
    await decline(stranger, STRANGER, CONVERSATION);

    expect(isConversationRinging(CONVERSATION)).toBe(true);
    expect(frame(caller, "call-declined")).toBeUndefined();
    expect(frame(callee, "call-ring-cancelled")).toBeUndefined();
  });

  it("an unanswered ring times out into a missed-call message for participants only", async () => {
    const caller = authedRecorder(CALLER);
    const callee = authedRecorder(CALLEE);
    const stranger = authedRecorder(STRANGER);

    await startCall(caller);
    await vi.advanceTimersByTimeAsync(CALL_RING_TIMEOUT_MS + 1);

    expect(isConversationRinging(CONVERSATION)).toBe(false);
    expect(frame(callee, "call-ring-cancelled")?.reason).toBe("timeout");
    expect(fakes.createMessageCalls).toEqual([
      { channelId: CONVERSATION, authorId: CALLER, body: MISSED_CALL_BODY },
    ]);
    // The record travels the message path (viewers) + an activity badge for
    // participants; a non-participant hears nothing at all.
    expect(fakes.broadcasts).toEqual([
      {
        channelId: CONVERSATION,
        message: expect.objectContaining({ type: "message-broadcast" }),
      },
    ]);
    const activity = frame(callee, "channel-activity");
    expect(activity).toBeDefined();
    expect(activity!.serverId).toBeNull();
    expect(activity!.kind).toBe("dm");
    // The caller does not get a badge for their own missed call.
    expect(frame(caller, "channel-activity")).toBeUndefined();
    expect(stranger.frames).toEqual([]);
  });

  it("the caller hanging up cancels the ring well before the grace and records the miss", async () => {
    const caller = authedRecorder(CALLER);
    const callee = authedRecorder(CALLEE);

    await startCall(caller);
    await handleVoiceMessage(
      { socket: caller.socket, user: asUser(CALLER) },
      { type: "leave-voice-room" },
    );

    // No reconnect grace: `leave-voice-room` is only ever a deliberate
    // hangup, and a ring that outlives it lets the callee answer into an
    // empty call. Only the short window for a join already in flight.
    await vi.advanceTimersByTimeAsync(CALL_HANGUP_CONFIRM_MS - 1);
    expect(isConversationRinging(CONVERSATION)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(CALL_HANGUP_CONFIRM_MS).toBeLessThan(CALL_EMPTY_ROOM_GRACE_MS);
    expect(isConversationRinging(CONVERSATION)).toBe(false);
    expect(frame(callee, "call-ring-cancelled")?.reason).toBe("cancelled");
    await vi.advanceTimersByTimeAsync(0);
    expect(fakes.createMessageCalls).toEqual([
      { channelId: CONVERSATION, authorId: CALLER, body: MISSED_CALL_BODY },
    ]);

    // The grace timer the leave armed went with the ring: one record, once.
    await vi.advanceTimersByTimeAsync(CALL_EMPTY_ROOM_GRACE_MS + 1);
    expect(framesOf(callee, "call-ring-cancelled")).toHaveLength(1);
    expect(fakes.createMessageCalls).toHaveLength(1);
  });

  it("a callee picking up as the caller hangs up is an answered call, not a missed one", async () => {
    fakes.participants.set(CONVERSATION, [CALLER, CALLEE]);
    const caller = authedRecorder(CALLER);
    const callee = authedRecorder(CALLEE);

    await startCall(caller);
    await handleVoiceMessage(
      { socket: caller.socket, user: asUser(CALLER) },
      { type: "leave-voice-room" },
    );
    // The callee's join was already on its way when the hangup landed.
    await vi.advanceTimersByTimeAsync(CALL_HANGUP_CONFIRM_MS / 2);
    await join(callee, CALLEE, CONVERSATION);
    expect(frame(callee, "welcome")).toBeDefined();

    await vi.advanceTimersByTimeAsync(CALL_RING_TIMEOUT_MS + 1);
    expect(isConversationRinging(CONVERSATION)).toBe(false);
    expect(
      framesOf(callee, "call-ring-cancelled").map((f) => f.reason),
    ).not.toContain("cancelled");
    expect(fakes.createMessageCalls).toEqual([]);
  });

  it("the caller's socket dropping keeps the ring through the grace window", async () => {
    const caller = authedRecorder(CALLER);
    const callee = authedRecorder(CALLEE);

    await startCall(caller);
    // A socket close is what a reconnect looks like; it is not a hangup.
    removeVoicePeerBySocket(caller.socket);

    await vi.advanceTimersByTimeAsync(CALL_EMPTY_ROOM_GRACE_MS - 1);
    expect(isConversationRinging(CONVERSATION)).toBe(true);
    expect(frame(callee, "call-ring-cancelled")).toBeUndefined();

    await vi.advanceTimersByTimeAsync(2);
    expect(isConversationRinging(CONVERSATION)).toBe(false);
    expect(frame(callee, "call-ring-cancelled")?.reason).toBe("cancelled");
  });

  it("a caller rejoin inside the grace window keeps the ring alive", async () => {
    const caller = authedRecorder(CALLER);
    const callee = authedRecorder(CALLEE);

    await startCall(caller);
    // Reconnect: a fresh join removes the old peer (briefly emptying the
    // room) and registers a new one.
    await join(caller, CALLER, CONVERSATION);

    await vi.advanceTimersByTimeAsync(CALL_EMPTY_ROOM_GRACE_MS + 1);
    expect(isConversationRinging(CONVERSATION)).toBe(true);
    expect(fakes.createMessageCalls).toEqual([]);
    expect(frame(callee, "call-ring-cancelled")).toBeUndefined();
  });
});

describe("web push at the ring seam", () => {
  it("hands the ring's own conclusion to push — the rung set, nothing re-derived", async () => {
    const caller = authedRecorder(CALLER);
    authedRecorder(CALLEE);

    await startCall(caller);

    // Exactly who was rung over sockets is who the push module is offered
    // (it narrows to no-live-socket + stored DND itself); the caller is not
    // in it, and the payload names the caller for the lock screen.
    expect(fakes.callPushes).toEqual([
      {
        conversationId: CONVERSATION,
        kind: "dm",
        rungUserIds: [CALLEE, THIRD],
        callerName: asUser(CALLER).display_name,
      },
    ]);
  });

  it("DND gets neither the ring nor the push", async () => {
    fakes.dndUserIds.add(CALLEE);
    const caller = authedRecorder(CALLER);
    const callee = authedRecorder(CALLEE);

    await startCall(caller);

    expect(frame(callee, "call-incoming")).toBeUndefined();
    expect(fakes.callPushes.length).toBe(1);
    expect(fakes.callPushes[0]!.rungUserIds).toEqual([THIRD]);
  });

  it("someone who blocked the caller is untouched by the push leg too", async () => {
    fakes.blockersOfCaller = new Set([THIRD]);
    const caller = authedRecorder(CALLER);

    await startCall(caller);

    expect(fakes.callPushes.length).toBe(1);
    expect(fakes.callPushes[0]!.rungUserIds).toEqual([CALLEE]);
  });

  it("a ring nobody was rung for still offers push the absentees", async () => {
    // Every absent participant may be offline: the socket fan-out reaches
    // nobody, and the push leg is then the only ring there is.
    fakes.participants.set(CONVERSATION, [CALLER, CALLEE]);
    const caller = authedRecorder(CALLER);

    await startCall(caller);

    expect(fakes.callPushes[0]!.rungUserIds).toEqual([CALLEE]);
  });

  it("the missed-call record rides the ordinary message-push path, blockers excluded", async () => {
    fakes.blockersOfCaller = new Set([THIRD]);
    const caller = authedRecorder(CALLER);

    await startCall(caller);
    await vi.advanceTimersByTimeAsync(CALL_RING_TIMEOUT_MS + 1);

    // One activity push for the missed-call message: caller-authored in the
    // conversation, never a mention, with the same blockers the socket badge
    // loop honoured. Its payload (built downstream by `buildPushPayload`)
    // therefore tags the conversation id — the same tag as the call push, so
    // the vendor replaces one with the other.
    expect(fakes.activityPushes.length).toBe(1);
    const push = fakes.activityPushes[0]!;
    expect(push.channelId).toBe(CONVERSATION);
    expect(push.authorId).toBe(CALLER);
    expect(push.mentionedUsernames).toEqual([]);
    expect([...push.blockerIds]).toEqual([THIRD]);
  });

  it("an answered call posts no missed-call record and no missed-call push", async () => {
    const caller = authedRecorder(CALLER);
    const callee = authedRecorder(CALLEE);

    await startCall(caller);
    await join(callee, CALLEE, CONVERSATION);
    await vi.advanceTimersByTimeAsync(CALL_RING_TIMEOUT_MS + 1);

    expect(fakes.activityPushes).toEqual([]);
  });
});

describe("privacy and transport", () => {
  it("a conversation's roster reaches participants only — no server surface, no stranger", async () => {
    const caller = authedRecorder(CALLER);
    const callee = authedRecorder(CALLEE);
    const stranger = authedRecorder(STRANGER);

    await join(caller, CALLER, CONVERSATION);
    // broadcastRoster is queued; let it drain.
    await vi.advanceTimersByTimeAsync(0);

    expect(frame(callee, "voice-roster")).toBeDefined();
    expect(frame(stranger, "voice-roster")).toBeUndefined();
    // And no channel-activity is emitted for merely opening a call room.
    expect(framesOf(callee, "channel-activity")).toEqual([]);
    expect(framesOf(stranger, "channel-activity")).toEqual([]);
  });

  it("a conversation room pins its transport like any other room", async () => {
    fakes.backend = "mesh";
    const caller = authedRecorder(CALLER);
    await join(caller, CALLER, CONVERSATION);
    expect(frame(caller, "welcome")!.transport).toBe("mesh");

    // LiveKit appears mid-call: the room stays mesh for as long as it is
    // occupied, so a second participant is welcomed onto the same transport.
    fakes.backend = "livekit";
    const callee = authedRecorder(CALLEE);
    await join(callee, CALLEE, CONVERSATION);
    expect(frame(callee, "welcome")!.transport).toBe("mesh");
  });

  it("camera state travels the roster to participants", async () => {
    const caller = authedRecorder(CALLER);
    const callee = authedRecorder(CALLEE);

    await join(caller, CALLER, CONVERSATION);
    await join(callee, CALLEE, CONVERSATION);
    await handleVoiceMessage(
      { socket: caller.socket, user: asUser(CALLER) },
      { type: "set-camera", streamId: "camera-stream-1" },
    );
    await vi.advanceTimersByTimeAsync(0);

    const rosters = framesOf(callee, "voice-roster");
    const latest = rosters[rosters.length - 1]!;
    const participants = latest.participants as {
      userId: string;
      cameraStreamId: string | null;
    }[];
    expect(
      participants.find((p) => p.userId === CALLER)?.cameraStreamId,
    ).toBe("camera-stream-1");
  });
});

/**
 * Rings across two instances: milestone M4 of
 * `docs/plans/MULTI_INSTANCE_VOICE.md`, section 5.5. The ring is owned by
 * the instance holding the caller's socket; only the fan-out crosses on
 * `voice.call`, and a decline or an answer on the other machine is routed
 * back to the owner. Same two-graph harness as `voice-cluster.test.ts`; the
 * hoisted fakes are shared by both graphs, so `pushIncomingCall` and the
 * missed-call `createMessage` are counted cluster-wide, which is the point.
 * Real timers here: the ring ends by everybody declining, not by the clock.
 */
type BusModule = typeof import("../lib/bus.js");
type VoiceModule = typeof import("./voice.js");
type SocketsModule = typeof import("./sockets.js");
type RegistryModule = typeof import("../voice/registry.js");
type DbModule = typeof import("../db.js");
type LimitsModule = typeof import("../lib/cluster-rate-limit.js");

interface Instance {
  bus: BusModule;
  voice: VoiceModule;
  sockets: SocketsModule;
  registry: RegistryModule;
  db: DbModule;
  limits: LimitsModule;
}

describeDb("rings across two instances", () => {
  const pools: DbModule[] = [];
  const booted: Instance[] = [];
  let hub = createMemoryHub();
  const previousFlag = process.env.VOICE_REGISTRY;

  async function bootInstance(): Promise<Instance> {
    vi.resetModules();
    const bus = (await import("../lib/bus.js")) as BusModule;
    const db = (await import("../db.js")) as DbModule;
    const voice = (await import("./voice.js")) as VoiceModule;
    const sockets = (await import("./sockets.js")) as SocketsModule;
    const registry = (await import("../voice/registry.js")) as RegistryModule;
    const limits = (await import(
      "../lib/cluster-rate-limit.js"
    )) as LimitsModule;
    bus.setBusTransport(bus.createMemoryTransport(hub));
    const instance = { bus, voice, sockets, registry, db, limits };
    booted.push(instance);
    return instance;
  }

  function authedOn(instance: Instance, userId: string): Recorder {
    const rec = recorder();
    instance.sockets.setAuthenticatedSocket(rec.socket, asUser(userId));
    return rec;
  }

  async function joinOn(instance: Instance, rec: Recorder, userId: string) {
    await instance.voice.handleVoiceMessage(
      { socket: rec.socket, user: asUser(userId) },
      { type: "join-voice-room", voiceChannelId: CONVERSATION },
    );
    expect(frame(rec, "welcome")).toBeDefined();
  }

  async function waitFor(check: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 3_000;
    while (!check()) {
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${what}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  beforeAll(async () => {
    vi.resetModules();
    const db = (await import("../db.js")) as DbModule;
    await db.initDb();
    pools.push(db);
  });

  afterAll(async () => {
    await Promise.all(pools.map((db) => db.closePool().catch(() => {})));
  });

  beforeEach(async () => {
    vi.useRealTimers();
    process.env.VOICE_REGISTRY = "postgres";
    hub = createMemoryHub();
    vi.spyOn(console, "log").mockImplementation(() => {});
    await pools[0]!
      .getPool()
      .query(`TRUNCATE voice_rooms, voice_audience_mode, voice_audience_speakers, voice_peers, voice_server_mutes, voice_raised_hands, voice_retired_peers, voice_instances, rate_limit_buckets`);
  });

  afterEach(async () => {
    for (const instance of booted) {
      await instance.registry.settleVoiceRegistryWrites();
      instance.voice.resetConversationCalls();
      instance.voice.resetVoicePeers();
      await instance.bus.closeBus();
      await instance.db.closePool().catch(() => {});
    }
    booted.length = 0;
    process.env.VOICE_REGISTRY = previousFlag;
    vi.restoreAllMocks();
  });

  it("the callee on B rings, and a decline on B reaches the owner on A", async () => {
    fakes.participants.set(CONVERSATION, [CALLER, CALLEE]);
    const a = await bootInstance();
    const b = await bootInstance();
    const caller = authedOn(a, CALLER);
    const calleeOnB = authedOn(b, CALLEE);
    const calleeOnA = authedOn(a, CALLEE);

    await joinOn(a, caller, CALLER);
    await a.voice.handleVoiceMessage(
      { socket: caller.socket, user: asUser(CALLER) },
      { type: "call-ring", conversationId: CONVERSATION },
    );

    // Rung on both machines; owned on one.
    expect(a.voice.isConversationRinging(CONVERSATION)).toBe(true);
    expect(b.voice.isConversationRinging(CONVERSATION)).toBe(false);
    expect(frame(calleeOnB, "call-incoming")).toMatchObject({
      conversationId: CONVERSATION,
      caller: { userId: CALLER },
    });
    expect(frame(calleeOnA, "call-incoming")).toBeDefined();
    expect(fakes.callPushes).toHaveLength(1);

    await b.voice.handleVoiceMessage(
      { socket: calleeOnB.socket, user: asUser(CALLEE) },
      { type: "call-decline", conversationId: CONVERSATION },
    );

    // The owner handled it: the caller hears the decline, the callee's
    // other device stops ringing, and with nobody left the ring is over.
    expect(frame(caller, "call-declined")).toMatchObject({ userId: CALLEE });
    expect(frame(calleeOnA, "call-ring-cancelled")).toMatchObject({
      reason: "declined",
    });
    expect(frame(calleeOnB, "call-ring-cancelled")).toMatchObject({
      reason: "declined",
    });
    expect(a.voice.isConversationRinging(CONVERSATION)).toBe(false);
    await waitFor(() => fakes.createMessageCalls.length === 1, "the missed call");
    expect(fakes.createMessageCalls[0]).toMatchObject({
      channelId: CONVERSATION,
      authorId: CALLER,
      body: MISSED_CALL_BODY,
    });
    // One push, one record: B delivered and routed, it never rang.
    expect(fakes.callPushes).toHaveLength(1);
    expect(fakes.createMessageCalls).toHaveLength(1);
  });

  it("an answer on B ends the ring on A with no missed call", async () => {
    fakes.participants.set(CONVERSATION, [CALLER, CALLEE]);
    const a = await bootInstance();
    const b = await bootInstance();
    const caller = authedOn(a, CALLER);
    const calleeOnB = authedOn(b, CALLEE);
    const calleeOnA = authedOn(a, CALLEE);

    await joinOn(a, caller, CALLER);
    await a.voice.handleVoiceMessage(
      { socket: caller.socket, user: asUser(CALLER) },
      { type: "call-ring", conversationId: CONVERSATION },
    );
    expect(frame(calleeOnB, "call-incoming")).toBeDefined();

    // Accepting is joining the room, on whichever machine.
    await joinOn(b, calleeOnB, CALLEE);

    await waitFor(
      () => !a.voice.isConversationRinging(CONVERSATION),
      "the ring to end on A",
    );
    expect(frame(calleeOnA, "call-ring-cancelled")).toMatchObject({
      reason: "answered",
    });
    // The caller's welcome-time roster and B's join both cross; the call
    // itself is the M2 story. What M4 owns: no record, one push.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fakes.createMessageCalls).toHaveLength(0);
    expect(fakes.callPushes).toHaveLength(1);
  });

  it("a caller already in the call on B is not rung by a ring on A", async () => {
    fakes.participants.set(CONVERSATION, [CALLER, CALLEE, THIRD]);
    const a = await bootInstance();
    const b = await bootInstance();
    const caller = authedOn(a, CALLER);
    const thirdOnB = authedOn(b, THIRD);
    const calleeOnB = authedOn(b, CALLEE);
    await joinOn(b, thirdOnB, THIRD);
    await b.registry.settleVoiceRegistryWrites();

    await joinOn(a, caller, CALLER);
    await a.voice.handleVoiceMessage(
      { socket: caller.socket, user: asUser(CALLER) },
      { type: "call-ring", conversationId: CONVERSATION },
    );

    expect(frame(calleeOnB, "call-incoming")).toBeDefined();
    expect(frame(thirdOnB, "call-incoming")).toBeUndefined();
    expect(fakes.callPushes[0]?.rungUserIds).toEqual([CALLEE]);
  });

  it("the caller hanging up on A ends the ring well before the grace, the callee on B included", async () => {
    fakes.participants.set(CONVERSATION, [CALLER, CALLEE]);
    const a = await bootInstance();
    const b = await bootInstance();
    const caller = authedOn(a, CALLER);
    const calleeOnB = authedOn(b, CALLEE);

    await joinOn(a, caller, CALLER);
    await a.voice.handleVoiceMessage(
      { socket: caller.socket, user: asUser(CALLER) },
      { type: "call-ring", conversationId: CONVERSATION },
    );
    expect(frame(calleeOnB, "call-incoming")).toBeDefined();

    const hungUpAt = Date.now();
    await a.voice.handleVoiceMessage(
      { socket: caller.socket, user: asUser(CALLER) },
      { type: "leave-voice-room" },
    );

    // After the in-flight-join window the rows are read (the call may live
    // on B), then it ends: well inside the grace a reconnect would get.
    await waitFor(
      () => frame(calleeOnB, "call-ring-cancelled") !== undefined,
      "the callee on B to stop ringing",
    );
    const elapsed = Date.now() - hungUpAt;
    expect(elapsed).toBeGreaterThanOrEqual(a.voice.CALL_HANGUP_CONFIRM_MS - 50);
    expect(elapsed).toBeLessThan(a.voice.CALL_EMPTY_ROOM_GRACE_MS - 1_000);
    expect(frame(calleeOnB, "call-ring-cancelled")).toMatchObject({
      reason: "cancelled",
    });
    expect(a.voice.isConversationRinging(CONVERSATION)).toBe(false);
    await waitFor(() => fakes.createMessageCalls.length === 1, "the missed call");
  });

  it("a callee on B picking up as the caller hangs up on A is answered, not missed", async () => {
    fakes.participants.set(CONVERSATION, [CALLER, CALLEE]);
    const a = await bootInstance();
    const b = await bootInstance();
    const caller = authedOn(a, CALLER);
    const calleeOnB = authedOn(b, CALLEE);

    await joinOn(a, caller, CALLER);
    await a.voice.handleVoiceMessage(
      { socket: caller.socket, user: asUser(CALLER) },
      { type: "call-ring", conversationId: CONVERSATION },
    );
    expect(frame(calleeOnB, "call-incoming")).toBeDefined();

    // The hangup and the answer cross: B's join is in flight while A
    // processes the last leave, so A's first look at the rows finds nobody.
    const hangup = a.voice.handleVoiceMessage(
      { socket: caller.socket, user: asUser(CALLER) },
      { type: "leave-voice-room" },
    );
    await joinOn(b, calleeOnB, CALLEE);
    await hangup;

    await waitFor(
      () => !a.voice.isConversationRinging(CONVERSATION),
      "the ring to resolve on A",
    );
    await new Promise((resolve) =>
      setTimeout(resolve, a.voice.CALL_HANGUP_CONFIRM_MS + 200),
    );
    expect(
      framesOf(calleeOnB, "call-ring-cancelled").map((f) => f.reason),
    ).not.toContain("cancelled");
    expect(fakes.createMessageCalls).toHaveLength(0);
  });

  it("the tab-close beacon landing on B ends a ring A owns within the hangup window", async () => {
    fakes.participants.set(CONVERSATION, [CALLER, CALLEE]);
    const a = await bootInstance();
    const b = await bootInstance();
    const caller = authedOn(a, CALLER);
    const calleeOnB = authedOn(b, CALLEE);

    await a.voice.handleVoiceMessage(
      { socket: caller.socket, user: asUser(CALLER) },
      { type: "join-voice-room", voiceChannelId: CONVERSATION, resume: true },
    );
    const welcome = frame(caller, "welcome");
    expect(welcome?.resumeToken).toEqual(expect.any(String));
    await a.voice.handleVoiceMessage(
      { socket: caller.socket, user: asUser(CALLER) },
      { type: "call-ring", conversationId: CONVERSATION },
    );
    expect(frame(calleeOnB, "call-incoming")).toBeDefined();
    await a.registry.settleVoiceRegistryWrites();

    // The tab closes: `/ws` is gone first (A holds the seat for its resume
    // window), then the beacon lands on the other machine.
    a.voice.removeVoicePeerBySocket(caller.socket);
    const closedAt = Date.now();
    await expect(
      b.voice.leaveVoiceByResumeToken(
        welcome!.peerId as string,
        welcome!.resumeToken as string,
      ),
    ).resolves.toBe(true);

    await waitFor(
      () => frame(calleeOnB, "call-ring-cancelled") !== undefined,
      "the callee on B to stop ringing",
    );
    expect(Date.now() - closedAt).toBeLessThan(
      a.voice.CALL_EMPTY_ROOM_GRACE_MS - 1_000,
    );
    expect(frame(calleeOnB, "call-ring-cancelled")).toMatchObject({
      reason: "cancelled",
    });
    await waitFor(() => fakes.createMessageCalls.length === 1, "the missed call");
  });

  it("a hangup on A does not end the ring while somebody is in the call on B", async () => {
    fakes.participants.set(CONVERSATION, [CALLER, CALLEE, THIRD]);
    const a = await bootInstance();
    const b = await bootInstance();
    const caller = authedOn(a, CALLER);
    const thirdOnB = authedOn(b, THIRD);
    const calleeOnB = authedOn(b, CALLEE);
    await joinOn(b, thirdOnB, THIRD);
    await b.registry.settleVoiceRegistryWrites();

    await joinOn(a, caller, CALLER);
    await a.voice.handleVoiceMessage(
      { socket: caller.socket, user: asUser(CALLER) },
      { type: "call-ring", conversationId: CONVERSATION },
    );
    expect(frame(calleeOnB, "call-incoming")).toBeDefined();

    await a.voice.handleVoiceMessage(
      { socket: caller.socket, user: asUser(CALLER) },
      { type: "leave-voice-room" },
    );
    await a.registry.settleVoiceRegistryWrites();
    // Past the hangup window, so the rows were actually read.
    await new Promise((resolve) =>
      setTimeout(resolve, a.voice.CALL_HANGUP_CONFIRM_MS + 300),
    );

    // A is empty; the call is not. The callee can still answer into it.
    expect(a.voice.isConversationRinging(CONVERSATION)).toBe(true);
    expect(frame(calleeOnB, "call-ring-cancelled")).toBeUndefined();
    expect(fakes.createMessageCalls).toHaveLength(0);
  });

  it("a registry that cannot be read after a hangup ends the ring at the grace, not the ring timeout", async () => {
    fakes.participants.set(CONVERSATION, [CALLER, CALLEE]);
    const a = await bootInstance();
    const b = await bootInstance();
    const caller = authedOn(a, CALLER);
    const calleeOnB = authedOn(b, CALLEE);

    await joinOn(a, caller, CALLER);
    await a.voice.handleVoiceMessage(
      { socket: caller.socket, user: asUser(CALLER) },
      { type: "call-ring", conversationId: CONVERSATION },
    );
    await a.registry.settleVoiceRegistryWrites();
    // Every read A makes from here on fails: the hangup window's, and then
    // the grace's. A's next pool dials a port nothing listens on; B keeps
    // the pool it already has.
    const realUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgresql://nobody:nothing@127.0.0.1:1/none";
    onTestFinished(() => {
      process.env.DATABASE_URL = realUrl;
    });
    await a.db.closePool();
    const hungUpAt = Date.now();
    await a.voice.handleVoiceMessage(
      { socket: caller.socket, user: asUser(CALLER) },
      { type: "leave-voice-room" },
    );

    await new Promise((resolve) =>
      setTimeout(resolve, a.voice.CALL_HANGUP_CONFIRM_MS + 300),
    );
    // A failed read in the short window ends nothing on its own.
    expect(a.voice.isConversationRinging(CONVERSATION)).toBe(true);

    const deadline = hungUpAt + a.voice.CALL_EMPTY_ROOM_GRACE_MS + 2_000;
    while (frame(calleeOnB, "call-ring-cancelled") === undefined) {
      if (Date.now() > deadline) {
        throw new Error("the ring outlived the grace");
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // The grace's own read failed too, and a failed grace read ends the
    // ring, as it always has.
    expect(Date.now() - hungUpAt).toBeGreaterThanOrEqual(
      a.voice.CALL_EMPTY_ROOM_GRACE_MS - 50,
    );
    expect(frame(calleeOnB, "call-ring-cancelled")).toMatchObject({
      reason: "cancelled",
    });
  });

  it("a row the hangup window still sees gets a second look at the grace, not the ring timeout", async () => {
    fakes.participants.set(CONVERSATION, [CALLER, CALLEE, THIRD]);
    const a = await bootInstance();
    const b = await bootInstance();
    const caller = authedOn(a, CALLER);
    const thirdOnB = authedOn(b, THIRD);
    const calleeOnB = authedOn(b, CALLEE);
    await joinOn(b, thirdOnB, THIRD);
    await b.registry.settleVoiceRegistryWrites();

    await joinOn(a, caller, CALLER);
    await a.voice.handleVoiceMessage(
      { socket: caller.socket, user: asUser(CALLER) },
      { type: "call-ring", conversationId: CONVERSATION },
    );
    const hungUpAt = Date.now();
    await a.voice.handleVoiceMessage(
      { socket: caller.socket, user: asUser(CALLER) },
      { type: "leave-voice-room" },
    );
    await new Promise((resolve) =>
      setTimeout(resolve, a.voice.CALL_HANGUP_CONFIRM_MS + 300),
    );
    // The window's read saw B's row, so the ring is still up.
    expect(a.voice.isConversationRinging(CONVERSATION)).toBe(true);

    // The row goes after that read (a beacon's delete on B landing late
    // looks the same from A). Nothing on A hears about it.
    b.voice.removeVoicePeerBySocket(thirdOnB.socket);
    await b.registry.settleVoiceRegistryWrites();

    const deadline = hungUpAt + a.voice.CALL_EMPTY_ROOM_GRACE_MS + 2_000;
    while (frame(calleeOnB, "call-ring-cancelled") === undefined) {
      if (Date.now() > deadline) {
        throw new Error("the ring outlived the grace");
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(Date.now() - hungUpAt).toBeGreaterThanOrEqual(
      a.voice.CALL_EMPTY_ROOM_GRACE_MS - 50,
    );
    expect(frame(calleeOnB, "call-ring-cancelled")).toMatchObject({
      reason: "cancelled",
    });
    expect(a.voice.isConversationRinging(CONVERSATION)).toBe(false);
  });

  /**
   * FIVE RINGS PER FIVE MINUTES IS A NUMBER AIMED AT THE PERSON BEING BUZZED,
   * and until this it was five PER MACHINE. A caller with a tab on each got
   * ten, and nothing anywhere said so — the in-memory limiter on A cannot see
   * what B has spent, by construction.
   *
   * The budget is spent from B here and the ring attempted on A, because that
   * is the only arrangement that fails when the bucket is per process and
   * passes when it is shared. A's own limiter is untouched in both cases.
   */
  it("spends ONE ring budget across two machines", async () => {
    fakes.participants.set(CONVERSATION, [CALLER, CALLEE]);
    const a = await bootInstance();
    const b = await bootInstance();
    const caller = authedOn(a, CALLER);
    const calleeOnB = authedOn(b, CALLEE);
    await joinOn(a, caller, CALLER);

    const budget = b.voice.RING_BUDGET;
    for (let i = 0; i < budget.capacity; i += 1) {
      expect(await b.limits.sharedRateLimit(budget, CALLER)).toBe(true);
    }

    await a.voice.handleVoiceMessage(
      { socket: caller.socket, user: asUser(CALLER) },
      { type: "call-ring", conversationId: CONVERSATION },
    );

    expect(a.voice.isConversationRinging(CONVERSATION)).toBe(false);
    expect(frame(calleeOnB, "call-incoming")).toBeUndefined();
    expect(fakes.callPushes).toHaveLength(0);
  });

  /**
   * The budget is spent immediately before the ring is committed, not on the
   * way in. A stale socket, a forged conversation id or a room where nobody
   * is absent are all rejections, and letting any of them burn a token would
   * let a misbehaving client spend somebody's five-per-five-minutes without a
   * single ring being delivered — cluster-wide, so not even recoverable by
   * reconnecting to the other machine.
   */
  it("does not spend the cluster token on a ring it refuses", async () => {
    fakes.participants.set(CONVERSATION, [CALLER, CALLEE]);
    const a = await bootInstance();
    const caller = authedOn(a, CALLER);
    await joinOn(a, caller, CALLER);

    // A conversation the caller holds no peer for: refused at the peer check,
    // which is above the spend.
    await a.voice.handleVoiceMessage(
      { socket: caller.socket, user: asUser(CALLER) },
      { type: "call-ring", conversationId: randomUUID() },
    );

    const rows = await pools[0]!.getPool().query(
      `SELECT 1 FROM rate_limit_buckets WHERE bucket = $1 AND subject = $2`,
      [a.voice.RING_BUDGET.bucket, CALLER],
    );
    expect(rows.rowCount).toBe(0);
  });

  it("rings, and the cluster bucket is what it spent", async () => {
    fakes.participants.set(CONVERSATION, [CALLER, CALLEE]);
    const a = await bootInstance();
    const b = await bootInstance();
    const caller = authedOn(a, CALLER);
    const calleeOnB = authedOn(b, CALLEE);
    await joinOn(a, caller, CALLER);

    await a.voice.handleVoiceMessage(
      { socket: caller.socket, user: asUser(CALLER) },
      { type: "call-ring", conversationId: CONVERSATION },
    );
    expect(frame(calleeOnB, "call-incoming")).toBeDefined();

    // The row is the state, and the other machine reads the same row: four
    // of five left, whichever machine asks next.
    const row = await pools[0]!.getPool().query<{ tokens: string }>(
      `SELECT tokens::text FROM rate_limit_buckets
        WHERE bucket = $1 AND subject = $2`,
      [a.voice.RING_BUDGET.bucket, CALLER],
    );
    expect(Number(row.rows[0]?.tokens)).toBeCloseTo(
      a.voice.RING_BUDGET.capacity - 1,
      1,
    );
  });
});
