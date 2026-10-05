import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { DbUser } from "../db.js";

/**
 * What `set-sharing-screen` tells the start-of-stream notice, and when.
 *
 * The notice is armed from the socket handler, so the rule for WHEN is the part
 * that can go wrong in the handler itself: a start is a change from not
 * sharing to sharing in a server's plain voice room, and nothing else. A
 * re-declare of a running share (an audio id arriving, a rejoin) is not one, a
 * watch party's start is its going live (`broadcastWatchParty`), and a DM call
 * never notifies. No database: the notice is a spy, the service layer under the
 * peer bookkeeping is faked, exactly as `voice-state.test.ts` does it.
 */

const alerts = vi.hoisted(() => ({
  started: vi.fn(),
  stopped: vi.fn(),
  reader: vi.fn(),
}));

vi.mock("../services/stream-alerts.js", () => ({
  noteStreamStarted: (start: unknown) => alerts.started(start),
  noteStreamStopped: (channelId: string, userId?: string) =>
    alerts.stopped(channelId, userId),
  setStreamAlertRoomReader: (reader: unknown) => alerts.reader(reader),
}));

const channel = vi.hoisted(() => ({
  row: { kind: "server", type: "voice" } as { kind: string; type: string },
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
  resolveRingableConversation: async () => null,
}));

vi.mock("../services/servers.js", () => ({
  getChannel: async () => channel.row,
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

const { handleVoiceMessage, resetVoicePeers, resetVoiceRateLimits, resetVoiceRoomTransports } =
  await import("./voice.js");

const ROOM = randomUUID();

function recorder(): { socket: WebSocket } {
  return {
    socket: { readyState: 1, send: () => {}, on: () => {} } as unknown as WebSocket,
  };
}

function asUser(id: string): DbUser {
  return { id, display_name: `User ${id}`, avatar_url: null } as unknown as DbUser;
}

async function join(rec: { socket: WebSocket }, userId: string): Promise<void> {
  await handleVoiceMessage(
    { socket: rec.socket, user: asUser(userId) },
    { type: "join-voice-room", voiceChannelId: ROOM },
  );
}

async function share(
  rec: { socket: WebSocket },
  userId: string,
  sharing: boolean,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await handleVoiceMessage(
    { socket: rec.socket, user: asUser(userId) },
    { type: "set-sharing-screen", sharing, ...extra },
  );
}

describe("set-sharing-screen and the start-of-stream notice", () => {
  beforeEach(() => {
    alerts.started.mockClear();
    alerts.stopped.mockClear();
    resetVoicePeers();
    resetVoiceRateLimits();
    resetVoiceRoomTransports();
    channel.row = { kind: "server", type: "voice" };
  });

  it("registers its room reader with the notice when the voice layer loads", () => {
    expect(alerts.reader).toHaveBeenCalledTimes(1);
    expect(typeof alerts.reader.mock.calls[0]![0]).toBe("function");
  });

  it("reports a start once, and a stop once", async () => {
    const rec = recorder();
    await join(rec, "alberto");
    await share(rec, "alberto", true);
    expect(alerts.started).toHaveBeenCalledTimes(1);
    expect(alerts.started.mock.calls[0]![0]).toMatchObject({
      channelId: ROOM,
      sharerUserId: "alberto",
      sharerName: "User alberto",
      kind: "voice",
    });
    await share(rec, "alberto", false);
    expect(alerts.stopped).toHaveBeenCalledWith(ROOM, "alberto");
  });

  it("does not read a re-declare of a running share as a start", async () => {
    const rec = recorder();
    await join(rec, "alberto");
    await share(rec, "alberto", true);
    // The audio id arriving a moment later re-declares the same share.
    await share(rec, "alberto", true, { audioStreamId: "cap-1" });
    await share(rec, "alberto", true, { audioStreamId: "cap-1" });
    expect(alerts.started).toHaveBeenCalledTimes(1);
  });

  it("never reports a stop for a share that was not on", async () => {
    const rec = recorder();
    await join(rec, "alberto");
    await share(rec, "alberto", false);
    expect(alerts.stopped).not.toHaveBeenCalled();
    expect(alerts.started).not.toHaveBeenCalled();
  });

  it("does not report a share in a watch party channel (its start is going live)", async () => {
    channel.row = { kind: "server", type: "watch_party" };
    const rec = recorder();
    await join(rec, "host");
    await share(rec, "host", true);
    expect(alerts.started).not.toHaveBeenCalled();
  });

  it("does not report a call in a conversation (it rings instead)", async () => {
    channel.row = { kind: "dm", type: "voice" };
    const rec = recorder();
    await join(rec, "caller");
    await share(rec, "caller", true);
    expect(alerts.started).not.toHaveBeenCalled();
  });
});
