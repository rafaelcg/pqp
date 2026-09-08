import { describe, expect, it } from "vitest";
import {
  canStartWatchPartyStream,
  computePermissions,
  defaultRolePermissions,
  isVoiceRoomChannelType,
  liveStateFromRoster,
  liveStateFromStream,
  PERMISSION_ALL,
  PERMISSION_DEFAULT_EVERYONE,
  PERMISSION_DEFAULT_MODERATOR,
  Permission,
} from "./index.js";

const everyone = PERMISSION_DEFAULT_EVERYONE;

describe("START_WATCH_PARTY", () => {
  it("is in ALL and the moderator extras, never in @everyone", () => {
    expect(PERMISSION_ALL & Permission.START_WATCH_PARTY).toBe(
      Permission.START_WATCH_PARTY,
    );
    expect(PERMISSION_DEFAULT_MODERATOR & Permission.START_WATCH_PARTY).toBe(
      Permission.START_WATCH_PARTY,
    );
    expect(defaultRolePermissions("manager") & Permission.START_WATCH_PARTY).toBe(
      Permission.START_WATCH_PARTY,
    );
    expect(everyone & Permission.START_WATCH_PARTY).toBe(0n);
  });

  it("admin may start, a plain member may not", () => {
    expect(
      canStartWatchPartyStream({
        channelType: "watch_party",
        permissions: defaultRolePermissions("admin"),
      }),
    ).toBe(true);
    expect(
      canStartWatchPartyStream({
        channelType: "watch_party",
        permissions: everyone,
      }),
    ).toBe(false);
  });

  it("STREAM alone is not enough in a watch party, but still rules voice", () => {
    expect(everyone & Permission.STREAM).toBe(Permission.STREAM);
    expect(
      canStartWatchPartyStream({ channelType: "watch_party", permissions: everyone }),
    ).toBe(false);
    expect(
      canStartWatchPartyStream({ channelType: "voice", permissions: everyone }),
    ).toBe(true);
    expect(
      canStartWatchPartyStream({
        channelType: "voice",
        permissions: everyone & ~Permission.STREAM,
      }),
    ).toBe(false);
  });

  it("a channel overwrite flips it both ways", () => {
    const granted = computePermissions({
      isOwner: false,
      everyonePermissions: everyone,
      rolePermissions: [],
      everyoneOverwrite: { allow: Permission.START_WATCH_PARTY, deny: 0n },
      roleOverwrites: [],
      memberOverwrite: null,
      timedOut: false,
    });
    expect(
      canStartWatchPartyStream({ channelType: "watch_party", permissions: granted }),
    ).toBe(true);

    const revoked = computePermissions({
      isOwner: false,
      everyonePermissions: everyone,
      rolePermissions: [PERMISSION_DEFAULT_MODERATOR],
      everyoneOverwrite: { allow: 0n, deny: 0n },
      roleOverwrites: [],
      memberOverwrite: { allow: 0n, deny: Permission.START_WATCH_PARTY },
      timedOut: false,
    });
    expect(
      canStartWatchPartyStream({ channelType: "watch_party", permissions: revoked }),
    ).toBe(false);
  });
});

describe("watch party channel type", () => {
  it("opens a voice room", () => {
    expect(isVoiceRoomChannelType("watch_party")).toBe(true);
    expect(isVoiceRoomChannelType("voice")).toBe(true);
    expect(isVoiceRoomChannelType("text")).toBe(false);
  });

  it("derives live state from the roster", () => {
    expect(liveStateFromRoster([])).toMatchObject({ live: false, viewerCount: 0 });
    expect(
      liveStateFromRoster([
        { peerId: "a", sharingScreen: false },
        { peerId: "b", sharingScreen: true },
        { peerId: "c", sharingScreen: false },
      ]),
    ).toEqual({
      live: true,
      presenterPeerId: "b",
      viewerCount: 2,
      startedAt: null,
      hlsUrl: null,
    });
  });
});

describe("liveStateFromStream", () => {
  const stream = {
    hlsUrl: "/api/voice/hls-playlist/c1/1700000000000?t=tok",
    startedAt: 1700000000000,
    presenterPeerId: "host",
    delaySeconds: 10,
  };
  const seat = (peerId: string, sharingScreen = false) => ({
    peerId,
    sharingScreen,
  });

  it("counts the room minus the presenter, plus the seatless watchers", () => {
    const state = liveStateFromStream(
      stream,
      [seat("host", true), seat("a"), seat("b")],
      7,
    );
    expect(state).toEqual({
      live: true,
      presenterPeerId: "host",
      viewerCount: 9,
      startedAt: 1700000000000,
      hlsUrl: stream.hlsUrl,
    });
  });

  it("does not subtract a presenter who is not on the roster", () => {
    // Egress keeps running for a moment after the host's socket dropped; the
    // two people left in the room are still two viewers, not one.
    expect(liveStateFromStream(stream, [seat("a"), seat("b")], 0).viewerCount).toBe(2);
  });

  it("is the watchers alone when nobody else is seated", () => {
    expect(liveStateFromStream(stream, undefined, 3).viewerCount).toBe(3);
    expect(liveStateFromStream(stream, [seat("host", true)], 0).viewerCount).toBe(0);
  });

  it("is not live without a stream, whatever the roster says", () => {
    expect(liveStateFromStream(null, [seat("host", true), seat("a")], 4)).toEqual(
      liveStateFromRoster(undefined),
    );
  });
});
