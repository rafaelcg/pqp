import { describe, expect, it } from "vitest";
import {
  channelSchema,
  parseUserTag,
  publicUserSchema,
  updateChannelSchema,
  updateProfileSchema,
  userSchema,
  userSearchQuerySchema,
  userTagSchema,
} from "./api.js";
import { channelActivitySchema } from "./chat.js";
import {
  blockedUserSchema,
  conversationKindSchema,
  createBlockSchema,
  createDmSchema,
  DM_MAX_RECIPIENTS,
  dmSummarySchema,
} from "./dm.js";

const UUID_A = "11111111-1111-1111-1111-111111111111";
const UUID_B = "22222222-2222-2222-2222-222222222222";
const UUID_C = "33333333-3333-3333-3333-333333333333";

function uuids(count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  );
}

describe("publicUserSchema", () => {
  it("drops clerkId, which must never reach a third party", () => {
    // The regression this pins: someone hands `toPublicUser`'s output — the
    // /api/me shape, which carries the identity-provider id — to user search.
    // Parsing through this schema strips it; the assertion is that the key is
    // absent, not merely that parsing succeeded.
    const parsed = publicUserSchema.parse({
      id: UUID_A,
      clerkId: "user_2abcdef",
      displayName: "Ana",
      username: "ana",
      discriminator: "0001",
      tag: "ana#0001",
      avatarUrl: null,
      preferences: { theme: "dark" },
      dmPrivacy: "nobody",
    });

    expect(Object.keys(parsed).sort()).toEqual([
      "avatarUrl",
      "displayName",
      "id",
      "tag",
      "username",
    ]);
    expect("clerkId" in parsed).toBe(false);
  });
});

describe("userSchema", () => {
  it("defaults dmPrivacy so a response predating the setting still parses", () => {
    const parsed = userSchema.parse({
      id: UUID_A,
      clerkId: "user_2abcdef",
      displayName: "Ana",
      username: "ana",
      discriminator: "0001",
      tag: "ana#0001",
      avatarUrl: null,
    });
    expect(parsed.dmPrivacy).toBe("server_members");
  });
});

describe("updateProfileSchema", () => {
  it("accepts every dm_privacy the column allows and nothing else", () => {
    for (const value of ["everyone", "server_members", "nobody"]) {
      expect(updateProfileSchema.safeParse({ dmPrivacy: value }).success).toBe(
        true,
      );
    }
    expect(updateProfileSchema.safeParse({ dmPrivacy: "friends" }).success).toBe(
      false,
    );
  });
});

describe("channelSchema", () => {
  it("accepts a conversation with no server", () => {
    const parsed = channelSchema.parse({
      id: UUID_A,
      serverId: null,
      kind: "dm",
      name: "dm",
      type: "text",
      position: 0,
      isPrivate: false,
    });
    expect(parsed.serverId).toBeNull();
    expect(parsed.kind).toBe("dm");
  });

  it("reads a channel from an API predating conversations as a server channel", () => {
    const parsed = channelSchema.parse({
      id: UUID_A,
      serverId: UUID_B,
      name: "general",
      type: "text",
      position: 0,
      isPrivate: false,
    });
    expect(parsed.kind).toBe("server");
  });

  it("defaults slow mode to off", () => {
    const parsed = channelSchema.parse({
      id: UUID_A,
      serverId: UUID_B,
      name: "general",
      type: "text",
      position: 0,
      isPrivate: false,
    });
    expect(parsed.slowmodeSeconds).toBe(0);
  });

  it("accepts a slow-mode update and refuses a wait over 6 hours", () => {
    expect(updateChannelSchema.parse({ slowmodeSeconds: 5 }).slowmodeSeconds).toBe(
      5,
    );
    expect(
      updateChannelSchema.safeParse({ slowmodeSeconds: 21_601 }).success,
    ).toBe(false);
  });

  it("rejects an unknown kind", () => {
    expect(
      channelSchema.safeParse({
        id: UUID_A,
        serverId: null,
        kind: "thread",
        name: "x",
        type: "text",
        position: 0,
        isPrivate: false,
      }).success,
    ).toBe(false);
  });
});

describe("channelActivitySchema", () => {
  it("carries a conversation's activity with a null serverId", () => {
    const parsed = channelActivitySchema.parse({
      type: "channel-activity",
      serverId: null,
      kind: "dm",
      channelId: UUID_A,
      mention: true,
    });
    expect(parsed.serverId).toBeNull();
    expect(parsed.kind).toBe("dm");
  });

  it("defaults kind for a frame from a server that predates conversations", () => {
    const parsed = channelActivitySchema.parse({
      type: "channel-activity",
      serverId: UUID_B,
      channelId: UUID_A,
      mention: false,
    });
    expect(parsed.kind).toBe("server");
  });

  it("still rejects a missing serverId key — nullable is not optional", () => {
    // Nullable and absent are different: absent means the sender did not know
    // about the field, which is exactly the case where guessing a server would
    // file a private conversation's badge into a public sidebar.
    expect(
      channelActivitySchema.safeParse({
        type: "channel-activity",
        channelId: UUID_A,
        mention: false,
      }).success,
    ).toBe(false);
  });
});

describe("conversationKindSchema", () => {
  it("accepts the two conversation kinds and refuses a server channel", () => {
    expect(conversationKindSchema.safeParse("dm").success).toBe(true);
    expect(conversationKindSchema.safeParse("group").success).toBe(true);
    expect(conversationKindSchema.safeParse("server").success).toBe(false);
  });
});

describe("createDmSchema", () => {
  it("takes one recipient for a 1:1 and up to the group cap", () => {
    expect(createDmSchema.safeParse({ userIds: [UUID_A] }).success).toBe(true);
    expect(
      createDmSchema.safeParse({ userIds: uuids(DM_MAX_RECIPIENTS) }).success,
    ).toBe(true);
  });

  it("rejects an empty list, an oversized group, and non-uuids", () => {
    expect(createDmSchema.safeParse({ userIds: [] }).success).toBe(false);
    expect(
      createDmSchema.safeParse({ userIds: uuids(DM_MAX_RECIPIENTS + 1) })
        .success,
    ).toBe(false);
    expect(createDmSchema.safeParse({ userIds: ["ana"] }).success).toBe(false);
  });

  it("rejects a duplicated recipient instead of folding it away", () => {
    // Folding would turn a request for a group into a 1:1 the sender never
    // asked for — and, for a pair, would build a self-DM the dm_pairs check
    // then refuses at the insert.
    expect(
      createDmSchema.safeParse({ userIds: [UUID_A, UUID_B, UUID_A] }).success,
    ).toBe(false);
  });
});

describe("dmSummarySchema", () => {
  const participant = {
    id: UUID_B,
    displayName: "Bo",
    username: "bo",
    tag: "bo#0002",
    avatarUrl: null,
  };

  it("parses a conversation row", () => {
    const parsed = dmSummarySchema.parse({
      channelId: UUID_C,
      kind: "dm",
      participants: [participant],
      lastMessageAt: null,
      unread: { count: 3, mentions: 1 },
    });
    expect(parsed.participants).toHaveLength(1);
    expect(parsed.lastMessageAt).toBeNull();
  });

  it("refuses to describe a server channel as a conversation", () => {
    expect(
      dmSummarySchema.safeParse({
        channelId: UUID_C,
        kind: "server",
        participants: [participant],
        lastMessageAt: null,
        unread: { count: 0, mentions: 0 },
      }).success,
    ).toBe(false);
  });

  it("strips clerkId out of a participant", () => {
    const parsed = dmSummarySchema.parse({
      channelId: UUID_C,
      kind: "group",
      participants: [{ ...participant, clerkId: "user_2abcdef" }],
      lastMessageAt: "2026-08-01T00:00:00.000Z",
      unread: { count: 0, mentions: 0 },
    });
    expect("clerkId" in parsed.participants[0]!).toBe(false);
  });
});

describe("blockedUserSchema", () => {
  it("describes a blocked user with no more than search already reveals", () => {
    const parsed = blockedUserSchema.parse({
      id: UUID_B,
      clerkId: "user_2abcdef",
      displayName: "Bo",
      username: "bo",
      tag: "bo#0002",
      avatarUrl: null,
      blockedAt: "2026-08-01T00:00:00.000Z",
    });
    expect(Object.keys(parsed).sort()).toEqual([
      "avatarUrl",
      "blockedAt",
      "displayName",
      "id",
      "tag",
      "username",
    ]);
  });

  it("requires a uuid to block", () => {
    expect(createBlockSchema.safeParse({ userId: UUID_A }).success).toBe(true);
    expect(createBlockSchema.safeParse({ userId: "ana" }).success).toBe(false);
  });
});

describe("user discovery", () => {
  it("holds the search query to a floor and a ceiling", () => {
    expect(userSearchQuerySchema.safeParse("a").success).toBe(false);
    expect(userSearchQuerySchema.safeParse("an").success).toBe(true);
    expect(userSearchQuerySchema.safeParse("a".repeat(33)).success).toBe(false);
    expect(
      userSearchQuerySchema.safeParse(`an${String.fromCharCode(0)}`).success,
    ).toBe(false);
  });

  it("parses a handle the way people type it back", () => {
    expect(parseUserTag("ana#0001")).toEqual({
      username: "ana",
      discriminator: "0001",
    });
    // Copied out of a mention, or typed with the capitals a display name has.
    expect(parseUserTag("  @Ana#0001 ")).toEqual({
      username: "ana",
      discriminator: "0001",
    });
  });

  it("rejects anything that is not a whole handle", () => {
    expect(parseUserTag("ana")).toBeNull();
    expect(parseUserTag("ana#1")).toBeNull();
    expect(parseUserTag("ana#00001")).toBeNull();
    expect(parseUserTag("a#0001")).toBeNull();
    expect(parseUserTag("an a#0001")).toBeNull();
    expect(userTagSchema.safeParse("ana#0001").success).toBe(true);
    expect(userTagSchema.safeParse("ana").success).toBe(false);
  });
});
