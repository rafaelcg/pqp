import { describe, expect, it } from "vitest";
import type { DmSummary } from "@pqp/shared";
import { matchRank, quickSwitcherItems, type SwitcherSources } from "@/lib/quick-switcher";

function dm(channelId: string, people: { id: string; displayName: string }[], at: string): DmSummary {
  return {
    channelId,
    kind: people.length > 1 ? "group" : "dm",
    participants: people.map((p) => ({ ...p, avatarUrl: null })),
    lastMessageAt: at,
    unread: { count: 0, mentions: 0 },
    lastMessage: null,
  } as DmSummary;
}

const sources: SwitcherSources = {
  viewerId: "me",
  friends: [
    { id: "u-caio", displayName: "Caio", avatarUrl: null, username: "caio", tag: "caio#1", customStatus: null, status: "online" },
    { id: "u-carla", displayName: "Carla", avatarUrl: null, username: "carla", tag: "carla#2", customStatus: null, status: "offline" },
  ],
  conversations: [
    dm("c-caio", [{ id: "u-caio", displayName: "Caio" }], "2026-10-11T20:00:00Z"),
    dm("c-group", [
      { id: "u-caio", displayName: "Caio" },
      { id: "u-kata", displayName: "Kata" },
    ], "2026-10-11T19:00:00Z"),
    dm("c-zeca", [{ id: "u-zeca", displayName: "Zeca" }], "2026-10-11T21:00:00Z"),
  ],
  unread: { "c-caio": { count: 2 } },
  members: [
    { id: "me", displayName: "Me" },
    { id: "u-oscar", displayName: "Oscar Ca" },
  ],
  servers: [
    { id: "s1", name: "Casa do Caio" },
    { id: "s2", name: "MoonKase" },
  ],
  channels: [
    { id: "ch1", name: "call-do-caio", type: "voice" },
    { id: "ch2", name: "general", type: "text" },
    { id: "ch3", name: "Cat", type: "category" },
  ],
  openServerName: "MoonKase",
};

describe("matchRank", () => {
  it("prefers a start, then a word start, then anywhere", () => {
    expect(matchRank("Caio", "ca")).toBe(0);
    expect(matchRank("Oscar Ca", "ca")).toBe(1);
    expect(matchRank("Moonkase", "ka")).toBe(2);
    expect(matchRank("Bia", "ca")).toBe(-1);
  });
});

describe("quickSwitcherItems", () => {
  it("ranks people first, friends before members, then conversations, servers, channels", () => {
    const ids = quickSwitcherItems("ca", sources).map((item) => item.id);
    expect(ids).toEqual([
      "person:u-caio",
      "person:u-carla",
      "person:u-oscar",
      // "zeCA" only contains the words, so it comes after a word that starts with them.
      "person:u-zeca",
      "conversation:c-group",
      "server:s1",
      "channel:ch1",
    ]);
  });

  it("carries the existing 1:1 and its unread on a person, and never offers the viewer", () => {
    const items = quickSwitcherItems("caio", sources);
    const caio = items.find((item) => item.id === "person:u-caio");
    expect(caio).toMatchObject({ channelId: "c-caio", unread: 2, friend: true });
    expect(quickSwitcherItems("me", sources).some((item) => item.id === "person:me")).toBe(false);
  });

  it("with nothing typed, offers recent 1:1s and friends who are around, no members or servers", () => {
    const ids = quickSwitcherItems("", sources).map((item) => item.id);
    expect(ids).toEqual(["person:u-zeca", "person:u-caio", "conversation:c-group"]);
  });

  it("finds a channel with or without the #", () => {
    expect(quickSwitcherItems("#gen", sources).map((item) => item.id)).toContain("channel:ch2");
  });
});
