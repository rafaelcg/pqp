import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { DbUser } from "../db.js";
import { MESH_VOICE_LIMIT } from "@pqp/shared";
import { mintVoiceResumeToken, VOICE_RESUME_TTL_MS } from "./voice-resume-token.js";

/**
 * Voice session resume: a brief signaling outage (Fly deploy, socket blip)
 * must reattach the same peer id without broadcasting `peer-left`, so held
 * WebRTC / LiveKit media stays up. These tests pin the server half.
 */

const backend = vi.hoisted(() => ({ configured: "mesh" as "mesh" | "livekit" }));

vi.mock("../voice/backends.js", () => ({
  getServerVoiceBackend: () => backend.configured,
  isLiveKitConfigured: () => backend.configured === "livekit",
}));

vi.mock("../services/users.js", () => ({
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
  getChannelAudience: async () => null,
}));

vi.mock("../voice/admin.js", () => ({
  evictSfuRoom: vi.fn(() => Promise.resolve()),
  evictSfuUser: vi.fn(() => Promise.resolve()),
  evictSfuUsersExcept: vi.fn(() => Promise.resolve()),
}));

const {
  evictVoiceUser,
  getRoomTransport,
  handleVoiceMessage,
  removeVoicePeerBySocket,
  resetVoicePeers,
  resetVoiceRateLimits,
  resetVoiceRoomTransports,
} = await import("./voice.js");

interface Frame {
  type: string;
  [key: string]: unknown;
}

interface Recorder {
  socket: WebSocket;
  frames: Frame[];
}

function recorder(): Recorder {
  const frames: Frame[] = [];
  const socket = {
    readyState: 1,
    send: (payload: string) => frames.push(JSON.parse(payload) as Frame),
    on: () => {},
  } as unknown as WebSocket;
  return { socket, frames };
}

function asUser(id: string): DbUser {
  return {
    id,
    display_name: `User ${id.slice(0, 8)}`,
    avatar_url: null,
  } as unknown as DbUser;
}

function frame(rec: Recorder, type: string): Frame | undefined {
  return rec.frames.find((f) => f.type === type);
}

function typesOf(rec: Recorder): string[] {
  return rec.frames.map((f) => f.type);
}

const previousClerk = process.env.CLERK_SECRET_KEY;
const previousBypass = process.env.DEV_AUTH_BYPASS;

beforeEach(() => {
  process.env.CLERK_SECRET_KEY = "sk_test_voice_resume";
  delete process.env.DEV_AUTH_BYPASS;
  resetVoicePeers();
  resetVoiceRateLimits();
  resetVoiceRoomTransports();
  backend.configured = "mesh";
});

afterEach(() => {
  process.env.CLERK_SECRET_KEY = previousClerk;
  process.env.DEV_AUTH_BYPASS = previousBypass;
  resetVoicePeers();
  vi.useRealTimers();
});

async function join(
  rec: Recorder,
  userId: string,
  voiceChannelId: string,
  extra?: { resumePeerId?: string; resumeToken?: string; transports?: ("mesh" | "livekit")[] },
): Promise<Recorder> {
  await handleVoiceMessage(
    { socket: rec.socket, user: asUser(userId) },
    {
      type: "join-voice-room",
      voiceChannelId,
      ...(extra?.transports ? { transports: extra.transports } : {}),
      ...(extra?.resumePeerId ? { resumePeerId: extra.resumePeerId } : {}),
      ...(extra?.resumeToken ? { resumeToken: extra.resumeToken } : {}),
    },
  );
  return rec;
}

describe("voice session resume", () => {
  it("reattaches the same peer id after a socket close, without peer-left", async () => {
    const channel = randomUUID();
    const userId = randomUUID();
    const a = await join(recorder(), userId, channel);
    const observer = await join(recorder(), randomUUID(), channel);
    const peerId = frame(a, "welcome")?.peerId as string;
    const token = frame(a, "welcome")?.resumeToken as string;
    expect(peerId).toBeTruthy();
    expect(token).toBeTruthy();

    observer.frames.length = 0;
    removeVoicePeerBySocket(a.socket);
    expect(typesOf(observer)).not.toContain("peer-left");

    const resumed = recorder();
    await join(resumed, userId, channel, {
      resumePeerId: peerId,
      resumeToken: token,
    });

    const welcome = frame(resumed, "welcome");
    expect(welcome?.peerId).toBe(peerId);
    expect(welcome?.resumed).toBe(true);
    expect(typesOf(observer)).toContain("peer-joined");
    expect(typesOf(observer)).not.toContain("peer-left");
  });

  it("broadcasts peer-left once the orphan TTL expires", async () => {
    const channel = randomUUID();
    const userId = randomUUID();
    const a = await join(recorder(), userId, channel);
    const observer = await join(recorder(), randomUUID(), channel);
    const peerId = frame(a, "welcome")?.peerId as string;

    vi.useFakeTimers();
    observer.frames.length = 0;
    removeVoicePeerBySocket(a.socket);
    expect(typesOf(observer)).not.toContain("peer-left");

    await vi.advanceTimersByTimeAsync(VOICE_RESUME_TTL_MS + 1);

    expect(typesOf(observer)).toContain("peer-left");
    expect(frame(observer, "peer-left")?.peerId).toBe(peerId);
  });

  it("reconstructs two peers with their claimed ids after an empty process", async () => {
    const channel = randomUUID();
    const userA = randomUUID();
    const userB = randomUUID();
    const first = await join(recorder(), userA, channel);
    const second = await join(recorder(), userB, channel);
    const idA = frame(first, "welcome")?.peerId as string;
    const tokA = frame(first, "welcome")?.resumeToken as string;
    const idB = frame(second, "welcome")?.peerId as string;
    const tokB = frame(second, "welcome")?.resumeToken as string;

    resetVoicePeers();
    resetVoiceRoomTransports();

    const againA = await join(recorder(), userA, channel, {
      resumePeerId: idA,
      resumeToken: tokA,
    });
    const againB = await join(recorder(), userB, channel, {
      resumePeerId: idB,
      resumeToken: tokB,
    });

    expect(frame(againA, "welcome")?.peerId).toBe(idA);
    expect(frame(againA, "welcome")?.resumed).toBe(true);
    expect(frame(againB, "welcome")?.peerId).toBe(idB);
    expect(frame(againB, "welcome")?.resumed).toBe(true);
  });

  it("ignores a stolen id and still lets the owner resume", async () => {
    const channel = randomUUID();
    const ownerId = randomUUID();
    const thiefId = randomUUID();
    const owner = await join(recorder(), ownerId, channel);
    const peerId = frame(owner, "welcome")?.peerId as string;
    const token = frame(owner, "welcome")?.resumeToken as string;

    resetVoicePeers();
    resetVoiceRoomTransports();

    const thief = await join(recorder(), thiefId, channel, {
      resumePeerId: peerId,
      resumeToken: token,
    });
    expect(frame(thief, "welcome")?.peerId).not.toBe(peerId);
    expect(frame(thief, "welcome")?.resumed).toBeUndefined();

    const ownerAgain = await join(recorder(), ownerId, channel, {
      resumePeerId: peerId,
      resumeToken: token,
    });
    expect(frame(ownerAgain, "welcome")?.peerId).toBe(peerId);
    expect(frame(ownerAgain, "welcome")?.resumed).toBe(true);
  });

  it("cold-joins when the resume token is missing", async () => {
    const channel = randomUUID();
    const userId = randomUUID();
    const first = await join(recorder(), userId, channel);
    const peerId = frame(first, "welcome")?.peerId as string;

    resetVoicePeers();
    resetVoiceRoomTransports();

    const again = await join(recorder(), userId, channel, {
      resumePeerId: peerId,
    });
    expect(frame(again, "welcome")?.peerId).not.toBe(peerId);
    expect(frame(again, "welcome")?.resumed).toBeUndefined();
  });

  it("cold-joins after the same user's orphans have filled the mesh", async () => {
    const channel = randomUUID();
    const userId = randomUUID();
    const seats: Recorder[] = [];
    for (let i = 0; i < MESH_VOICE_LIMIT; i++) {
      seats.push(await join(recorder(), userId, channel));
    }
    for (const rec of seats) {
      removeVoicePeerBySocket(rec.socket);
    }

    const again = await join(recorder(), userId, channel);
    expect(frame(again, "welcome")).toBeTruthy();
    expect(typesOf(again)).not.toContain("voice-room-full");
  });

  it("admits a resume into a full mesh of orphans", async () => {
    const channel = randomUUID();
    const occupants: { rec: Recorder; userId: string; peerId: string; token: string }[] =
      [];
    for (let i = 0; i < MESH_VOICE_LIMIT; i++) {
      const userId = randomUUID();
      const rec = await join(recorder(), userId, channel);
      occupants.push({
        rec,
        userId,
        peerId: frame(rec, "welcome")?.peerId as string,
        token: frame(rec, "welcome")?.resumeToken as string,
      });
    }

    for (const occupant of occupants) {
      removeVoicePeerBySocket(occupant.rec.socket);
    }

    const first = occupants[0]!;
    const resumed = await join(recorder(), first.userId, channel, {
      resumePeerId: first.peerId,
      resumeToken: first.token,
    });
    expect(frame(resumed, "welcome")?.peerId).toBe(first.peerId);
    expect(frame(resumed, "welcome")?.resumed).toBe(true);
    expect(typesOf(resumed)).not.toContain("voice-room-full");
  });

  it("removes a peer immediately on leave-voice-room", async () => {
    const channel = randomUUID();
    const userId = randomUUID();
    const a = await join(recorder(), userId, channel);
    const observer = await join(recorder(), randomUUID(), channel);
    const peerId = frame(a, "welcome")?.peerId as string;

    observer.frames.length = 0;
    await handleVoiceMessage(
      { socket: a.socket, user: asUser(userId) },
      { type: "leave-voice-room" },
    );

    expect(frame(observer, "peer-left")?.peerId).toBe(peerId);
  });

  it("removes a kicked peer immediately and refuses reconstruct of that id", async () => {
    const channel = randomUUID();
    const userId = randomUUID();
    const target = await join(recorder(), userId, channel);
    const observer = await join(recorder(), randomUUID(), channel);
    const peerId = frame(target, "welcome")?.peerId as string;
    const token = frame(target, "welcome")?.resumeToken as string;

    observer.frames.length = 0;
    evictVoiceUser(userId);

    expect(frame(observer, "peer-left")?.peerId).toBe(peerId);

    const again = await join(recorder(), userId, channel, {
      resumePeerId: peerId,
      resumeToken: token,
    });
    expect(frame(again, "welcome")?.peerId).not.toBe(peerId);
    expect(frame(again, "welcome")?.resumed).toBeUndefined();
  });

  it("pins transport from the resume token across reconstruct", async () => {
    const channel = randomUUID();
    const userId = randomUUID();
    backend.configured = "livekit";
    const first = await join(recorder(), userId, channel, {
      transports: ["mesh", "livekit"],
    });
    expect(frame(first, "welcome")?.transport).toBe("livekit");
    const peerId = frame(first, "welcome")?.peerId as string;
    const token = frame(first, "welcome")?.resumeToken as string;

    resetVoicePeers();
    resetVoiceRoomTransports();
    backend.configured = "mesh";

    const again = await join(recorder(), userId, channel, {
      resumePeerId: peerId,
      resumeToken: token,
      transports: ["mesh", "livekit"],
    });
    expect(frame(again, "welcome")?.transport).toBe("livekit");
    expect(frame(again, "welcome")?.peerId).toBe(peerId);
    expect(getRoomTransport(channel)).toBe("livekit");
  });

  it("does not reconstruct a token minted for a different transport than claimed", async () => {
    const channel = randomUUID();
    const userId = randomUUID();
    const peerId = randomUUID();
    const token = mintVoiceResumeToken({
      userId,
      peerId,
      voiceChannelId: channel,
      transport: "livekit",
    })!;

    const rec = await join(recorder(), userId, channel, {
      resumePeerId: peerId,
      resumeToken: token,
      transports: ["mesh"],
    });
    expect(frame(rec, "welcome")?.peerId).not.toBe(peerId);
    expect(frame(rec, "welcome")?.transport).toBe("mesh");
  });
});
