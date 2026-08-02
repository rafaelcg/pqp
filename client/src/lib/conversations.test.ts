import type { DmSummary, PublicUser } from "@pqp/shared";
import { describe, expect, it } from "vitest";
import {
  conversationChannel,
  conversationSubtitle,
  conversationTitle,
  conversationUnreadTotals,
  sortConversations,
  touchConversation,
  unreadFromConversations,
  upsertConversation,
} from "./conversations";

function person(name: string, id = name): PublicUser {
  return {
    id,
    displayName: name,
    username: name.toLowerCase(),
    tag: `${name.toLowerCase()}#0001`,
    avatarUrl: null,
  };
}

function summary(
  channelId: string,
  overrides: Partial<DmSummary> = {},
): DmSummary {
  return {
    channelId,
    kind: "dm",
    participants: [person("Ana")],
    lastMessageAt: null,
    unread: { count: 0, mentions: 0 },
    ...overrides,
  };
}

describe("conversationTitle", () => {
  it("names a 1:1 after the other person", () => {
    expect(conversationTitle([person("Ana")])).toBe("Ana");
  });

  it("lists a small group", () => {
    expect(conversationTitle([person("Ana"), person("Bo")])).toBe("Ana, Bo");
  });

  it("counts the tail of a large group", () => {
    const people = ["Ana", "Bo", "Cy", "Dee", "Eli"].map((name) =>
      person(name),
    );
    expect(conversationTitle(people)).toBe("Ana, Bo, Cy and 2 others");
    expect(conversationTitle(people.slice(0, 4))).toBe("Ana, Bo, Cy and 1 other");
  });

  it("says so when there is nobody left rather than rendering blank", () => {
    expect(conversationTitle([])).toBe("Empty conversation");
  });
});

describe("conversationChannel", () => {
  it("belongs to no server and says which kind it is", () => {
    const channel = conversationChannel(
      summary("c1", { participants: [person("Ana")] }),
    );
    expect(channel.serverId).toBeNull();
    expect(channel.kind).toBe("dm");
    expect(channel.name).toBe("Ana");
    expect(channel.type).toBe("text");
  });

  it("is not marked private", () => {
    // `isPrivate` means a server channel with an access list. A conversation
    // that claimed it would render the private-channel lock and subtitle, which
    // describes a completely different thing.
    expect(conversationChannel(summary("c1")).isPrivate).toBe(false);
  });

  it("keeps a group a group", () => {
    const channel = conversationChannel(
      summary("c1", {
        kind: "group",
        participants: [person("Ana"), person("Bo")],
      }),
    );
    expect(channel.kind).toBe("group");
    expect(channel.name).toBe("Ana, Bo");
  });
});

describe("conversationSubtitle", () => {
  it("shows the handle of the other person in a 1:1", () => {
    expect(conversationSubtitle(summary("c1"))).toBe("ana#0001");
  });

  it("falls back when the other person has no handle yet", () => {
    const nameless = { ...person("Ana"), tag: null };
    expect(
      conversationSubtitle(summary("c1", { participants: [nameless] })),
    ).toBe("Direct message");
  });

  it("counts the reader into a group", () => {
    // The sidebar's badge counts the same way. Two counts of one room that
    // disagree by one is worse than either number on its own.
    expect(
      conversationSubtitle(
        summary("c1", {
          kind: "group",
          participants: [person("Ana"), person("Bo")],
        }),
      ),
    ).toBe("3 people");
  });
});

describe("unreadFromConversations", () => {
  it("seeds only what is actually unread", () => {
    const list = [
      summary("a", { unread: { count: 2, mentions: 1 } }),
      summary("b", { unread: { count: 0, mentions: 0 } }),
    ];
    expect(unreadFromConversations(list, null)).toEqual({
      a: { count: 2, mentions: 1 },
    });
  });

  it("never re-badges the conversation being read right now", () => {
    const list = [summary("a", { unread: { count: 2, mentions: 1 } })];
    expect(unreadFromConversations(list, "a")).toEqual({});
  });
});

describe("sortConversations", () => {
  it("puts the most recently spoken in first", () => {
    const sorted = sortConversations([
      summary("old", { lastMessageAt: "2026-01-01T00:00:00.000Z" }),
      summary("new", { lastMessageAt: "2026-08-01T00:00:00.000Z" }),
    ]);
    expect(sorted.map((c) => c.channelId)).toEqual(["new", "old"]);
  });

  it("sinks conversations nobody has spoken in", () => {
    const sorted = sortConversations([
      summary("silent"),
      summary("spoken", { lastMessageAt: "2026-01-01T00:00:00.000Z" }),
    ]);
    expect(sorted.map((c) => c.channelId)).toEqual(["spoken", "silent"]);
  });

  it("does not mutate the list it was given", () => {
    const input = [
      summary("a", { lastMessageAt: "2026-01-01T00:00:00.000Z" }),
      summary("b", { lastMessageAt: "2026-08-01T00:00:00.000Z" }),
    ];
    sortConversations(input);
    expect(input.map((c) => c.channelId)).toEqual(["a", "b"]);
  });
});

describe("upsertConversation", () => {
  it("replaces rather than duplicates an existing conversation", () => {
    const list = [summary("c1", { lastMessageAt: null })];
    const next = upsertConversation(
      list,
      summary("c1", { lastMessageAt: "2026-08-01T00:00:00.000Z" }),
    );
    expect(next).toHaveLength(1);
    expect(next[0]!.lastMessageAt).toBe("2026-08-01T00:00:00.000Z");
  });

  it("adds one that was not there", () => {
    const next = upsertConversation([summary("c1")], summary("c2"));
    expect(next.map((c) => c.channelId).sort()).toEqual(["c1", "c2"]);
  });
});

describe("touchConversation", () => {
  it("moves the conversation that was spoken in to the top", () => {
    const list = [
      summary("a", { lastMessageAt: "2026-08-01T00:00:00.000Z" }),
      summary("b", { lastMessageAt: "2026-01-01T00:00:00.000Z" }),
    ];
    const next = touchConversation(list, "b", "2026-08-02T00:00:00.000Z");
    expect(next.map((c) => c.channelId)).toEqual(["b", "a"]);
  });

  it("leaves the list alone for a channel that is not a conversation", () => {
    // Activity frames arrive for every server channel the reader can see. If
    // those re-sorted the conversation list it would reshuffle under the cursor
    // whenever anybody said anything anywhere.
    const list = [summary("a", { lastMessageAt: "2026-01-01T00:00:00.000Z" })];
    expect(touchConversation(list, "some-server-channel", "2026-08-02T00:00:00.000Z")).toBe(
      list,
    );
  });
});

describe("conversationUnreadTotals", () => {
  it("adds up only the conversations, never the server channels", () => {
    const list = [summary("a"), summary("b")];
    const totals = conversationUnreadTotals(list, {
      a: { count: 2, mentions: 1 },
      b: { count: 3, mentions: 0 },
      "server-channel": { count: 90, mentions: 9 },
    });
    expect(totals).toEqual({ count: 5, mentions: 1 });
  });

  it("ignores the snapshot counts the summaries were loaded with", () => {
    // The summary carries what was unread at load. Once a conversation is read
    // its entry leaves the live map, and the badge has to go with it.
    const list = [summary("a", { unread: { count: 7, mentions: 7 } })];
    expect(conversationUnreadTotals(list, {})).toEqual({
      count: 0,
      mentions: 0,
    });
  });
});
