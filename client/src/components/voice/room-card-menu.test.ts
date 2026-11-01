import { describe, expect, it, vi } from "vitest";
import {
  roomCardMenuItems,
  type RoomCardMenuInput,
  type StageOccupantModeration,
} from "./room-card-menu";

const moderation = (
  overrides: Partial<StageOccupantModeration> = {},
): StageOccupantModeration => ({
  canServerMute: true,
  canDisconnect: true,
  canKick: () => true,
  onServerMute: vi.fn(),
  onDisconnect: vi.fn(),
  onKick: vi.fn(),
  ...overrides,
});

function build(overrides: Partial<RoomCardMenuInput> = {}) {
  return roomCardMenuItems({
    t: (key) => key,
    userId: "u-bia",
    name: "Bia",
    isSelf: false,
    serverMuted: false,
    handRaised: false,
    volume: 1,
    onSetVolume: vi.fn(),
    openProfile: vi.fn(),
    ...overrides,
  });
}

const ids = (items: ReturnType<typeof build>) =>
  items.filter((item) => !item.separator).map((item) => item.id);

describe("roomCardMenuItems", () => {
  it("gives a moderator profile, mute for you, server mute, disconnect, kick and copy name", () => {
    expect(ids(build({ moderation: moderation() }))).toEqual([
      "profile",
      "mute-for-me",
      "server-mute",
      "disconnect",
      "kick",
      "copy-name",
    ]);
  });

  it("gives anybody else profile, mute for you and copy name", () => {
    expect(ids(build())).toEqual(["profile", "mute-for-me", "copy-name"]);
    expect(
      ids(
        build({
          moderation: moderation({
            canServerMute: false,
            canDisconnect: false,
            canKick: () => false,
          }),
        }),
      ),
    ).toEqual(["profile", "mute-for-me", "copy-name"]);
  });

  it("follows each permission on its own", () => {
    const only = (patch: Partial<StageOccupantModeration>) =>
      ids(
        build({
          moderation: moderation({
            canServerMute: false,
            canDisconnect: false,
            canKick: () => false,
            ...patch,
          }),
        }),
      );
    expect(only({ canServerMute: true })).toContain("server-mute");
    expect(only({ canServerMute: true })).not.toContain("disconnect");
    expect(only({ canDisconnect: true })).toContain("disconnect");
    expect(only({ canDisconnect: true })).not.toContain("server-mute");
    expect(only({ canKick: (id) => id === "u-bia" })).toContain("kick");
  });

  it("offers unmute and server unmute when they are already on", () => {
    expect(
      ids(build({ volume: 0, serverMuted: true, moderation: moderation() })),
    ).toEqual([
      "profile",
      "unmute-for-me",
      "server-unmute",
      "disconnect",
      "kick",
      "copy-name",
    ]);
  });

  it("gives your own card only profile and copy name", () => {
    expect(
      ids(
        build({
          isSelf: true,
          volume: undefined,
          onSetVolume: undefined,
          moderation: moderation(),
        }),
      ),
    ).toEqual(["profile", "copy-name"]);
  });

  it("leaves out mute for you where nothing is received from them", () => {
    expect(ids(build({ onSetVolume: undefined }))).toEqual([
      "profile",
      "copy-name",
    ]);
  });

  it("offers no profile or moderation for a person with no account id", () => {
    expect(
      ids(build({ userId: undefined, moderation: moderation() })),
    ).toEqual(["mute-for-me", "copy-name"]);
  });

  it("shows the lower-hand and audience actions only while they apply", () => {
    const base = { moderation: moderation(), onLowerHand: vi.fn() };
    expect(ids(build(base))).not.toContain("lower-hand");
    expect(ids(build({ ...base, handRaised: true }))).toContain("lower-hand");
    const audience = (action: "allow" | "silence" | null) => ({
      action,
      onSet: vi.fn(),
    });
    expect(ids(build({ ...base, audience: audience("allow") }))).toContain(
      "audience-allow",
    );
    expect(ids(build({ ...base, audience: audience("silence") }))).toContain(
      "audience-silence",
    );
    expect(ids(build({ ...base, audience: audience(null) }))).not.toContain(
      "audience-allow",
    );
  });

  it("runs the callbacks with the person's id", () => {
    const mod = moderation();
    const onSetVolume = vi.fn();
    const items = build({ moderation: mod, onSetVolume });
    const pick = (id: string) => items.find((item) => item.id === id)!;
    pick("mute-for-me").onSelect!();
    expect(onSetVolume).toHaveBeenCalledWith(0);
    pick("server-mute").onSelect!();
    expect(mod.onServerMute).toHaveBeenCalledWith("u-bia", true);
    pick("disconnect").onSelect!();
    expect(mod.onDisconnect).toHaveBeenCalledWith("u-bia");
    pick("kick").onSelect!();
    expect(mod.onKick).toHaveBeenCalledWith("u-bia", "Bia");
  });

  it("groups the items with separators, like the sidebar menu", () => {
    const items = build({ moderation: moderation() });
    expect(items.map((item) => (item.separator ? "-" : item.id))).toEqual([
      "profile",
      "-",
      "mute-for-me",
      "server-mute",
      "-",
      "disconnect",
      "kick",
      "-",
      "copy-name",
    ]);
  });
});
