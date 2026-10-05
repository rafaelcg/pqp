import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Permission, PERMISSION_DEFAULT_EVERYONE } from "@pqp/shared";
const db = vi.hoisted(() => ({ fail: false }));
vi.mock("../db.js", () => ({
  getPool: () => ({
    query: async () => {
      if (db.fail) {
        throw new Error("connect ECONNREFUSED");
      }
      return { rows: [], rowCount: 0 };
    },
  }),
}));

import {
  applyAudienceMode,
  audienceModeApplies,
  audienceWireState,
  cacheAudience,
  isAudienceStage,
  loadAudience,
  logPerRoom,
  resetAudienceForTests,
  resetAudienceLogLimiterForTests,
} from "./audience.js";

/**
 * THE RULE, alone. `docs/plans/AUDIENCE_MODE.md` (b): the stage keeps what it
 * had, an invited person gets the microphone back and nothing else, everybody
 * else publishes nothing, and none of it ever grants a bit the channel denies.
 * Every path that answers "may this person publish" calls this one function,
 * so this table is the whole of the security property.
 */

const EVERYONE = PERMISSION_DEFAULT_EVERYONE;
const MODERATOR = EVERYONE | Permission.MUTE_MEMBERS;
const CHANNEL_MANAGER = EVERYONE | Permission.MANAGE_CHANNELS;
const ADMIN = Permission.ADMINISTRATOR;
const LISTENER = Permission.CONNECT;

const room = (speakers: string[] = []) => ({ speakers: new Set(speakers) });
const full = { canSpeak: true, canStream: true, canShowFace: false };

describe("applyAudienceMode", () => {
  it("off: unchanged, and a denied SPEAK is reported as the channel's", () => {
    expect(
      applyAudienceMode(full, { audience: null, permissions: EVERYONE, userId: "a" }),
    ).toEqual({ ...full, speakReason: null });
    expect(
      applyAudienceMode(
        { canSpeak: false, canStream: false },
        { audience: null, permissions: LISTENER, userId: "a" },
      ),
    ).toEqual({ canSpeak: false, canStream: false, speakReason: "permission" });
  });

  it("on: the audience publishes nothing and is told why", () => {
    expect(
      applyAudienceMode(full, { audience: room(), permissions: EVERYONE, userId: "a" }),
    ).toEqual({ canSpeak: false, canStream: false, canShowFace: false, speakReason: "audience" });
  });

  it("on: MUTE_MEMBERS, MANAGE_CHANNELS and Administrator keep everything", () => {
    for (const permissions of [MODERATOR, CHANNEL_MANAGER, ADMIN]) {
      expect(
        applyAudienceMode(full, { audience: room(), permissions, userId: "m" }),
      ).toEqual({ ...full, speakReason: null });
    }
  });

  it("on: an invited person gets the microphone back, not the camera or the screen", () => {
    expect(
      applyAudienceMode(full, {
        audience: room(["invited"]),
        permissions: EVERYONE,
        userId: "invited",
      }),
    ).toEqual({ canSpeak: true, canStream: false, canShowFace: false, speakReason: null });
  });

  it("never widens: an invitation cannot give a microphone the channel denies", () => {
    const denied = { canSpeak: false, canStream: false };
    expect(
      applyAudienceMode(denied, {
        audience: room(["invited"]),
        permissions: LISTENER,
        userId: "invited",
      }),
    ).toEqual({ canSpeak: false, canStream: false, speakReason: "permission" });
    // Not even the stage: audience mode never adds a bit.
    expect(
      applyAudienceMode(denied, {
        audience: room(),
        permissions: LISTENER | Permission.MUTE_MEMBERS,
        userId: "m",
      }),
    ).toMatchObject({ canSpeak: false, canStream: false });
    // And a channel that denies SPEAK says so, rather than blaming the mode.
    expect(
      applyAudienceMode(denied, { audience: room(), permissions: LISTENER, userId: "x" })
        .speakReason,
    ).toBe("permission");
  });

  it("an invitation is for that person only", () => {
    expect(
      applyAudienceMode(full, {
        audience: room(["someone-else"]),
        permissions: EVERYONE,
        userId: "a",
      }).canSpeak,
    ).toBe(false);
  });
});

describe("who runs the stage", () => {
  it("is exactly MUTE_MEMBERS, MANAGE_CHANNELS or Administrator", () => {
    expect(isAudienceStage(EVERYONE)).toBe(false);
    expect(isAudienceStage(Permission.SPEAK | Permission.STREAM)).toBe(false);
    expect(isAudienceStage(Permission.MOVE_MEMBERS)).toBe(false);
    expect(isAudienceStage(MODERATOR)).toBe(true);
    expect(isAudienceStage(CHANNEL_MANAGER)).toBe(true);
    expect(isAudienceStage(ADMIN)).toBe(true);
  });
});

describe("where it applies", () => {
  it("a server's plain voice channel only", () => {
    expect(audienceModeApplies({ kind: "server", server_id: "s", type: "voice" })).toBe(true);
    expect(audienceModeApplies({ kind: "server", server_id: "s", type: "watch_party" })).toBe(
      false,
    );
    expect(audienceModeApplies({ kind: "conversation", server_id: null, type: "text" })).toBe(
      false,
    );
    expect(audienceModeApplies(null)).toBe(false);
  });
});

describe("the wire state", () => {
  beforeEach(() => resetAudienceForTests());

  it("is sorted, carries what the SFU has not confirmed, and null when off", () => {
    const state = cacheAudience("room", { since: 5, byUserId: "host", speakers: ["b", "a"] })!;
    state.unenforced.add("z");
    state.unenforced.add("y");
    expect(audienceWireState(state)).toEqual({
      since: 5,
      byUserId: "host",
      speakerUserIds: ["a", "b"],
      unenforcedUserIds: ["y", "z"],
    });
    expect(audienceWireState(null)).toBeNull();
  });

  it("a new session forgets what the old one could not enforce; the same session keeps it", () => {
    const first = cacheAudience("room", { since: 5, byUserId: "host", speakers: [] })!;
    first.unenforced.add("x");
    expect(
      cacheAudience("room", { since: 5, byUserId: "host", speakers: ["a"] })!.unenforced.has("x"),
    ).toBe(true);
    expect(
      cacheAudience("room", { since: 9, byUserId: "host", speakers: [] })!.unenforced.size,
    ).toBe(0);
  });
});

describe("the per-room line limiter", () => {
  beforeEach(() => {
    resetAudienceLogLimiterForTests();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("writes one line per room per minute and counts the rest on the next", () => {
    for (let i = 0; i < 5; i++) {
      logPerRoom("voice.speakDenied", "room-1", { reason: "audience" }, 1_000 + i);
    }
    logPerRoom("voice.speakDenied", "room-2", { reason: "permission" }, 1_000);
    logPerRoom("voice.speakDenied", "room-1", { reason: "audience" }, 62_000);
    const lines = vi.mocked(console.log).mock.calls.map((call) => String(call[0]));
    expect(lines).toEqual([
      "[pqp] voice.speakDenied voiceChannelId=room-1 reason=audience",
      "[pqp] voice.speakDenied voiceChannelId=room-2 reason=permission",
      "[pqp] voice.speakDenied voiceChannelId=room-1 reason=audience suppressed=4",
    ]);
  });
});

describe("reading the room's state when the database will not answer", () => {
  const channel = { kind: "server", server_id: "server-1", type: "voice" };
  beforeEach(() => {
    resetAudienceForTests();
    process.env.VOICE_REGISTRY = "postgres";
    process.env.AUDIENCE_MODE = "true";
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    db.fail = false;
    delete process.env.VOICE_REGISTRY;
    delete process.env.AUDIENCE_MODE;
    vi.restoreAllMocks();
  });

  it("refuses rather than guess 'off' when this process has nothing cached", async () => {
    db.fail = true;
    await expect(loadAudience(channel, "room-1")).rejects.toThrow("ECONNREFUSED");
  });

  it("answers from what this process last knew when it knew something", async () => {
    cacheAudience("room-1", { since: 5, byUserId: "host", speakers: [] });
    db.fail = true;
    expect(await loadAudience(channel, "room-1")).toMatchObject({ since: 5 });
  });

  it("never reads at all where the flag is off", async () => {
    process.env.AUDIENCE_MODE = "false";
    db.fail = true;
    expect(await loadAudience(channel, "room-1")).toBeNull();
  });
});
