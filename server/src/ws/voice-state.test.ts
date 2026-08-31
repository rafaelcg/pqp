import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { DbUser } from "../db.js";

/**
 * The roster carries per-peer voice state — muted, deafened, sharing — so
 * someone *outside* the call can see it from the channel list. These tests pin
 * the wire contract: state rides `voice-roster`, updates on `set-voice-state`,
 * resets with the peer, and never fans out when nothing changed.
 *
 * No database: the service layer under the peer bookkeeping is faked, and the
 * roster audience is a stub that admits everyone (the audience *scoping* is
 * `getChannelAudience`'s own tested concern, not this file's).
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
  // Everyone on the instance is in the audience: these tests are about what
  // the roster *says*, not who may hear it.
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

const backend = vi.hoisted(() => ({ configured: "mesh" as "mesh" | "livekit" }));

vi.mock("../voice/backends.js", () => ({
  getServerVoiceBackend: () => backend.configured,
  isLiveKitConfigured: () => backend.configured === "livekit",
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

const VOICE_A = randomUUID();

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

interface RosterFrame {
  type: string;
  voiceChannelId?: string;
  participants?: Array<{
    userId: string;
    muted: boolean;
    deafened: boolean;
    sharingScreen: boolean;
    screenAudioStreamId?: string | null;
  }>;
}

function rosters(rec: Recorder): RosterFrame[] {
  return rec.received
    .map((raw) => JSON.parse(raw) as RosterFrame)
    .filter((frame) => frame.type === "voice-roster");
}

function lastRoster(rec: Recorder): RosterFrame {
  const all = rosters(rec);
  expect(all.length).toBeGreaterThan(0);
  return all[all.length - 1]!;
}

async function join(rec: Recorder, userId: string): Promise<void> {
  await handleVoiceMessage(
    { socket: rec.socket, user: asUser(userId) },
    { type: "join-voice-room", voiceChannelId: VOICE_A },
  );
}

describe("voice roster carries mute/deafen state", () => {
  const sockets: Recorder[] = [];
  const viewers: Recorder[] = [];

  beforeEach(() => {
    sockets.length = 0;
    resetVoicePeers();
    for (const rec of viewers.splice(0)) {
      deleteAuthenticatedSocket(rec.socket);
    }
    resetVoiceRateLimits();
    backend.configured = "mesh";
    resetVoiceRoomTransports();
  });

  function track(rec: Recorder): Recorder {
    sockets.push(rec);
    return rec;
  }

  /** A socket that is authenticated (so it receives rosters) but not in voice. */
  function viewer(userId: string): Recorder {
    const rec = recorder();
    setAuthenticatedSocket(rec.socket, asUser(userId));
    viewers.push(rec);
    return rec;
  }

  it("starts every participant unmuted and undeafened", async () => {
    const outside = viewer("viewer");
    const caller = track(recorder());
    await join(caller, "talker");

    const roster = lastRoster(outside);
    expect(roster.voiceChannelId).toBe(VOICE_A);
    expect(roster.participants).toEqual([
      expect.objectContaining({
        userId: "talker",
        muted: false,
        deafened: false,
        sharingScreen: false,
      }),
    ]);
  });

  it("updates the roster for outside viewers on mute and deafen", async () => {
    const outside = viewer("viewer");
    const caller = track(recorder());
    await join(caller, "talker");

    await handleVoiceMessage(
      { socket: caller.socket, user: asUser("talker") },
      { type: "set-voice-state", muted: true, deafened: false },
    );
    expect(lastRoster(outside).participants![0]).toMatchObject({
      muted: true,
      deafened: false,
    });

    await handleVoiceMessage(
      { socket: caller.socket, user: asUser("talker") },
      { type: "set-voice-state", muted: true, deafened: true },
    );
    expect(lastRoster(outside).participants![0]).toMatchObject({
      muted: true,
      deafened: true,
    });
  });

  it("does not fan out a roster when the declared state did not change", async () => {
    const outside = viewer("viewer");
    const caller = track(recorder());
    await join(caller, "talker");
    const before = rosters(outside).length;

    // The client re-declares after every welcome, and the defaults match the
    // fresh peer — a broadcast here would double every join's fan-out.
    await handleVoiceMessage(
      { socket: caller.socket, user: asUser("talker") },
      { type: "set-voice-state", muted: false, deafened: false },
    );

    expect(rosters(outside).length).toBe(before);
  });

  it("ignores a declaration from a socket with no voice peer", async () => {
    const outside = viewer("viewer");
    const stray = recorder();

    await handleVoiceMessage(
      { socket: stray.socket, user: asUser("nobody") },
      { type: "set-voice-state", muted: true, deafened: true },
    );

    expect(rosters(outside)).toEqual([]);
  });

  it("resets state with the peer: a rejoin starts unmuted again", async () => {
    const outside = viewer("viewer");
    const caller = track(recorder());
    await join(caller, "talker");
    await handleVoiceMessage(
      { socket: caller.socket, user: asUser("talker") },
      { type: "set-voice-state", muted: true, deafened: false },
    );
    expect(lastRoster(outside).participants![0]!.muted).toBe(true);

    // Rejoin (same socket, new peer). The server must not carry the old mute
    // over — the client owns the state and re-declares it after welcome.
    await join(caller, "talker");
    expect(lastRoster(outside).participants![0]!.muted).toBe(false);
  });

  /**
   * A share that carries the machine's audio announces the capture's stream id,
   * and the roster is how every mesh receiver learns which of that peer's two
   * audio tracks is the presentation rather than their voice. Getting this
   * wrong silences the presenter for the whole room, so the wire contract is
   * pinned here: the id rides the roster, an older client that sends no id is
   * accepted as silent, and stopping clears it.
   */
  it("carries the screen-audio stream id, and clears it on stop", async () => {
    const outside = viewer("viewer");
    const caller = track(recorder());
    await join(caller, "talker");

    await handleVoiceMessage(
      { socket: caller.socket, user: asUser("talker") },
      { type: "set-sharing-screen", sharing: true, audioStreamId: "cap-1" },
    );
    expect(lastRoster(outside).participants![0]).toMatchObject({
      sharingScreen: true,
      screenAudioStreamId: "cap-1",
    });

    await handleVoiceMessage(
      { socket: caller.socket, user: asUser("talker") },
      { type: "set-sharing-screen", sharing: false, audioStreamId: null },
    );
    expect(lastRoster(outside).participants![0]).toMatchObject({
      sharingScreen: false,
      screenAudioStreamId: null,
    });
  });

  it("treats a share announced with no id at all as silent", async () => {
    const outside = viewer("viewer");
    const caller = track(recorder());
    await join(caller, "talker");

    // An older client, which knows nothing about screen audio. The field is
    // optional precisely so this parses rather than dropping the whole frame.
    await handleVoiceMessage(
      { socket: caller.socket, user: asUser("talker") },
      { type: "set-sharing-screen", sharing: true },
    );

    expect(lastRoster(outside).participants![0]).toMatchObject({
      sharingScreen: true,
      screenAudioStreamId: null,
    });
  });

  it("never advertises audio for a share that is not running", async () => {
    const outside = viewer("viewer");
    const caller = track(recorder());
    await join(caller, "talker");

    // A stop that still carries an id must not leave one on the roster: a
    // receiver acting on it would file the presenter's microphone as a film.
    await handleVoiceMessage(
      { socket: caller.socket, user: asUser("talker") },
      { type: "set-sharing-screen", sharing: false, audioStreamId: "cap-1" },
    );

    expect(
      lastRoster(outside).participants![0]!.screenAudioStreamId,
    ).toBeNull();
  });
});

describe("concurrent screen shares are capped per transport", () => {
  const sockets: Recorder[] = [];
  const viewers: Recorder[] = [];

  beforeEach(() => {
    sockets.length = 0;
    resetVoicePeers();
    for (const rec of viewers.splice(0)) {
      deleteAuthenticatedSocket(rec.socket);
    }
    resetVoiceRateLimits();
    backend.configured = "mesh";
    resetVoiceRoomTransports();
  });

  function track(rec: Recorder): Recorder {
    sockets.push(rec);
    return rec;
  }

  function viewer(userId: string): Recorder {
    const rec = recorder();
    setAuthenticatedSocket(rec.socket, asUser(userId));
    viewers.push(rec);
    return rec;
  }

  function denials(rec: Recorder): unknown[] {
    return rec.received
      .map((raw) => JSON.parse(raw) as { type: string })
      .filter((frame) => frame.type === "screen-share-denied");
  }

  async function share(rec: Recorder, userId: string, sharing = true) {
    await handleVoiceMessage(
      { socket: rec.socket, user: asUser(userId) },
      { type: "set-sharing-screen", sharing },
    );
  }

  it("lets two people share on mesh and refuses a third", async () => {
    const outside = viewer("viewer");
    const a = track(recorder());
    const b = track(recorder());
    const c = track(recorder());
    await join(a, "a");
    await join(b, "b");
    await join(c, "c");

    await share(a, "a");
    await share(b, "b");
    await share(c, "c");

    expect(denials(c)).toHaveLength(1);
    const sharing = lastRoster(outside).participants!.filter(
      (p) => p.sharingScreen,
    );
    expect(sharing).toHaveLength(2);
  });

  it("frees a slot when a sharer stops", async () => {
    const outside = viewer("viewer");
    const a = track(recorder());
    const b = track(recorder());
    const c = track(recorder());
    await join(a, "a");
    await join(b, "b");
    await join(c, "c");
    await share(a, "a");
    await share(b, "b");
    await share(a, "a", false);
    await share(c, "c");

    expect(denials(c)).toHaveLength(0);
    expect(
      lastRoster(outside).participants!.filter((p) => p.sharingScreen),
    ).toHaveLength(2);
  });

  it("does not refuse a live sharer who re-declares while the room is at cap", async () => {
    const a = track(recorder());
    const b = track(recorder());
    await join(a, "a");
    await join(b, "b");
    await share(a, "a");
    await share(b, "b");
    const before = denials(a).length;
    await share(a, "a");
    expect(denials(a).length).toBe(before);
  });

  it("lets four people share on LiveKit and refuses a fifth", async () => {
    backend.configured = "livekit";
    resetVoiceRoomTransports();
    const outside = viewer("viewer");
    const people = ["a", "b", "c", "d", "e"].map((id) => {
      const rec = track(recorder());
      return { rec, id };
    });
    for (const person of people) {
      await join(person.rec, person.id);
    }
    for (const person of people) {
      await share(person.rec, person.id);
    }
    expect(denials(people[4]!.rec)).toHaveLength(1);
    expect(
      lastRoster(outside).participants!.filter((p) => p.sharingScreen),
    ).toHaveLength(4);
  });
});
