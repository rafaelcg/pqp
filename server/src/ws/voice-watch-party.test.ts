import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { DbUser } from "../db.js";

/**
 * START_WATCH_PARTY on the WS side. A `watch_party` room is a voice room
 * whose stage is gated by its own bit: the everyday STREAM default is not
 * enough there, an admin's ALL is, and a per-channel overwrite flips it.
 * Same fixture as voice-speak.test.ts: permissions are mocked to a per-user
 * bitfield, so the bits below are the *resolved* channel bits (an overwrite
 * is already applied by the time voice.ts sees them).
 */

const backend = vi.hoisted(() => ({ configured: "mesh" as "mesh" | "livekit" }));

vi.mock("../voice/backends.js", () => ({
  getServerVoiceBackend: () => backend.configured,
  isLiveKitConfigured: () => backend.configured === "livekit",
}));

/** userId → resolved bits. Absent means the @everyone default (SPEAK on). */
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
const OTHER_SERVER = randomUUID();
const STAGE = randomUUID();
const CINEMA = randomUUID();
const OTHER_ROOM = randomUUID();
const DM_CALL = randomUUID();

vi.mock("../services/servers.js", () => ({
  getChannel: async (id: string) => {
    if (id === DM_CALL) {
      return { id, kind: "conversation", type: "text", server_id: null };
    }
    if (id === OTHER_ROOM) {
      return { id, kind: "server", type: "voice", server_id: OTHER_SERVER };
    }
    if (id === CINEMA) {
      return { id, kind: "server", type: "watch_party", server_id: SERVER };
    }
    return { id, kind: "server", type: "voice", server_id: SERVER };
  },
  getChannelAudience: async () => null,
}));

/**
 * The channel's active party, as `join-voice-room`'s seat gate reads it.
 *
 * `null` (the default, restored in `beforeEach`) is "no party running here",
 * which is deliberately NOT a closed room: a `watch_party` channel with
 * nothing on is an ordinary voice room. Every case above this line predates
 * the gate and runs against that default, so a regression in the gate shows
 * up as those tests failing rather than as silent coverage loss.
 */
const party = vi.hoisted(() => ({
  seat: null as {
    voiceEnabled: boolean;
    isHost: boolean;
    isCohost: boolean;
    isInvited: boolean;
  } | null,
  /** Set when the gate refused to read it at all, to prove it fails open. */
  throws: false,
  calls: 0,
}));

vi.mock("../services/watch-parties.js", () => ({
  loadWatchPartySeat: async () => {
    party.calls += 1;
    if (party.throws) {
      throw new Error("the database is having a bad minute");
    }
    return party.seat;
  },
}));

vi.mock("../voice/admin.js", () => ({
  evictSfuRoom: vi.fn(() => Promise.resolve()),
  evictSfuUser: vi.fn(() => Promise.resolve()),
  evictSfuUsersExcept: vi.fn(() => Promise.resolve()),
  setSfuUserCanPublish: vi.fn(() => Promise.resolve(true)),
}));

const {
  handleVoiceMessage,
  resetVoicePeers,
  resetVoiceRateLimits,
  resetVoiceRoomTransports,
} = await import("./voice.js");
const { setSfuUserCanPublish } = await import("../voice/admin.js");
const {
  Permission,
  PERMISSION_ALL,
  PERMISSION_DEFAULT_EVERYONE,
  PERMISSION_DEFAULT_MODERATOR,
} = await import("@pqp/shared");

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
    display_name: `User ${id}`,
    avatar_url: null,
  } as unknown as DbUser;
}

function frame(rec: Recorder, type: string): Frame | undefined {
  return rec.frames.find((f) => f.type === type);
}

async function join(rec: Recorder, userId: string, voiceChannelId: string) {
  await handleVoiceMessage(
    { socket: rec.socket, user: asUser(userId) },
    { type: "join-voice-room", voiceChannelId },
  );
  return rec;
}


async function claimStage(rec: Recorder, userId: string) {
  await handleVoiceMessage(
    { socket: rec.socket, user: asUser(userId) },
    { type: "set-sharing-screen", sharing: true },
  );
}

describe("START_WATCH_PARTY in a watch party room", () => {
  beforeEach(() => {
    resetVoicePeers();
    resetVoiceRateLimits();
    resetVoiceRoomTransports();
    bits.byUser.clear();
    party.seat = null;
    party.throws = false;
    party.calls = 0;
    backend.configured = "mesh";
    vi.mocked(setSfuUserCanPublish).mockClear();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("lets an admin take the stage", async () => {
    bits.byUser.set("admin", PERMISSION_ALL);
    const rec = await join(recorder(), "admin", CINEMA);
    expect(frame(rec, "welcome")!.canStream).toBe(true);
    await claimStage(rec, "admin");
    expect(frame(rec, "screen-share-denied")).toBeUndefined();
    const watcher = await join(recorder(), "watcher", CINEMA);
    const peers = frame(watcher, "welcome")!.peers as Array<{
      userId: string;
      sharingScreen: boolean;
    }>;
    expect(peers.find((p) => p.userId === "admin")?.sharingScreen).toBe(true);
  });

  it("refuses a plain member, even with the everyday Stream bit", async () => {
    bits.byUser.set("member", PERMISSION_DEFAULT_EVERYONE);
    expect(PERMISSION_DEFAULT_EVERYONE & Permission.STREAM).toBe(
      Permission.STREAM,
    );
    const rec = await join(recorder(), "member", CINEMA);
    expect(frame(rec, "welcome")!.canStream).toBe(false);
    await claimStage(rec, "member");
    expect(frame(rec, "screen-share-denied")).toBeDefined();
    const watcher = await join(recorder(), "watcher", CINEMA);
    const peers = frame(watcher, "welcome")!.peers as Array<{
      userId: string;
      sharingScreen: boolean;
    }>;
    expect(peers.find((p) => p.userId === "member")?.sharingScreen).toBe(false);
  });

  it("an overwrite flips it: granted to a member, revoked from a mod", async () => {
    bits.byUser.set(
      "guest-host",
      PERMISSION_DEFAULT_EVERYONE | Permission.START_WATCH_PARTY,
    );
    const guest = await join(recorder(), "guest-host", CINEMA);
    expect(frame(guest, "welcome")!.canStream).toBe(true);
    await claimStage(guest, "guest-host");
    expect(frame(guest, "screen-share-denied")).toBeUndefined();

    bits.byUser.set(
      "benched-mod",
      (PERMISSION_DEFAULT_EVERYONE | PERMISSION_DEFAULT_MODERATOR) &
        ~Permission.START_WATCH_PARTY,
    );
    const mod = await join(recorder(), "benched-mod", CINEMA);
    expect(frame(mod, "welcome")!.canStream).toBe(false);
    await claimStage(mod, "benched-mod");
    expect(frame(mod, "screen-share-denied")).toBeDefined();
  });

  it("still lets the same member share in a plain voice room", async () => {
    bits.byUser.set("member", PERMISSION_DEFAULT_EVERYONE);
    const rec = await join(recorder(), "member", STAGE);
    expect(frame(rec, "welcome")!.canStream).toBe(true);
    await claimStage(rec, "member");
    expect(frame(rec, "screen-share-denied")).toBeUndefined();
  });
});

/**
 * THE SEAT, which is a different question from the stage.
 *
 * `canStream` above decides whether somebody in the room may put a picture on
 * it. This decides whether they are in the room at all, and it is the model
 * change under "a watch party has no voice by default": the audience is
 * seatless by construction, watching costs a socket, and a seat costs a
 * LiveKit participant plus forwarded streams against an envelope of about
 * 600 of them.
 *
 * WHY IT IS TESTED HERE AND NOT ONLY IN THE CLIENT. The web client stopped
 * offering a viewer any way in (#436), and a removed button is a convention,
 * not a model: an old tab, a phone build, or a script still sends the frame.
 * `join-voice-room` is the only way into a room, so this is the enforcement,
 * and the assertion is on the absence of a `welcome` rather than on chrome.
 */
describe("who gets a seat in a watch party with no voice", () => {
  beforeEach(() => {
    resetVoicePeers();
    resetVoiceRateLimits();
    resetVoiceRoomTransports();
    bits.byUser.clear();
    party.seat = null;
    party.throws = false;
    party.calls = 0;
    backend.configured = "mesh";
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  const audience = {
    voiceEnabled: false,
    isHost: false,
    isCohost: false,
    isInvited: false,
  };

  it("refuses a viewer, and gives them no welcome to work with", async () => {
    bits.byUser.set("viewer", PERMISSION_DEFAULT_EVERYONE);
    party.seat = { ...audience };
    const rec = await join(recorder(), "viewer", CINEMA);
    expect(frame(rec, "welcome")).toBeUndefined();
    // Not a partial join either: nothing at all came back, so there is no
    // half-seat in the roster for the room to trip over.
    expect(rec.frames).toEqual([]);
  });

  it("lets the host in without asking the database", async () => {
    /**
     * THE HOST IS THE CASE THAT MUST NEVER FAIL, so it is answered by the
     * same resolution the stage gate already ran: `canStream` in a watch
     * party IS `START_WATCH_PARTY`, which is what the person who created the
     * party holds. `calls` is asserted at zero because this is the hot path
     * (the 2026-09-05 spike ran it several hundred times in an evening
     * against a pinned pool), and a query per join for the common case is
     * exactly the kind of cost this file already has a comment about.
     */
    bits.byUser.set(
      "host",
      PERMISSION_DEFAULT_EVERYONE | Permission.START_WATCH_PARTY,
    );
    party.seat = { ...audience };
    const rec = await join(recorder(), "host", CINEMA);
    expect(frame(rec, "welcome")).toBeDefined();
    expect(party.calls).toBe(0);
  });

  it("lets a co-host in, who need hold no permission bit at all", async () => {
    // A host may promote any member of the server. There is no bit that says
    // "co-host", so this is the case a permission check alone would refuse.
    bits.byUser.set("cohost", PERMISSION_DEFAULT_EVERYONE);
    party.seat = { ...audience, isCohost: true };
    const rec = await join(recorder(), "cohost", CINEMA);
    expect(frame(rec, "welcome")).toBeDefined();
    expect(party.calls).toBe(1);
  });

  it("lets in somebody the host invited up to speak", async () => {
    bits.byUser.set("guest", PERMISSION_DEFAULT_EVERYONE);
    party.seat = { ...audience, isInvited: true };
    expect(frame(await join(recorder(), "guest", CINEMA), "welcome")).toBeDefined();
  });

  it("lets everybody in once the host turns voice on", async () => {
    // The film night. Six friends watching something together genuinely want
    // to talk over it, and from here `stageMode` decides who may SPEAK
    // through the ordinary overwrite, exactly as it did before.
    bits.byUser.set("viewer", PERMISSION_DEFAULT_EVERYONE);
    party.seat = { ...audience, voiceEnabled: true };
    expect(frame(await join(recorder(), "viewer", CINEMA), "welcome")).toBeDefined();
  });

  it("leaves a watch party channel with no party running alone", async () => {
    /**
     * NOT A CLOSED ROOM. `VITE_WATCH_PARTY_CHANNELS` is a BUILD flag and the
     * server cannot see it; with it off, a `watch_party` channel that already
     * exists renders and joins as a plain voice channel, which is what
     * `lib/watch-party-channels.ts` promises in as many words. Refusing here
     * would break a deployment that has the channel type and not the feature.
     */
    bits.byUser.set("viewer", PERMISSION_DEFAULT_EVERYONE);
    party.seat = null;
    expect(frame(await join(recorder(), "viewer", CINEMA), "welcome")).toBeDefined();
  });

  it("never gates a plain voice channel", async () => {
    // The gate is scoped to the one channel type a party can live in. A
    // voice room is a voice room, party or no party.
    bits.byUser.set("viewer", PERMISSION_DEFAULT_EVERYONE);
    party.seat = { ...audience };
    expect(frame(await join(recorder(), "viewer", STAGE), "welcome")).toBeDefined();
    expect(party.calls).toBe(0);
  });

  it("fails open when it cannot read the party", async () => {
    /**
     * A DATABASE HICCUP MUST NOT LOCK ANYBODY OUT OF A SHOW THAT IS ABOUT TO
     * START. The two errors are not symmetrical: a join wrongly allowed costs
     * one seat, and a join wrongly refused can cost the party, because the
     * person it refuses might be the co-host who was going to present.
     */
    bits.byUser.set("viewer", PERMISSION_DEFAULT_EVERYONE);
    party.throws = true;
    expect(frame(await join(recorder(), "viewer", CINEMA), "welcome")).toBeDefined();
    expect(party.calls).toBe(1);
  });

  it("answers a resume attempt so the client stops waiting", async () => {
    // Every other refusal on this path sends `voice-join-refused` for a
    // resume, and this one has to as well: a client holding a peer id it can
    // no longer use must be told, or it retries the same refused join with
    // backoff for the length of the party.
    bits.byUser.set("viewer", PERMISSION_DEFAULT_EVERYONE);
    party.seat = { ...audience };
    const rec = recorder();
    await handleVoiceMessage(
      { socket: rec.socket, user: asUser("viewer") },
      {
        type: "join-voice-room",
        voiceChannelId: CINEMA,
        resumePeerId: randomUUID(),
      },
    );
    expect(frame(rec, "voice-join-refused")).toBeDefined();
    expect(frame(rec, "welcome")).toBeUndefined();
  });
});
