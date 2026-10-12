import { describe, expect, it } from "vitest";
import type { DmSummary, FriendsResponse } from "@pqp/shared";
import { newlyAcceptedFriends } from "@/components/conversations/friend-accepted-toast";
import { pickerSections } from "@/components/conversations/new-conversation-dialog";

function friend(id: string, displayName: string, status: "online" | "idle" | "dnd" | "offline") {
  return {
    id,
    displayName,
    avatarUrl: null,
    username: displayName.toLowerCase(),
    tag: `${displayName.toLowerCase()}#0001`,
    customStatus: null,
    status,
    friendsSince: "2026-01-01T00:00:00.000Z",
  };
}

function oneToOne(channelId: string, id: string, displayName: string): DmSummary {
  return {
    channelId,
    kind: "dm",
    participants: [{ id, displayName, avatarUrl: null }],
    lastMessageAt: null,
    unread: { count: 0, mentions: 0 },
    lastMessage: null,
  } as DmSummary;
}

describe("Nova conversa sections", () => {
  const friends = [
    friend("f1", "Zeca", "online"),
    friend("f2", "Ana", "idle"),
    friend("f3", "Bruno", "offline"),
  ];
  const conversations = [
    oneToOne("c1", "f3", "Bruno"),
    oneToOne("c2", "s1", "Stranger"),
    oneToOne("c3", "s1", "Stranger"),
  ];

  it("lists friends who are around first, then the other friends, then recent non-friends", () => {
    const sections = pickerSections(friends, conversations, {
      query: "",
      excludeIds: new Set(),
    });
    expect(sections.online.map((p) => p.displayName)).toEqual(["Ana", "Zeca"]);
    expect(sections.friends.map((p) => p.displayName)).toEqual(["Bruno"]);
    // A friend is never repeated under Recentes, and a person appears once.
    expect(sections.recent.map((p) => p.id)).toEqual(["s1"]);
  });

  it("narrows by the typed words, accents and tags included, and leaves out the excluded", () => {
    const sections = pickerSections(friends, conversations, {
      query: "zeca#",
      excludeIds: new Set(),
    });
    expect(sections.online.map((p) => p.id)).toEqual(["f1"]);
    const withoutMe = pickerSections(friends, conversations, {
      query: "",
      excludeIds: new Set(["f2"]),
    });
    expect(withoutMe.online.map((p) => p.id)).toEqual(["f1"]);
  });
});

describe("the friend-accepted card", () => {
  const empty: FriendsResponse = { friends: [], incoming: [], outgoing: [] };
  const bia = friend("b", "Bia", "online");

  it("stays quiet on the first snapshot", () => {
    expect(newlyAcceptedFriends(null, { ...empty, friends: [bia] })).toEqual([]);
  });

  it("speaks when somebody accepted a request this account sent", () => {
    const before = { ...empty, outgoing: [{ ...bia, requestedAt: "2026-10-10T00:00:00.000Z" }] };
    expect(newlyAcceptedFriends(before, { ...empty, friends: [bia] }).map((p) => p.id)).toEqual(["b"]);
  });

  it("stays quiet when this account did the accepting", () => {
    const before = { ...empty, incoming: [{ ...bia, requestedAt: "2026-10-10T00:00:00.000Z" }] };
    expect(newlyAcceptedFriends(before, { ...empty, friends: [bia] })).toEqual([]);
  });
});
