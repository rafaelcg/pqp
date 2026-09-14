import { describe, expect, it } from "vitest";
import {
  MAX_CARDS,
  MIN_RESUME_MS,
  TOAST_MS,
  VISIBILITY_RESUME_MS,
  freezeToastCards,
  markToastLeaving,
  nextToastDeadline,
  pauseToastCard,
  removeToastCard,
  resumeToastCard,
  shouldShowArrivalToast,
  thawToastCards,
  upsertToastCard,
  type ArrivalToastInput,
  type ToastCard,
} from "./dm-toast-queue";

function input(overrides: Partial<ArrivalToastInput> = {}): ArrivalToastInput {
  return {
    kind: "dm",
    channelId: "c1",
    selectedChannelId: null,
    documentVisible: true,
    windowFocused: true,
    level: "all",
    doNotDisturb: false,
    immersive: false,
    ...overrides,
  };
}

describe("shouldShowArrivalToast — the §3.6 suppression table", () => {
  it("a server channel never toasts", () => {
    expect(shouldShowArrivalToast(input({ kind: "server" }))).toBe(false);
  });

  it("conversation open and window focused: no toast", () => {
    expect(
      shouldShowArrivalToast(
        input({ channelId: "c1", selectedChannelId: "c1", windowFocused: true }),
      ),
    ).toBe(false);
  });

  it("conversation open, window blurred: no toast (the OS carries it)", () => {
    expect(
      shouldShowArrivalToast(
        input({ channelId: "c1", selectedChannelId: "c1", windowFocused: false }),
      ),
    ).toBe(false);
  });

  it("level 'none' (muted): no toast", () => {
    expect(shouldShowArrivalToast(input({ level: "none" }))).toBe(false);
  });

  it("do not disturb: no toast", () => {
    expect(shouldShowArrivalToast(input({ doNotDisturb: true }))).toBe(false);
  });

  it("immersive stage (fullscreen watch party / call): no toast", () => {
    expect(shouldShowArrivalToast(input({ immersive: true }))).toBe(false);
  });

  it("window not focused, tab visible: no toast — the OS carries it", () => {
    expect(
      shouldShowArrivalToast(
        input({ documentVisible: true, windowFocused: false }),
      ),
    ).toBe(false);
  });

  it("window not focused, tab hidden: no toast — the OS carries it", () => {
    expect(
      shouldShowArrivalToast(
        input({ documentVisible: false, windowFocused: false }),
      ),
    ).toBe(false);
  });

  it("visible, focused, looking elsewhere: THE toast fires — its one territory", () => {
    expect(
      shouldShowArrivalToast(
        input({
          channelId: "c1",
          selectedChannelId: "other-channel",
          documentVisible: true,
          windowFocused: true,
        }),
      ),
    ).toBe(true);
  });

  it("a group conversation toasts the same as a 1:1", () => {
    expect(shouldShowArrivalToast(input({ kind: "group" }))).toBe(true);
  });

  it("mentions-only level still toasts a DM (a DM has no mentions distinct from itself, but the level itself only blocks at 'none')", () => {
    expect(shouldShowArrivalToast(input({ level: "mentions" }))).toBe(true);
  });
});

describe("upsertToastCard — coalescing, position, cap", () => {
  it("a brand new conversation goes to the front", () => {
    const now = 1000;
    let cards: ToastCard[] = [];
    cards = upsertToastCard(cards, { channelId: "a", count: 1, mentions: 0 }, now);
    cards = upsertToastCard(cards, { channelId: "b", count: 1, mentions: 0 }, now);
    expect(cards.map((c) => c.channelId)).toEqual(["b", "a"]);
  });

  it("a second message from the same conversation updates the card in place — no position change", () => {
    const now = 1000;
    let cards: ToastCard[] = [];
    cards = upsertToastCard(cards, { channelId: "a", count: 1, mentions: 0 }, now);
    cards = upsertToastCard(cards, { channelId: "b", count: 1, mentions: 0 }, now);
    cards = upsertToastCard(cards, { channelId: "a", count: 2, mentions: 1 }, now + 100);

    expect(cards.map((c) => c.channelId)).toEqual(["b", "a"]);
    const a = cards.find((c) => c.channelId === "a")!;
    expect(a.count).toBe(3);
    expect(a.mentions).toBe(1);
    expect(a.expiresAt).toBe(now + 100 + TOAST_MS);
  });

  it("a fourth conversation pushes the oldest card out", () => {
    const now = 1000;
    let cards: ToastCard[] = [];
    cards = upsertToastCard(cards, { channelId: "a", count: 1, mentions: 0 }, now);
    cards = upsertToastCard(cards, { channelId: "b", count: 1, mentions: 0 }, now);
    cards = upsertToastCard(cards, { channelId: "c", count: 1, mentions: 0 }, now);
    expect(cards).toHaveLength(MAX_CARDS);
    cards = upsertToastCard(cards, { channelId: "d", count: 1, mentions: 0 }, now);
    expect(cards).toHaveLength(MAX_CARDS);
    expect(cards.map((c) => c.channelId)).toEqual(["d", "c", "b"]);
  });

  it("a coalesced message resets the full 6000ms", () => {
    const now = 1000;
    let cards: ToastCard[] = upsertToastCard(
      [],
      { channelId: "a", count: 1, mentions: 0 },
      now,
    );
    cards = upsertToastCard(cards, { channelId: "a", count: 1, mentions: 0 }, now + 5000);
    expect(cards[0]!.expiresAt).toBe(now + 5000 + TOAST_MS);
  });
});

describe("pause / resume", () => {
  it("pausing holds expiresAt as a remaining duration", () => {
    const now = 1000;
    let cards = upsertToastCard([], { channelId: "a", count: 1, mentions: 0 }, now);
    cards = pauseToastCard(cards, "a", now + 2000);
    expect(cards[0]!.pausedRemainingMs).toBe(TOAST_MS - 2000);
  });

  it("resuming re-arms with at least MIN_RESUME_MS even if almost expired", () => {
    const now = 1000;
    let cards = upsertToastCard([], { channelId: "a", count: 1, mentions: 0 }, now);
    cards = pauseToastCard(cards, "a", now + TOAST_MS - 100); // 100ms left
    cards = resumeToastCard(cards, "a", now + TOAST_MS - 50);
    expect(cards[0]!.expiresAt).toBe(now + TOAST_MS - 50 + MIN_RESUME_MS);
  });

  it("resuming with plenty of time left keeps the real remaining duration", () => {
    const now = 1000;
    let cards = upsertToastCard([], { channelId: "a", count: 1, mentions: 0 }, now);
    cards = pauseToastCard(cards, "a", now + 1000); // 5000ms left
    cards = resumeToastCard(cards, "a", now + 1500); // still paused, half a second later
    expect(cards[0]!.expiresAt).toBe(now + 1500 + 5000);
  });

  it("pausing an already-paused card is a no-op", () => {
    const now = 1000;
    let cards = upsertToastCard([], { channelId: "a", count: 1, mentions: 0 }, now);
    cards = pauseToastCard(cards, "a", now + 1000);
    const remaining = cards[0]!.pausedRemainingMs;
    cards = pauseToastCard(cards, "a", now + 3000);
    expect(cards[0]!.pausedRemainingMs).toBe(remaining);
  });

  it("a coalesced arrival onto a paused card stays paused, refilled to the full duration", () => {
    // The countdown must not sneak past a card the pointer is still on —
    // resuming later should still get the fresh 6000ms, not whatever was
    // left when the new message coalesced in.
    const now = 1000;
    let cards = upsertToastCard([], { channelId: "a", count: 1, mentions: 0 }, now);
    cards = pauseToastCard(cards, "a", now + 4000); // 2000ms left
    cards = upsertToastCard(cards, { channelId: "a", count: 1, mentions: 0 }, now + 4500);
    expect(cards[0]!.pausedRemainingMs).toBe(TOAST_MS);
    cards = resumeToastCard(cards, "a", now + 5000);
    expect(cards[0]!.expiresAt).toBe(now + 5000 + TOAST_MS);
  });

  it("a coalesced arrival onto an unpaused card stays unpaused", () => {
    const now = 1000;
    let cards = upsertToastCard([], { channelId: "a", count: 1, mentions: 0 }, now);
    cards = upsertToastCard(cards, { channelId: "a", count: 1, mentions: 0 }, now + 1000);
    expect(cards[0]!.pausedRemainingMs).toBeNull();
  });
});

describe("tab visibility", () => {
  it("hidden freezes every timer", () => {
    const now = 1000;
    let cards = upsertToastCard([], { channelId: "a", count: 1, mentions: 0 }, now);
    cards = upsertToastCard(cards, { channelId: "b", count: 1, mentions: 0 }, now);
    cards = freezeToastCards(cards, now + 1000);
    expect(cards.every((c) => c.pausedRemainingMs !== null)).toBe(true);
  });

  it("coming back re-arms each card with exactly VISIBILITY_RESUME_MS", () => {
    const now = 1000;
    let cards = upsertToastCard([], { channelId: "a", count: 1, mentions: 0 }, now);
    cards = freezeToastCards(cards, now + 500);
    // An hour passes in the background.
    const later = now + 3_600_000;
    cards = thawToastCards(cards, later);
    expect(cards[0]!.expiresAt).toBe(later + VISIBILITY_RESUME_MS);
    expect(cards[0]!.pausedRemainingMs).toBeNull();
  });
});

describe("leaving / removal", () => {
  it("marks a card leaving without removing it", () => {
    let cards = upsertToastCard([], { channelId: "a", count: 1, mentions: 0 }, 0);
    cards = markToastLeaving(cards, "a");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.leaving).toBe(true);
  });

  it("a message for a leaving card is treated as a fresh arrival, not a coalesce", () => {
    let cards = upsertToastCard([], { channelId: "a", count: 1, mentions: 0 }, 0);
    cards = markToastLeaving(cards, "a");
    cards = upsertToastCard(cards, { channelId: "a", count: 1, mentions: 0 }, 100);
    // Two entries for "a": the leaving one and the fresh one about to render in
    // its place. The component removes the leaving one on its exit-animation
    // timeout, same as today.
    expect(cards.filter((c) => c.channelId === "a")).toHaveLength(2);
  });

  it("removeToastCard drops it outright", () => {
    let cards = upsertToastCard([], { channelId: "a", count: 1, mentions: 0 }, 0);
    cards = removeToastCard(cards, "a");
    expect(cards).toHaveLength(0);
  });

  it("a token-scoped removal never deletes a different instance sharing the channel id", () => {
    // The exact race a removal timer can hit: dismiss "a" (marks it leaving,
    // schedules its removal), then a fresh message for "a" arrives before
    // that timer fires — two entries for the same channelId. The removal
    // must only ever take the one it was scheduled for.
    let cards = upsertToastCard([], { channelId: "a", count: 1, mentions: 0 }, 0);
    const staleToken = cards[0]!.token;
    cards = markToastLeaving(cards, "a", staleToken);
    cards = upsertToastCard(cards, { channelId: "a", count: 1, mentions: 0 }, 50);
    expect(cards).toHaveLength(2);

    cards = removeToastCard(cards, "a", staleToken);

    expect(cards).toHaveLength(1);
    expect(cards[0]!.leaving).toBe(false);
    expect(cards[0]!.token).not.toBe(staleToken);
  });

  it("an unscoped removal (no token) still removes by channelId, for callers that do not care", () => {
    let cards = upsertToastCard([], { channelId: "a", count: 1, mentions: 0 }, 0);
    cards = upsertToastCard(cards, { channelId: "b", count: 1, mentions: 0 }, 0);
    cards = removeToastCard(cards, "a");
    expect(cards.map((c) => c.channelId)).toEqual(["b"]);
  });

  it("markToastLeaving scoped to a token only marks that instance", () => {
    let cards = upsertToastCard([], { channelId: "a", count: 1, mentions: 0 }, 0);
    const firstToken = cards[0]!.token;
    cards = markToastLeaving(cards, "a", firstToken);
    cards = upsertToastCard(cards, { channelId: "a", count: 1, mentions: 0 }, 50);

    const leavingCount = cards.filter((c) => c.leaving).length;
    expect(leavingCount).toBe(1);
    expect(cards.find((c) => c.leaving)!.token).toBe(firstToken);
  });
});

describe("nextToastDeadline", () => {
  it("is null with nothing to wait on", () => {
    expect(nextToastDeadline([], 0)).toBeNull();
  });

  it("ignores paused and leaving cards", () => {
    let cards = upsertToastCard([], { channelId: "a", count: 1, mentions: 0 }, 0);
    cards = pauseToastCard(cards, "a", 100);
    expect(nextToastDeadline(cards, 100)).toBeNull();
  });

  it("returns the soonest remaining time among active cards", () => {
    // "a" expires at 6000 (TOAST_MS after t=0); "b" expires at 7000 (TOAST_MS
    // after t=1000). At now=1000, "a" has 5000ms left — the soonest.
    let cards = upsertToastCard([], { channelId: "a", count: 1, mentions: 0 }, 0);
    cards = upsertToastCard(cards, { channelId: "b", count: 1, mentions: 0 }, 1000);
    expect(nextToastDeadline(cards, 1000)).toBe(TOAST_MS - 1000);
  });
});
