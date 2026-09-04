import { describe, expect, it } from "vitest";
import type { DmSummary } from "@pqp/shared";
import { PINNED_CONVERSATIONS_MAX } from "@pqp/shared";
import {
  addPinnedConversation,
  isPinnedConversation,
  prunePinnedConversations,
  removePinnedConversation,
  visiblePinnedConversations,
} from "./pinned-conversations";

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const CAROL = "33333333-3333-4333-8333-333333333333";
const GHOST = "44444444-4444-4444-8444-444444444444";

function dm(channelId: string): DmSummary {
  return {
    channelId,
    kind: "dm",
    participants: [
      {
        id: channelId,
        displayName: channelId.slice(0, 8),
        username: null,
        tag: null,
        avatarUrl: null,
      },
    ],
    lastMessageAt: null,
    unread: { count: 0, mentions: 0 },
  };
}

const alice = dm(ALICE);
const bob = dm(BOB);
const carol = dm(CAROL);

describe("visiblePinnedConversations", () => {
  it("keeps stored order and skips missing ids and duplicates", () => {
    expect(
      visiblePinnedConversations([carol, alice, bob], [BOB, GHOST, ALICE, BOB]),
    ).toEqual([bob, alice]);
  });

  it("drops ids that are no longer in the conversation list", () => {
    expect(prunePinnedConversations([BOB, GHOST, ALICE], [alice, carol])).toEqual(
      [ALICE],
    );
    expect(prunePinnedConversations(undefined, [alice])).toEqual([]);
  });
});

describe("addPinnedConversation / removePinnedConversation", () => {
  it("appends a new id and is a no-op when already pinned", () => {
    expect(addPinnedConversation([ALICE], BOB)).toEqual([ALICE, BOB]);
    expect(addPinnedConversation([ALICE], ALICE)).toEqual([ALICE]);
  });

  it("lets a new pin through after ghosts are dropped", () => {
    const live = Array.from(
      { length: PINNED_CONVERSATIONS_MAX },
      (_, i) => dm(`11111111-1111-4111-8111-${String(i).padStart(12, "0")}`),
    );
    const stored = [...live.map((one) => one.channelId), GHOST];
    const pruned = prunePinnedConversations(stored, live.slice(0, -1));
    expect(pruned).toHaveLength(PINNED_CONVERSATIONS_MAX - 1);
    expect(addPinnedConversation(pruned, CAROL)).toContain(CAROL);
  });

  it("ignores a new pin past the cap rather than dropping the oldest", () => {
    const full = Array.from(
      { length: PINNED_CONVERSATIONS_MAX },
      (_, i) => `11111111-1111-4111-8111-${String(i).padStart(12, "0")}`,
    );
    expect(addPinnedConversation(full, CAROL)).toEqual(full);
  });

  it("removes one id and treats a missing list as empty", () => {
    expect(removePinnedConversation([ALICE, BOB], ALICE)).toEqual([BOB]);
    expect(removePinnedConversation(undefined, ALICE)).toEqual([]);
  });
});

describe("isPinnedConversation", () => {
  it("is false for a missing list", () => {
    expect(isPinnedConversation(undefined, ALICE)).toBe(false);
    expect(isPinnedConversation([ALICE], ALICE)).toBe(true);
    expect(isPinnedConversation([ALICE], BOB)).toBe(false);
  });
});
