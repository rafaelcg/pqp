import { describe, expect, it } from "vitest";
import type { DmSummary } from "@pqp/shared";
import {
  conversationsWithUnread,
  filterConversations,
  foldForSearch,
  matchesConversationQuery,
  splitPinned,
} from "@/lib/conversation-list";

function person(id: string, displayName: string, tag?: string) {
  return { id, displayName, avatarUrl: null, ...(tag ? { tag } : {}) };
}

function dm(channelId: string, people: ReturnType<typeof person>[], kind: "dm" | "group" = "dm"): DmSummary {
  return {
    channelId,
    kind,
    participants: people,
    lastMessageAt: null,
    unread: { count: 0, mentions: 0 },
    lastMessage: null,
  } as DmSummary;
}

const joao = dm("c1", [person("u1", "João Pedro", "joaop#1234")]);
const bia = dm("c2", [person("u2", "Bia")]);
const group = dm("c3", [person("u3", "Caio"), person("u4", "Kata")], "group");
const list = [joao, bia, group];

describe("search", () => {
  it("folds accents and case, the way people type on a phone", () => {
    expect(foldForSearch("  JOÃO  ")).toBe("joao");
    expect(matchesConversationQuery(joao, "joao")).toBe(true);
    expect(matchesConversationQuery(joao, "Pedr")).toBe(true);
  });

  it("finds a group by any member and a person by their tag", () => {
    expect(matchesConversationQuery(group, "kat")).toBe(true);
    expect(matchesConversationQuery(joao, "#1234")).toBe(true);
    expect(matchesConversationQuery(bia, "kat")).toBe(false);
    expect(matchesConversationQuery(bia, "   ")).toBe(true);
  });
});

describe("filterConversations", () => {
  const unread = { c2: { count: 3, mentions: 0 } };

  it("Tudo keeps everything, Grupos keeps groups", () => {
    expect(filterConversations(list, { query: "", filter: "all", unread, openChannelId: null })).toEqual(list);
    expect(
      filterConversations(list, { query: "", filter: "groups", unread, openChannelId: null }),
    ).toEqual([group]);
  });

  it("Não lidas keeps unread ones, and never drops the conversation that is open", () => {
    expect(
      filterConversations(list, { query: "", filter: "unread", unread, openChannelId: null }),
    ).toEqual([bia]);
    // Reading it must not make it vanish from under the pointer.
    expect(
      filterConversations(list, { query: "", filter: "unread", unread: {}, openChannelId: "c1" }),
    ).toEqual([joao]);
  });

  it("search and chip combine", () => {
    expect(
      filterConversations(list, { query: "bia", filter: "groups", unread, openChannelId: null }),
    ).toEqual([]);
  });
});

describe("splitPinned", () => {
  it("keeps pin order for Fixadas and recency order for the rest, ignoring unknown ids", () => {
    const { pinned, recent } = splitPinned(list, ["c3", "gone", "c1", "c3"]);
    expect(pinned.map((one) => one.channelId)).toEqual(["c3", "c1"]);
    expect(recent.map((one) => one.channelId)).toEqual(["c2"]);
  });
});

describe("conversationsWithUnread (the rail and tab badge)", () => {
  it("counts conversations, not messages", () => {
    const unread = {
      c1: { count: 40, mentions: 0 },
      c2: { count: 1, mentions: 0 },
      c3: { count: 2, mentions: 1 },
    };
    expect(conversationsWithUnread(list, unread)).toHaveLength(3);
  });

  it("leaves out the open conversation and muted ones", () => {
    const unread = { c1: { count: 4, mentions: 0 }, c2: { count: 1, mentions: 0 } };
    expect(
      conversationsWithUnread(list, unread, {
        openChannelId: "c1",
        isMuted: (id) => id === "c2",
      }),
    ).toEqual([]);
  });
});
