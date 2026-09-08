import { describe, expect, it } from "vitest";
import {
  canStartWatchPartyStream,
  computePermissions,
  defaultRolePermissions,
  isVoiceRoomChannelType,
  liveStateFromRoster,
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
