import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { DbUser } from "../db.js";
import type { VoiceParticipant } from "@pqp/shared";

/**
 * A SOCKET THAT JOINS A SERVER AFTER IT CONNECTED IS TOLD WHO IS IN ITS ROOMS.
 *
 * `auth` sends every voice roster the account may see, once. Redeeming an
 * invite on an open tab added a server that socket had never been told about,
 * so its voice channels showed nobody in them until a reload, while the member
 * list beside them said people were in the call. Found by the local E2E sweep.
 *
 * Real Postgres, real invite redemption, real access checks: the bug was a
 * missing edge between two services (membership and the voice fan-out), and a
 * mock of either would have asserted it away.
 */

// TEST_DATABASE_URL wins — see the note in api.test.ts.
const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

// Peer-to-peer rooms: the fan-out under test is the same for both transports,
// and this keeps the room off a media server the test does not have.
delete process.env.LIVEKIT_URL;

const { setCoalesceImmediate } = await import("./fanout.js");
setCoalesceImmediate(true);

const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("../services/users.js");
const { createServer, clearChannelAudienceCache } = await import(
  "../services/servers.js"
);
const { createInvite, redeemInvite } = await import("../services/invites.js");
const { SOCKET_CAPS, setAuthenticatedSocket, deleteAuthenticatedSocket } =
  await import("./sockets.js");
const { handleVoiceMessage, resetVoicePeers, sendAllVoiceRosters } =
  await import("./voice.js");
// Registers the new-membership catch-up, the code under test.
await import("./index.js");

interface Frame {
  type: string;
  voiceChannelId?: string;
  participants?: VoiceParticipant[];
}

interface FakeClient {
  socket: WebSocket;
  user: DbUser;
  frames: Frame[];
}

const open: FakeClient[] = [];

function connect(user: DbUser): FakeClient {
  const frames: Frame[] = [];
  const socket = {
    readyState: 1,
    send: (payload: string | Buffer) => {
      frames.push(JSON.parse(payload.toString()) as Frame);
    },
    on: () => {},
  } as unknown as WebSocket;
  setAuthenticatedSocket(socket, user, [SOCKET_CAPS.voiceRosterDelta]);
  const client = { socket, user, frames };
  open.push(client);
  return client;
}

function rostersFor(client: FakeClient, voiceChannelId: string): Frame[] {
  return client.frames.filter(
    (frame) =>
      frame.type === "voice-roster" && frame.voiceChannelId === voiceChannelId,
  );
}

describeDb("voice rosters for a server joined after connect", () => {
  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    await getPool().query(
      `TRUNCATE users, user_preferences, servers, channels, messages,
                server_members, channel_members, server_invites
       RESTART IDENTITY CASCADE`,
    );
    clearChannelAudienceCache();
  });

  afterEach(() => {
    for (const client of open.splice(0)) {
      deleteAuthenticatedSocket(client.socket);
    }
    resetVoicePeers();
  });

  it("sends the room's roster to the new member's open socket on invite", async () => {
    const owner = await upsertUser({
      clerkId: "clerk_owner",
      displayName: "Owner",
      avatarUrl: null,
    });
    const newcomer = await upsertUser({
      clerkId: "clerk_newcomer",
      displayName: "Newcomer",
      avatarUrl: null,
    });
    const stranger = await upsertUser({
      clerkId: "clerk_stranger",
      displayName: "Stranger",
      avatarUrl: null,
    });
    const { server, channels } = await createServer("Sala", owner.id);
    const voice = channels.find((channel) => channel.type === "voice");
    expect(voice).toBeDefined();
    const voiceChannelId = voice!.id;

    const ownerClient = connect(owner);
    await handleVoiceMessage(
      { socket: ownerClient.socket, user: owner },
      { type: "join-voice-room", voiceChannelId, transports: ["mesh"] },
    );

    // Connected before joining: what `auth` sends has nothing for this room.
    const newcomerClient = connect(newcomer);
    await sendAllVoiceRosters(newcomerClient.socket, newcomer);
    expect(rostersFor(newcomerClient, voiceChannelId)).toHaveLength(0);
    const strangerClient = connect(stranger);

    const invite = await createInvite(server.id, owner.id);
    await redeemInvite(invite.code, newcomer.id);

    await vi.waitFor(() => {
      expect(rostersFor(newcomerClient, voiceChannelId)).toHaveLength(1);
    });
    const [roster] = rostersFor(newcomerClient, voiceChannelId);
    expect(roster!.participants?.map((p) => p.userId)).toEqual([owner.id]);
    // Only the account that joined is caught up, and only for this server.
    expect(rostersFor(strangerClient, voiceChannelId)).toHaveLength(0);
  });
});
