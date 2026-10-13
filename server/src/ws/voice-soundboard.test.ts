import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { DbUser } from "../db.js";

/**
 * A soundboard play is a room event. The person who is not in the room
 * hears nothing, a missing USE_SOUNDBOARD hears nothing, and the people
 * who are seated get one frame. All of it behind the `soundboard` runtime
 * flag, read from `SOUNDBOARD` here because the flag snapshot never starts in
 * a unit test.
 */

const bits = vi.hoisted(() => ({ byUser: new Map<string, bigint>() }));

vi.mock("../services/permissions.js", async () => {
  const { PERMISSION_DEFAULT_EVERYONE } = await import("@pqp/shared");
  const forUser = (userId: string) =>
    bits.byUser.get(userId) ?? PERMISSION_DEFAULT_EVERYONE;
  return {
    computeMemberPermissions: async (_serverId: string, userId: string) =>
      forUser(userId),
    resolveMemberChannelPermissions: async (
      _serverId: string,
      userId: string,
    ) => ({ permissions: forUser(userId), nickname: null }),
  };
});

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

const SERVER = randomUUID();
const STAGE = randomUUID();
const OTHER = randomUUID();

vi.mock("../services/servers.js", () => ({
  getChannel: async (id: string) => {
    if (id === OTHER) {
      return { id, kind: "conversation", type: "text", server_id: null };
    }
    return { id, kind: "server", type: "voice", server_id: SERVER };
  },
  getChannelAudience: async () => null,
}));

vi.mock("../voice/admin.js", () => ({
  evictSfuRoom: vi.fn(() => Promise.resolve()),
  evictSfuUser: vi.fn(() => Promise.resolve()),
  evictSfuUsersExcept: vi.fn(() => Promise.resolve()),
  setSfuUserCanPublish: vi.fn(() => Promise.resolve(true)),
}));

vi.mock("../voice/backends.js", () => ({
  getServerVoiceBackend: () => "mesh",
  isLiveKitConfigured: () => false,
}));

const {
  handleVoiceMessage,
  isVoiceUserServerMuted,
  resetVoicePeers,
  resetVoiceRateLimits,
  resetVoiceRoomTransports,
  setVoiceUserServerMuted,
} = await import("./voice.js");
const { resetSoundboardPlays } = await import("./soundboard.js");
const { Permission } = await import("@pqp/shared");

interface Frame {
  type: string;
  soundId?: string;
  userId?: string;
  displayName?: string;
  emoji?: string;
  channelId?: string;
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
    display_name: `User ${id}`,
    avatar_url: null,
  } as unknown as DbUser;
}

function plays(rec: Recorder): Frame[] {
  return rec.frames.filter((frame) => frame.type === "soundboard-play");
}

async function join(rec: Recorder, userId: string, voiceChannelId = STAGE) {
  await handleVoiceMessage(
    { socket: rec.socket, user: asUser(userId) },
    { type: "join-voice-room", voiceChannelId },
  );
  rec.frames.length = 0;
  return rec;
}

describe("soundboard fan-out", () => {
  beforeEach(() => {
    resetVoicePeers();
    resetVoiceRateLimits();
    resetVoiceRoomTransports();
    resetSoundboardPlays();
    bits.byUser.clear();
    process.env.SOUNDBOARD = "true";
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.SOUNDBOARD;
  });

  it("plays a built-in clip for everyone seated in the room", async () => {
    const a = await join(recorder(), "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const b = await join(recorder(), "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    await handleVoiceMessage(
      {
        socket: a.socket,
        user: asUser("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
      },
      {
        type: "soundboard-play",
        channelId: STAGE,
        soundId: "builtin:palmas",
      },
    );
    expect(plays(a)).toHaveLength(1);
    expect(plays(b)).toEqual(plays(a));
    expect(plays(b)[0]).toMatchObject({
      channelId: STAGE,
      soundId: "builtin:palmas",
      userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      displayName: "User aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      emoji: "👏",
    });
  });

  it("drops a play from somebody without USE_SOUNDBOARD", async () => {
    const quiet = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    bits.byUser.set(quiet, Permission.CONNECT | Permission.SPEAK);
    const rec = await join(recorder(), quiet);
    const other = await join(recorder(), "dddddddd-dddd-4ddd-8ddd-dddddddddddd");
    await handleVoiceMessage(
      { socket: rec.socket, user: asUser(quiet) },
      { type: "soundboard-play", channelId: STAGE, soundId: "builtin:palmas" },
    );
    expect(plays(rec)).toHaveLength(0);
    expect(plays(other)).toHaveLength(0);
  });

  it("with the flag off, a play is dropped", async () => {
    delete process.env.SOUNDBOARD;
    const id = "11111111-1111-4111-8111-111111111111";
    const rec = await join(recorder(), id);
    const other = await join(recorder(), "22222222-2222-4222-8222-222222222222");
    await handleVoiceMessage(
      { socket: rec.socket, user: asUser(id) },
      { type: "soundboard-play", channelId: STAGE, soundId: "builtin:palmas" },
    );
    expect(plays(rec)).toHaveLength(0);
    expect(plays(other)).toHaveLength(0);
  });

  it("plays once the flag goes on mid-call, with no rejoin", async () => {
    delete process.env.SOUNDBOARD;
    const id = "66666666-6666-4666-8666-666666666666";
    const rec = await join(recorder(), id);
    process.env.SOUNDBOARD = "true";
    await handleVoiceMessage(
      { socket: rec.socket, user: asUser(id) },
      { type: "soundboard-play", channelId: STAGE, soundId: "builtin:palmas" },
    );
    expect(plays(rec)).toHaveLength(1);
  });

  it("drops a play once the flag goes off mid-call", async () => {
    const id = "33333333-3333-4333-8333-333333333333";
    const rec = await join(recorder(), id);
    delete process.env.SOUNDBOARD;
    await handleVoiceMessage(
      { socket: rec.socket, user: asUser(id) },
      { type: "soundboard-play", channelId: STAGE, soundId: "builtin:palmas" },
    );
    expect(plays(rec)).toHaveLength(0);
  });

  it("drops a play from a seat that may not speak (a closed watch party floor)", async () => {
    const listener = "44444444-4444-4444-8444-444444444444";
    bits.byUser.set(listener, Permission.CONNECT | Permission.USE_SOUNDBOARD);
    const rec = await join(recorder(), listener);
    const other = await join(recorder(), "55555555-5555-4555-8555-555555555555");
    await handleVoiceMessage(
      { socket: rec.socket, user: asUser(listener) },
      { type: "soundboard-play", channelId: STAGE, soundId: "builtin:palmas" },
    );
    expect(plays(rec)).toHaveLength(0);
    expect(plays(other)).toHaveLength(0);
  });

  it("drops a play from a deafened seat, and plays again after undeafening", async () => {
    const id = "77777777-7777-4777-8777-777777777777";
    const rec = await join(recorder(), id);
    const other = await join(recorder(), "88888888-8888-4888-8888-888888888888");
    const state = (deafened: boolean) =>
      handleVoiceMessage(
        { socket: rec.socket, user: asUser(id) },
        { type: "set-voice-state", muted: false, deafened },
      );
    const play = () =>
      handleVoiceMessage(
        { socket: rec.socket, user: asUser(id) },
        { type: "soundboard-play", channelId: STAGE, soundId: "builtin:palmas" },
      );
    await state(true);
    await play();
    expect(plays(other)).toHaveLength(0);
    await state(false);
    await play();
    expect(plays(other)).toHaveLength(1);
  });

  it("drops a play from a seat the moderator muted", async () => {
    const id = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const rec = await join(recorder(), id);
    expect(isVoiceUserServerMuted(STAGE, id)).toBe(false);
    await setVoiceUserServerMuted(STAGE, id, true);
    rec.frames.length = 0;
    await handleVoiceMessage(
      { socket: rec.socket, user: asUser(id) },
      { type: "soundboard-play", channelId: STAGE, soundId: "builtin:grilo" },
    );
    expect(plays(rec)).toHaveLength(0);
  });

  it("does not play into a conversation", async () => {
    const rec = await join(
      recorder(),
      "ffffffff-ffff-4fff-8fff-ffffffffffff",
      OTHER,
    );
    await handleVoiceMessage(
      {
        socket: rec.socket,
        user: asUser("ffffffff-ffff-4fff-8fff-ffffffffffff"),
      },
      { type: "soundboard-play", channelId: OTHER, soundId: "builtin:palmas" },
    );
    expect(plays(rec)).toHaveLength(0);
  });
});
