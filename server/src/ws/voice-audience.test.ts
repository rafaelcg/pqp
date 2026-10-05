import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { DbUser } from "../db.js";

/**
 * AUDIENCE MODE, one process (`docs/plans/AUDIENCE_MODE.md`).
 *
 * The SFU is a small stateful fake of LiveKit's RoomService: participants
 * hold a permission and published tracks, `updateParticipant` rewrites the
 * permission, `mutePublishedTrack` mutes, and `tryToSpeak` is what a client
 * (honest or patched) can do: unmute its mic, which the fake refuses unless
 * the permission allows the microphone source. So "a connected listener is
 * silenced" is asserted on the media server's state, not on a frame the
 * client could ignore. The real `voice/admin.ts` runs against it.
 *
 * The two-machine half (registry on, real Postgres) is
 * `voice-audience-cluster.test.ts`; the routes are
 * `api/voice-audience.test.ts`; the region routing is
 * `voice/audience-sfu.test.ts`.
 */

const SERVER = randomUUID();
const ROOM = randomUUID();
const MESH_ROOM = randomUUID();

/** userId -> resolved bits. Absent: @everyone (SPEAK on). */
const bits = vi.hoisted(() => ({ byUser: new Map<string, bigint>() }));

vi.mock("../services/permissions.js", async () => {
  const { PERMISSION_DEFAULT_EVERYONE } = await import("@pqp/shared");
  const forUser = (userId: string) => bits.byUser.get(userId) ?? PERMISSION_DEFAULT_EVERYONE;
  return {
    computeMemberPermissions: async (_serverId: string, userId: string) => forUser(userId),
    resolveMemberChannelPermissions: async (_serverId: string, userId: string) => ({
      permissions: forUser(userId),
      nickname: null,
    }),
  };
});

vi.mock("../services/users.js", () => ({
  resolveMemberName: async (_serverId: string | null, user: { display_name: string }) =>
    user.display_name,
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

const channels = vi.hoisted(() => ({ rows: new Map<string, Record<string, unknown>>() }));

vi.mock("../services/servers.js", () => ({
  getChannel: async (id: string) => channels.rows.get(id) ?? null,
  getChannelAudience: async () => null,
  getServerVoiceProfile: async () => ({ isCommunity: false, memberCount: 40 }),
}));

// --- the fake SFU -------------------------------------------------------------

interface FakeTrack {
  sid: string;
  type: number;
  source: number;
  muted: boolean;
}
interface FakeParticipant {
  identity: string;
  metadata: string;
  permission: {
    canPublish: boolean;
    canSubscribe: boolean;
    canPublishData: boolean;
    canPublishSources: number[];
  };
  tracks: FakeTrack[];
}

const sfu = vi.hoisted(() => ({
  rooms: new Map<string, Map<string, unknown>>(),
  failUpdateFor: new Set<string>(),
  failList: false,
  /** When set, the next listParticipants waits for it (one call only). */
  gate: null as Promise<void> | null,
  calls: { list: 0, update: 0, mute: 0 },
}));

vi.mock("livekit-server-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("livekit-server-sdk")>();
  const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  return {
    ...actual,
    RoomServiceClient: class {
      async listParticipants(room: string) {
        sfu.calls.list += 1;
        if (sfu.gate) {
          const gate = sfu.gate;
          sfu.gate = null;
          await gate;
        }
        if (sfu.failList) {
          throw new Error("connect ETIMEDOUT");
        }
        return [...(sfu.rooms.get(room)?.values() ?? [])].map((p) => clone(p));
      }
      async updateParticipant(
        room: string,
        identity: string,
        options: { permission: { canPublish: boolean; canPublishSources?: number[] } },
      ) {
        sfu.calls.update += 1;
        if (sfu.failUpdateFor.has(identity)) {
          throw new Error("twirp error unknown: connect ETIMEDOUT");
        }
        const participant = sfu.rooms.get(room)?.get(identity) as FakeParticipant | undefined;
        if (!participant) {
          throw Object.assign(new Error("participant not found"), { status: 404 });
        }
        participant.permission = {
          canPublish: options.permission.canPublish,
          canSubscribe: true,
          canPublishData: false,
          canPublishSources: options.permission.canPublishSources ?? [],
        };
        return clone(participant);
      }
      async mutePublishedTrack(room: string, identity: string, sid: string, muted: boolean) {
        sfu.calls.mute += 1;
        const participant = sfu.rooms.get(room)?.get(identity) as FakeParticipant | undefined;
        const track = participant?.tracks.find((t) => t.sid === sid);
        if (track) {
          track.muted = muted;
        }
      }
    },
  };
});

const {
  handleVoiceMessage,
  reevaluateVoiceSpeak,
  removeVoicePeerBySocket,
  resetVoicePeers,
  resetVoiceRateLimits,
  resetVoiceRoomTransports,
  runAudienceHostCheckForTests,
  setVoiceAudienceMode,
  setVoiceAudienceSpeaker,
  sweepAudienceModes,
  voiceUserHandRaisedAt,
} = await import("./voice.js");
const { setCoalesceImmediate } = await import("./fanout.js");
setCoalesceImmediate(true);
const { resetSfuAdminClient, stopSfuResweeps } = await import("../voice/admin.js");
const { liveKitPublishGrant, participantMetadataFor } = await import("../voice/backends.js");
const { resolveVoicePublish } = await import("../voice/speak.js");
const { audienceModeMetrics } = await import("../voice/audience.js");
const { Permission, PERMISSION_DEFAULT_EVERYONE } = await import("@pqp/shared");
const { TrackSource, TrackType } = await import("livekit-server-sdk");

const OWNER_BITS = (1n << 64n) - 1n;

interface Frame {
  type: string;
  [key: string]: unknown;
}
interface Recorder {
  socket: WebSocket;
  frames: Frame[];
  userId: string;
  peerId: string;
  resumeToken: string;
}

function asUser(id: string): DbUser {
  return { id, display_name: `User ${id}`, avatar_url: null } as unknown as DbUser;
}

function socketFor(frames: Frame[]): WebSocket {
  return {
    readyState: 1,
    send: (payload: string) => frames.push(JSON.parse(payload) as Frame),
    on: () => {},
  } as unknown as WebSocket;
}

async function join(
  userId: string,
  room = ROOM,
  extra: { resumePeerId?: string; resumeToken?: string } = {},
): Promise<Recorder> {
  const frames: Frame[] = [];
  const socket = socketFor(frames);
  await handleVoiceMessage(
    { socket, user: asUser(userId) },
    { type: "join-voice-room", voiceChannelId: room, resume: true, ...extra },
  );
  const welcome = frames.find((f) => f.type === "welcome");
  if (!welcome) {
    throw new Error(`no welcome: ${JSON.stringify(frames)}`);
  }
  return {
    socket,
    frames,
    userId,
    peerId: welcome.peerId as string,
    resumeToken: welcome.resumeToken as string,
  };
}

function framesOf(rec: Recorder, type: string): Frame[] {
  return rec.frames.filter((f) => f.type === type);
}

function last(rec: Recorder, type: string): Frame | undefined {
  return framesOf(rec, type).at(-1);
}

/** What `POST /api/voice/token` would mint, then connect to the fake SFU with it. */
async function connectToSfu(rec: Recorder, room = ROOM): Promise<void> {
  const grant = await resolveVoicePublish(channels.rows.get(room) as never, room, rec.userId);
  const publish = liveKitPublishGrant(grant);
  let participants = sfu.rooms.get(room);
  if (!participants) {
    participants = new Map();
    sfu.rooms.set(room, participants);
  }
  const participant: FakeParticipant = {
    identity: rec.peerId,
    metadata: participantMetadataFor(rec.userId),
    permission: {
      canPublish: publish.canPublish ?? false,
      canSubscribe: true,
      canPublishData: false,
      canPublishSources: (publish.canPublishSources as number[] | undefined) ?? [],
    },
    tracks: [],
  };
  participants.set(rec.peerId, participant);
  // A client publishes its microphone when the token lets it (muted or not,
  // the track exists), unmuted here: the worst case.
  tryToSpeak(rec, room);
}

function participantOf(rec: Recorder, room = ROOM): FakeParticipant {
  return sfu.rooms.get(room)!.get(rec.peerId) as FakeParticipant;
}

function micAllowed(p: FakeParticipant): boolean {
  return (
    p.permission.canPublish &&
    (p.permission.canPublishSources.length === 0 ||
      p.permission.canPublishSources.includes(TrackSource.MICROPHONE))
  );
}

/** What any client, honest or patched, can try: publish and unmute its mic. */
function tryToSpeak(rec: Recorder, room = ROOM): boolean {
  const p = participantOf(rec, room);
  if (!micAllowed(p)) {
    return false;
  }
  const mic = p.tracks.find((t) => t.source === TrackSource.MICROPHONE);
  if (mic) {
    mic.muted = false;
  } else {
    p.tracks.push({
      sid: `MIC_${rec.peerId}`,
      type: TrackType.AUDIO,
      source: TrackSource.MICROPHONE,
      muted: false,
    });
  }
  return true;
}

/** Whether the room can hear this person right now, per the media server. */
function audible(rec: Recorder, room = ROOM): boolean {
  const p = participantOf(rec, room);
  return micAllowed(p) && p.tracks.some((t) => t.source === TrackSource.MICROPHONE && !t.muted);
}

function logLines(): string[] {
  return vi.mocked(console.log).mock.calls.map((entry) => String(entry[0]));
}

function useLiveKit(on: boolean) {
  if (on) {
    process.env.LIVEKIT_URL = "wss://sfu.example.test";
    process.env.LIVEKIT_API_KEY = "key";
    process.env.LIVEKIT_API_SECRET = "secret";
  } else {
    delete process.env.LIVEKIT_URL;
    delete process.env.LIVEKIT_API_KEY;
    delete process.env.LIVEKIT_API_SECRET;
  }
  resetSfuAdminClient();
}

const previousClerk = process.env.CLERK_SECRET_KEY;

beforeEach(() => {
  process.env.CLERK_SECRET_KEY = "sk_test_voice_audience";
  process.env.AUDIENCE_MODE = "true";
  delete process.env.VOICE_REGISTRY;
  channels.rows.clear();
  channels.rows.set(ROOM, {
    id: ROOM,
    kind: "server",
    type: "voice",
    server_id: SERVER,
    parent_id: null,
    voice_transport: "livekit",
  });
  channels.rows.set(MESH_ROOM, {
    id: MESH_ROOM,
    kind: "server",
    type: "voice",
    server_id: SERVER,
    parent_id: null,
    voice_transport: "mesh",
  });
  bits.byUser.clear();
  bits.byUser.set("host", OWNER_BITS);
  sfu.rooms.clear();
  sfu.failUpdateFor.clear();
  sfu.failList = false;
  sfu.gate = null;
  sfu.calls = { list: 0, update: 0, mute: 0 };
  resetVoicePeers();
  resetVoiceRateLimits();
  resetVoiceRoomTransports();
  useLiveKit(true);
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  stopSfuResweeps();
  resetVoicePeers();
  resetVoiceRoomTransports();
  useLiveKit(false);
  delete process.env.AUDIENCE_MODE;
  if (previousClerk === undefined) {
    delete process.env.CLERK_SECRET_KEY;
  } else {
    process.env.CLERK_SECRET_KEY = previousClerk;
  }
  vi.restoreAllMocks();
});

async function room(...users: string[]): Promise<Record<string, Recorder>> {
  const out: Record<string, Recorder> = {};
  for (const userId of users) {
    out[userId] = await join(userId);
    await connectToSfu(out[userId]!);
  }
  return out;
}

describe("toggling it on a LiveKit room", () => {
  it("silences a connected listener on the media server within the one call, leaves the host, and off restores", async () => {
    const { host, member } = await room("host", "member");
    expect(audible(member!)).toBe(true);

    const on = await setVoiceAudienceMode(ROOM, true, "host");
    // The media server, not the client: the mic is muted and may not be reopened.
    expect(on.enforcement).toEqual({ transport: "livekit", pendingUserIds: [], unreachable: false });
    expect(audible(member!)).toBe(false);
    expect(tryToSpeak(member!)).toBe(false);
    expect(audible(host!)).toBe(true);
    // The person is told, with the reason.
    expect(last(member!, "voice-speak-changed")).toMatchObject({
      canSpeak: false,
      canStream: false,
      speakReason: "audience",
    });
    expect(last(host!, "voice-speak-changed")).toBeUndefined();
    // Everybody in the call gets the state and the change (the notice).
    for (const rec of [host!, member!]) {
      expect(last(rec, "voice-audience")).toMatchObject({
        voiceChannelId: ROOM,
        audience: { byUserId: "host", speakerUserIds: [], unenforcedUserIds: [] },
        change: { kind: "on", byUserId: "host" },
      });
    }

    const off = await setVoiceAudienceMode(ROOM, false, "host");
    expect(off.audience).toBeNull();
    expect(participantOf(member!).permission.canPublish).toBe(true);
    expect(participantOf(member!).permission.canPublishSources).toEqual([]);
    expect(tryToSpeak(member!)).toBe(true);
    expect(last(member!, "voice-speak-changed")).toMatchObject({ canSpeak: true, canStream: true });
    expect(last(member!, "voice-speak-changed")!.speakReason).toBeUndefined();
    expect(last(member!, "voice-audience")).toMatchObject({
      audience: null,
      change: { kind: "off", reason: "host" },
    });
  });

  it("moderators keep their microphone; a channel manager too", async () => {
    bits.byUser.set("mod", PERMISSION_DEFAULT_EVERYONE | Permission.MUTE_MEMBERS);
    bits.byUser.set("manager", PERMISSION_DEFAULT_EVERYONE | Permission.MANAGE_CHANNELS);
    const { mod, manager, member } = await room("host", "mod", "manager", "member");
    await setVoiceAudienceMode(ROOM, true, "host");
    expect(audible(mod!)).toBe(true);
    expect(audible(manager!)).toBe(true);
    expect(audible(member!)).toBe(false);
  });

  it("is idempotent: a second host turning it on keeps the session and announces nothing", async () => {
    bits.byUser.set("mod", PERMISSION_DEFAULT_EVERYONE | Permission.MUTE_MEMBERS);
    const { member } = await room("host", "mod", "member");
    const first = await setVoiceAudienceMode(ROOM, true, "host");
    const second = await setVoiceAudienceMode(ROOM, true, "mod");
    expect(second.changed).toBe(false);
    expect(second.audience!.byUserId).toBe("host");
    expect(second.audience!.since).toBe(first.audience!.since);
    expect(framesOf(member!, "voice-audience").filter((f) => f.change)).toHaveLength(1);
  });

  it("a role edit while it is on cannot hand the audience its microphone back", async () => {
    const { member } = await room("host", "member");
    await setVoiceAudienceMode(ROOM, true, "host");
    // Somebody edits a role: every seat is re-resolved.
    bits.byUser.set("member", PERMISSION_DEFAULT_EVERYONE | Permission.STREAM);
    await reevaluateVoiceSpeak(SERVER);
    expect(last(member!, "voice-speak-changed")).toMatchObject({ canSpeak: false });
    expect(audible(member!)).toBe(false);
  });

  it("a new joiner is seated locked, told why, and its token carries no microphone", async () => {
    await room("host");
    await setVoiceAudienceMode(ROOM, true, "host");
    const late = await join("late");
    const welcome = late.frames.find((f) => f.type === "welcome")!;
    expect(welcome).toMatchObject({
      canSpeak: false,
      canStream: false,
      speakReason: "audience",
      audience: { byUserId: "host" },
    });
    const grant = await resolveVoicePublish(channels.rows.get(ROOM) as never, ROOM, "late");
    expect(liveKitPublishGrant(grant)).toEqual({ canPublish: false });
    await connectToSfu(late);
    expect(audible(late)).toBe(false);
  });

  it("refuses an unmute and says why, once per room per minute", async () => {
    const { member, other } = await room("host", "member", "other");
    await setVoiceAudienceMode(ROOM, true, "host");
    for (const rec of [member!, other!, member!]) {
      await handleVoiceMessage(
        { socket: rec.socket, user: asUser(rec.userId) },
        { type: "set-voice-state", muted: false, deafened: false },
      );
    }
    const watcher = await join("watcher");
    const roster = watcher.frames.find((f) => f.type === "welcome")!.peers as {
      userId: string;
      muted: boolean;
      canSpeak: boolean;
    }[];
    expect(roster.find((p) => p.userId === "member")).toMatchObject({ muted: true, canSpeak: false });
    const refused = logLines().filter((line) => line.startsWith("[pqp] voice.unmuteRefused"));
    expect(refused).toHaveLength(1);
    expect(refused[0]).toContain("reason=audience");
    expect(audienceModeMetrics().unmuteRefused).toBe(3);
  });

  it("logs the denied joins with the reason, rate limited per room", async () => {
    await room("host");
    await setVoiceAudienceMode(ROOM, true, "host");
    await join("a");
    await join("b");
    await join("c");
    const lines = logLines().filter((line) => line.startsWith("[pqp] voice.speakDenied"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("reason=audience");
    expect(audienceModeMetrics().speakDenied.audience).toBe(3);
  });
});

describe("letting one person speak", () => {
  it("gives the microphone back on the media server, not the camera, lowers the hand, and Silenciar takes it back", async () => {
    const { host, member } = await room("host", "member");
    await setVoiceAudienceMode(ROOM, true, "host");
    await handleVoiceMessage(
      { socket: member!.socket, user: asUser("member") },
      { type: "set-raised-hand", raised: true },
    );
    expect(voiceUserHandRaisedAt(ROOM, "member")).not.toBeNull();

    const granted = await setVoiceAudienceSpeaker(ROOM, "member", true, "host");
    expect(granted.audience!.speakerUserIds).toEqual(["member"]);
    expect(participantOf(member!).permission.canPublishSources).toEqual([TrackSource.MICROPHONE]);
    expect(tryToSpeak(member!)).toBe(true);
    expect(last(member!, "voice-speak-changed")).toMatchObject({ canSpeak: true, canStream: false });
    expect(voiceUserHandRaisedAt(ROOM, "member")).toBeNull();
    expect(last(host!, "voice-audience")).toMatchObject({
      change: { kind: "speaker-added", userId: "member", byUserId: "host" },
    });

    await setVoiceAudienceSpeaker(ROOM, "member", false, "host");
    expect(audible(member!)).toBe(false);
    expect(tryToSpeak(member!)).toBe(false);
    expect(last(member!, "voice-speak-changed")).toMatchObject({
      canSpeak: false,
      speakReason: "audience",
    });
  });

  it("is refused when audience mode is not on", async () => {
    await room("host", "member");
    await expect(setVoiceAudienceSpeaker(ROOM, "member", true, "host")).rejects.toMatchObject({
      code: "off",
    });
  });

  it("ends when the person leaves the call", async () => {
    const { member } = await room("host", "member");
    await setVoiceAudienceMode(ROOM, true, "host");
    await setVoiceAudienceSpeaker(ROOM, "member", true, "host");
    await handleVoiceMessage(
      { socket: member!.socket, user: asUser("member") },
      { type: "leave-voice-room" },
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    const back = await join("member");
    expect(back.frames.find((f) => f.type === "welcome")).toMatchObject({
      canSpeak: false,
      speakReason: "audience",
    });
  });
});

describe("resume", () => {
  it("a seat held across a socket blip comes back with the grant as it is now, and the SFU was already updated", async () => {
    const { member } = await room("host", "member");
    // The socket drops; the seat is held for its resume window, and the
    // LiveKit connection is still up.
    removeVoicePeerBySocket(member!.socket);
    // Audience mode goes on during the gap. The room pass reaches the SFU
    // participant whose socket is gone.
    await setVoiceAudienceMode(ROOM, true, "host");
    expect(audible(member!)).toBe(false);

    const back = await join("member", ROOM, {
      resumePeerId: member!.peerId,
      resumeToken: member!.resumeToken,
    });
    const welcome = back.frames.find((f) => f.type === "welcome")!;
    expect(welcome.resumed).toBe(true);
    expect(welcome.peerId).toBe(member!.peerId);
    expect(welcome).toMatchObject({
      canSpeak: false,
      speakReason: "audience",
      audience: { byUserId: "host" },
    });
    expect(tryToSpeak(member!)).toBe(false);
  });

  it("an invitation survives a socket blip", async () => {
    const { member } = await room("host", "member");
    await setVoiceAudienceMode(ROOM, true, "host");
    await setVoiceAudienceSpeaker(ROOM, "member", true, "host");
    removeVoicePeerBySocket(member!.socket);
    const back = await join("member", ROOM, {
      resumePeerId: member!.peerId,
      resumeToken: member!.resumeToken,
    });
    expect(back.frames.find((f) => f.type === "welcome")).toMatchObject({ canSpeak: true });
  });
});

describe("when the media server does not cooperate", () => {
  it("tells the host who is still audible, and the next pass fixes it and clears the warning", async () => {
    const { host, member } = await room("host", "member");
    sfu.failUpdateFor.add(member!.peerId);

    const on = await setVoiceAudienceMode(ROOM, true, "host");
    expect(on.enforcement.pendingUserIds).toEqual(["member"]);
    expect(on.audience!.unenforcedUserIds).toEqual(["member"]);
    // The mic was muted by the belt-and-braces step even though the
    // permission rewrite failed, but the rewrite is what stops a reopen:
    expect(tryToSpeak(member!)).toBe(true);
    expect(last(host!, "voice-audience")).toMatchObject({
      audience: { unenforcedUserIds: ["member"] },
    });
    expect(audienceModeMetrics().enforceFailures).toBeGreaterThan(0);
    expect(logLines().some((line) => line.includes("voice.audienceMode.enforceFailed"))).toBe(true);

    // The box recovers; the next pass (the sweep, or a follow-up) fixes it.
    sfu.failUpdateFor.clear();
    await sweepAudienceModes();
    expect(audible(member!)).toBe(false);
    expect(tryToSpeak(member!)).toBe(false);
    expect(last(host!, "voice-audience")).toMatchObject({
      audience: { unenforcedUserIds: [] },
    });
  });

  it("a restore that fails on the way OFF is retried by the sweep until it lands", async () => {
    const { member } = await room("host", "member");
    await setVoiceAudienceMode(ROOM, true, "host");
    sfu.failUpdateFor.add(member!.peerId);
    const off = await setVoiceAudienceMode(ROOM, false, "host");
    expect(off.enforcement.pendingUserIds).toEqual(["member"]);
    // The room, the roster and the client all say they may talk; the SFU
    // still says no. Nothing has a row to find any more.
    expect(tryToSpeak(member!)).toBe(false);
    sfu.failUpdateFor.clear();
    await sweepAudienceModes();
    expect(tryToSpeak(member!)).toBe(true);
    // Clean now: the next sweep asks nothing.
    const before = sfu.calls.list;
    await sweepAudienceModes();
    expect(sfu.calls.list).toBe(before);
  });

  it("an invitation is refused once the operator's flag is off, even before the sweep", async () => {
    await room("host", "member");
    await setVoiceAudienceMode(ROOM, true, "host");
    process.env.AUDIENCE_MODE = "false";
    await expect(setVoiceAudienceSpeaker(ROOM, "member", true, "host")).rejects.toMatchObject({
      code: "off",
    });
  });

  it("says the media server is unreachable when it cannot list the room", async () => {
    await room("host", "member");
    sfu.failList = true;
    const on = await setVoiceAudienceMode(ROOM, true, "host");
    expect(on.enforcement).toMatchObject({ transport: "livekit", unreachable: true });
  });

  it("a slow pass for 'on' cannot land on top of an 'off' that overtook it", async () => {
    const { member } = await room("host", "member");
    let release!: () => void;
    sfu.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The 'on' pass stalls on the media server's list...
    const on = setVoiceAudienceMode(ROOM, true, "host");
    await vi.waitFor(() => expect(sfu.calls.list).toBe(1));
    // ...and the host changes their mind before it answers.
    await setVoiceAudienceMode(ROOM, false, "host");
    release();
    await on;
    expect(tryToSpeak(member!)).toBe(true);
    expect(audible(member!)).toBe(true);
  });

  it("the follow-up passes run by themselves", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { member } = await room("host", "member");
      sfu.failUpdateFor.add(member!.peerId);
      await setVoiceAudienceMode(ROOM, true, "host");
      sfu.failUpdateFor.clear();
      const before = sfu.calls.list;
      await vi.advanceTimersByTimeAsync(3_100);
      await vi.waitFor(() => expect(sfu.calls.list).toBeGreaterThan(before));
      await vi.waitFor(() => expect(tryToSpeak(member!)).toBe(false));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the stage empties", () => {
  it("turns itself off when nobody who runs the stage is left, and tells the room", async () => {
    const { host, member } = await room("host", "member");
    await setVoiceAudienceMode(ROOM, true, "host");
    await handleVoiceMessage(
      { socket: host!.socket, user: asUser("host") },
      { type: "leave-voice-room" },
    );
    await runAudienceHostCheckForTests(ROOM);
    expect(last(member!, "voice-audience")).toMatchObject({
      audience: null,
      change: { kind: "off", reason: "no-host", byUserId: null },
    });
    expect(tryToSpeak(member!)).toBe(true);
    expect(audienceModeMetrics().sessionsEnded["no-host"]).toBe(1);
  });

  it("stays on while another moderator is still in the call, and while the host's seat is held for resume", async () => {
    bits.byUser.set("mod", PERMISSION_DEFAULT_EVERYONE | Permission.MUTE_MEMBERS);
    const { host, member } = await room("host", "mod", "member");
    await setVoiceAudienceMode(ROOM, true, "host");
    // The host's tab reloads: the seat is held.
    removeVoicePeerBySocket(host!.socket);
    await runAudienceHostCheckForTests(ROOM);
    expect(last(member!, "voice-audience")!.audience).not.toBeNull();
  });
});

describe("the operator's flag", () => {
  it("going off ends a running session on the next sweep", async () => {
    const { member } = await room("host", "member");
    await setVoiceAudienceMode(ROOM, true, "host");
    process.env.AUDIENCE_MODE = "false";
    await sweepAudienceModes();
    expect(last(member!, "voice-audience")).toMatchObject({
      audience: null,
      change: { kind: "off", reason: "flag-off" },
    });
    expect(tryToSpeak(member!)).toBe(true);
  });

  it("off, a join reads nothing and is never locked by a leftover state", async () => {
    await room("host", "member");
    await setVoiceAudienceMode(ROOM, true, "host");
    process.env.AUDIENCE_MODE = "false";
    const late = await join("late");
    expect(late.frames.find((f) => f.type === "welcome")).toMatchObject({ canSpeak: true });
  });
});

describe("a mesh room", () => {
  it("has no media server to ask: the server pins muted, the roster says canSpeak false, the answer says mesh", async () => {
    const host = await join("host", MESH_ROOM);
    const member = await join("member", MESH_ROOM);
    const result = await setVoiceAudienceMode(MESH_ROOM, true, "host");
    expect(result.enforcement).toEqual({ transport: "mesh", pendingUserIds: [], unreachable: false });
    expect(sfu.calls.list).toBe(0);
    expect(last(member, "voice-speak-changed")).toMatchObject({
      canSpeak: false,
      speakReason: "audience",
    });
    await handleVoiceMessage(
      { socket: member.socket, user: asUser("member") },
      { type: "set-voice-state", muted: false, deafened: false },
    );
    // What every receiver reads, and silences on (the client half).
    expect(last(host, "voice-audience")).toMatchObject({ change: { kind: "on" } });
    const watcher = await join("watcher", MESH_ROOM);
    const roster = watcher.frames.find((f) => f.type === "welcome")!.peers as {
      userId: string;
      canSpeak: boolean;
      muted: boolean;
    }[];
    expect(roster.find((p) => p.userId === "member")).toMatchObject({
      canSpeak: false,
      muted: true,
    });
  });
});
