import type { DmSummary, Friend, UserStatus } from "@pqp/shared";
import { describe, expect, it } from "vitest";
import { contactGroups, isMusicRecado } from "./retro-model";

function friend(id: string, displayName: string, status: UserStatus): Friend {
  return {
    id,
    displayName,
    username: id,
    tag: null,
    avatarUrl: null,
    customStatus: null,
    status,
    friendsSince: "2026-01-01T00:00:00.000Z",
  } as Friend;
}

function dm(channelId: string, people: Friend[], kind: "dm" | "group" = "dm"): DmSummary {
  return {
    channelId,
    kind,
    participants: people,
    lastMessageAt: null,
    unread: { count: 0, mentions: 0 },
  } as unknown as DmSummary;
}

describe("contactGroups", () => {
  const lu = friend("lu", "Lu", "online");
  const bia = friend("bia", "Bia", "idle");
  const ana = friend("ana", "Ana", "online");
  const guga = friend("guga", "Guga", "dnd");
  const pedro = friend("pedro", "Pedrão", "offline");
  const stranger = friend("x", "Xavier", "online");

  it("groups friends by status in the old order, names sorted", () => {
    const { groups } = contactGroups([lu, bia, ana, guga, pedro], []);
    expect(groups.map((group) => group.id)).toEqual(["online", "dnd", "idle", "offline"]);
    expect(groups[0]!.entries.map((entry) => entry.friend.displayName)).toEqual(["Ana", "Lu"]);
    expect(groups[3]!.entries.map((entry) => entry.friend.id)).toEqual(["pedro"]);
  });

  it("pairs a friend with their 1:1 and puts everything else under others", () => {
    const withLu = dm("c1", [lu]);
    const group = dm("c2", [lu, bia], "group");
    const notFriend = dm("c3", [stranger]);
    const { groups, others } = contactGroups([lu, bia], [withLu, group, notFriend]);
    expect(groups[0]!.entries[0]!.conversation?.channelId).toBe("c1");
    expect(groups[2]!.entries[0]!.conversation).toBeNull();
    expect(others.map((one) => one.channelId)).toEqual(["c2", "c3"]);
  });

  it("search folds accents and filters both halves", () => {
    const { groups, others } = contactGroups(
      [lu, pedro],
      [dm("c3", [stranger])],
      "pedrao",
    );
    expect(groups.flatMap((group) => group.entries).map((e) => e.friend.id)).toEqual([
      "pedro",
    ]);
    expect(others).toEqual([]);
  });
});

describe("isMusicRecado", () => {
  it("a note at the start reads as listening", () => {
    expect(isMusicRecado("♫ Pitty, Na Sua Estante")).toBe(true);
    expect(isMusicRecado("🎵 algo")).toBe(true);
    expect(isMusicRecado("indo pro CS")).toBe(false);
    expect(isMusicRecado(null)).toBe(false);
  });
});
