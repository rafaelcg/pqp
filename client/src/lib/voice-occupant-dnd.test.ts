import { describe, expect, it } from "vitest";
import { Permission } from "@pqp/shared";
import type { VoiceParticipant } from "@pqp/shared";
import {
  canDragVoiceOccupant,
  cloneVoiceOccupancy,
  dropReasonMessageKey,
  moveMembersBit,
  moveOccupantSeat,
  resolveVoiceOccupantDrop,
  shouldHighlightVoiceDrop,
  voiceOccupantMenuActions,
  type VoiceDropCaps,
  type VoiceOccupantDrag,
} from "./voice-occupant-dnd";

const self: VoiceOccupantDrag = {
  userId: "u-self",
  fromChannelId: "voice-a",
  isSelf: true,
};

const other: VoiceOccupantDrag = {
  userId: "u-other",
  fromChannelId: "voice-a",
  isSelf: false,
};

const caps = (
  overrides: Partial<VoiceDropCaps> = {},
): VoiceDropCaps => ({
  canMoveIn: () => true,
  canConnectIn: () => true,
  ...overrides,
});

describe("moveMembersBit", () => {
  it("uses MOVE_MEMBERS when the shared package has it, otherwise MODERATE_MEMBERS", () => {
    const extra = Permission as typeof Permission & { MOVE_MEMBERS?: bigint };
    expect(moveMembersBit()).toBe(
      extra.MOVE_MEMBERS ?? Permission.MODERATE_MEMBERS,
    );
  });
});

describe("canDragVoiceOccupant", () => {
  it("lets you drag yourself even without Move Members", () => {
    expect(canDragVoiceOccupant(true, "voice-a", () => false)).toBe(true);
  });

  it("does not let you drag someone else without Move Members on that channel", () => {
    expect(canDragVoiceOccupant(false, "voice-a", () => false)).toBe(false);
  });

  it("lets staff drag someone else when Move Members is on the source channel", () => {
    expect(
      canDragVoiceOccupant(false, "voice-a", (id) => id === "voice-a"),
    ).toBe(true);
  });
});

describe("resolveVoiceOccupantDrop", () => {
  it("refuses a drop on a text channel", () => {
    expect(
      resolveVoiceOccupantDrop(self, { id: "text-1", type: "text" }, caps()),
    ).toEqual({ ok: false, reason: "text" });
    expect(
      resolveVoiceOccupantDrop(other, { id: "text-1", type: "text" }, caps()),
    ).toEqual({ ok: false, reason: "text" });
  });

  it("refuses a drop on a category", () => {
    expect(
      resolveVoiceOccupantDrop(
        other,
        { id: "cat-1", type: "category" },
        caps(),
      ),
    ).toEqual({ ok: false, reason: "category" });
  });

  it("no-ops on the channel they already sit in", () => {
    expect(
      resolveVoiceOccupantDrop(
        other,
        { id: "voice-a", type: "voice" },
        caps(),
      ),
    ).toEqual({ ok: false, reason: "same" });
  });

  it("self-drop is a join, not a staff move", () => {
    expect(
      resolveVoiceOccupantDrop(
        self,
        { id: "voice-b", type: "voice" },
        caps({ canMoveIn: () => false }),
      ),
    ).toEqual({ ok: true, action: "join" });
  });

  it("self-drop needs Connect on the destination", () => {
    expect(
      resolveVoiceOccupantDrop(
        self,
        { id: "voice-b", type: "voice" },
        caps({ canConnectIn: (id) => id !== "voice-b" }),
      ),
    ).toEqual({ ok: false, reason: "no-connect" });
  });

  it("moving someone else requires Move Members on the source channel", () => {
    expect(
      resolveVoiceOccupantDrop(
        other,
        { id: "voice-b", type: "voice" },
        caps({ canMoveIn: () => false }),
      ),
    ).toEqual({ ok: false, reason: "no-move" });
    expect(
      resolveVoiceOccupantDrop(
        other,
        { id: "voice-b", type: "voice" },
        caps({ canMoveIn: (id) => id === "voice-a" }),
      ),
    ).toEqual({ ok: true, action: "move" });
  });

  it("does not highlight a text channel as a drop target", () => {
    expect(
      shouldHighlightVoiceDrop(other, { id: "text-1", type: "text" }, caps()),
    ).toBe(false);
    expect(
      shouldHighlightVoiceDrop(
        other,
        { id: "voice-b", type: "voice" },
        caps(),
      ),
    ).toBe(true);
  });
});

describe("voiceOccupantMenuActions", () => {
  const base = {
    isSelf: false,
    inSameCall: true,
    mutedForMe: false,
    canServerMute: true,
    canDisconnect: true,
    canKick: true,
  };

  it("always offers profile and copy name", () => {
    expect(voiceOccupantMenuActions({ ...base, isSelf: true })).toEqual([
      "profile",
      "copyName",
    ]);
  });

  it("gates mute-for-me on being in the same call", () => {
    expect(
      voiceOccupantMenuActions({ ...base, inSameCall: false }),
    ).not.toContain("muteForMe");
    expect(voiceOccupantMenuActions(base)).toContain("muteForMe");
    expect(
      voiceOccupantMenuActions({ ...base, mutedForMe: true }),
    ).toContain("unmuteForMe");
  });

  it("hides server mute, disconnect and kick when the actor cannot", () => {
    expect(
      voiceOccupantMenuActions({
        ...base,
        canServerMute: false,
        canDisconnect: false,
        canKick: false,
      }),
    ).toEqual(["profile", "muteForMe", "copyName"]);
  });

  it("does not offer kick, disconnect or mutes against yourself", () => {
    const items = voiceOccupantMenuActions({ ...base, isSelf: true });
    expect(items).not.toContain("kick");
    expect(items).not.toContain("disconnect");
    expect(items).not.toContain("serverMute");
    expect(items).not.toContain("muteForMe");
  });

  it("never invents ban, timeout, promote, demote or server deafen", () => {
    const items = voiceOccupantMenuActions(base);
    expect(items.join(" ")).not.toMatch(/ban|timeout|promote|demote|deafen/);
  });
});

describe("dropReasonMessageKey", () => {
  it("maps text and category to the same copy", () => {
    expect(dropReasonMessageKey("text")).toBe("voice.occupant.dropText");
    expect(dropReasonMessageKey("category")).toBe("voice.occupant.dropText");
  });
});

describe("moveOccupantSeat", () => {
  const andre: VoiceParticipant = {
    peerId: "peer-andre",
    userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    displayName: "Andre",
    avatarUrl: null,
    sharingScreen: false,
    muted: true,
    deafened: false,
  };

  it("paints them under the target channel immediately", () => {
    const occupancy = { "voice-a": [andre] };
    const { next, fromChannelId, moved } = moveOccupantSeat(
      occupancy,
      andre.userId,
      "voice-b",
    );
    expect(fromChannelId).toBe("voice-a");
    expect(moved).toEqual(andre);
    expect(next["voice-a"]).toBeUndefined();
    expect(next["voice-b"]).toEqual([andre]);
    expect(next["voice-b"]?.[0]?.muted).toBe(true);
  });

  it("rolls back to the snapshot when the move fails", () => {
    const occupancy = { "voice-a": [andre] };
    const snapshot = cloneVoiceOccupancy(occupancy);
    const { next } = moveOccupantSeat(occupancy, andre.userId, "voice-b");
    expect(next["voice-b"]).toHaveLength(1);
    expect(snapshot).toEqual({ "voice-a": [andre] });
  });
});
