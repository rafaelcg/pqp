import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { DbUser } from "../db.js";

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
  CALL_RING_TIMEOUT_MS,
  MISSED_CALL_BODY,
  handleVoiceMessage,
  isConversationRinging,
  removeVoicePeerBySocket,
  resetConversationCalls,
  resetVoiceRateLimits,
  resetVoiceRoomTransports,
} = await import("./voice.js");

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
  resetConversationCalls();
});

afterEach(() => {
  for (const socket of registered.splice(0)) {
    removeVoicePeerBySocket(socket);
    deleteAuthenticatedSocket(socket);
  }
  resetConversationCalls();
  vi.useRealTimers();
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

  it("the caller hanging up cancels the ring (after the rejoin grace) and records the miss", async () => {
    const caller = authedRecorder(CALLER);
    const callee = authedRecorder(CALLEE);

    await startCall(caller);
    await handleVoiceMessage(
      { socket: caller.socket, user: asUser(CALLER) },
      { type: "leave-voice-room" },
    );

    // Inside the grace window the ring survives (a reconnect looks identical).
    expect(isConversationRinging(CONVERSATION)).toBe(true);

    await vi.advanceTimersByTimeAsync(CALL_EMPTY_ROOM_GRACE_MS + 1);

    expect(isConversationRinging(CONVERSATION)).toBe(false);
    expect(frame(callee, "call-ring-cancelled")?.reason).toBe("cancelled");
    expect(fakes.createMessageCalls).toEqual([
      { channelId: CONVERSATION, authorId: CALLER, body: MISSED_CALL_BODY },
    ]);
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
