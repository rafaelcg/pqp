import { beforeEach, describe, expect, it } from "vitest";
import {
  isUpdatePromptShowing,
  isUpdateWaiting,
  requestUpdatePrompt,
  resetUpdateState,
  setUpdatePromptShowing,
  setUpdateWaiting,
  shouldShowUpdateCard,
  updateRequestedAt,
} from "./update-prompt-state";

/**
 * The rule this file exists for: a person with a new build waiting must always
 * have a way to take it. Every branch below is a way the corner card can leave
 * the screen, and each one has to leave `waiting` true so the rail keeps
 * drawing the way back.
 */

const base = {
  waiting: true,
  snoozedAt: null as number | null,
  requestedAt: null as number | null,
  inCall: false,
};

describe("shouldShowUpdateCard", () => {
  it("says nothing when no build is waiting", () => {
    expect(shouldShowUpdateCard({ ...base, waiting: false })).toBe(false);
    // Not even when asked for: there is nothing to offer.
    expect(
      shouldShowUpdateCard({ ...base, waiting: false, requestedAt: 5 }),
    ).toBe(false);
  });

  it("shows a waiting build that has not been snoozed", () => {
    expect(shouldShowUpdateCard(base)).toBe(true);
  });

  it("stays quiet while snoozed", () => {
    expect(shouldShowUpdateCard({ ...base, snoozedAt: 1000 })).toBe(false);
  });

  it("stays quiet during a call, because a reload ends the call", () => {
    expect(shouldShowUpdateCard({ ...base, inCall: true })).toBe(false);
  });

  it("comes back when asked for, even mid-call", () => {
    // The rail button is the only thing that sets `requestedAt`, and somebody
    // pressed it. A card you went looking for is not an interruption.
    expect(
      shouldShowUpdateCard({ ...base, inCall: true, requestedAt: 10 }),
    ).toBe(true);
  });

  it("comes back when asked for after a snooze", () => {
    expect(
      shouldShowUpdateCard({ ...base, snoozedAt: 1000, requestedAt: 2000 }),
    ).toBe(true);
  });

  it("does not come back from a request that predates the snooze", () => {
    // Ask, read it, hit Later. The old request must not immediately re-open
    // the card the person just put away.
    expect(
      shouldShowUpdateCard({ ...base, requestedAt: 1000, snoozedAt: 2000 }),
    ).toBe(false);
  });
});

describe("the update store", () => {
  beforeEach(() => resetUpdateState());

  it("starts with nothing waiting and nothing showing", () => {
    expect(isUpdateWaiting()).toBe(false);
    expect(isUpdatePromptShowing()).toBe(false);
    expect(updateRequestedAt()).toBeNull();
  });

  it("keeps `waiting` true while the card is not showing", () => {
    // This is the whole point of splitting the two. The card can hide for any
    // reason; the rail must still know a build is there.
    setUpdateWaiting(true);
    setUpdatePromptShowing(false);
    expect(isUpdateWaiting()).toBe(true);
    expect(isUpdatePromptShowing()).toBe(false);
  });

  it("forgets a pending request once the build is taken", () => {
    setUpdateWaiting(true);
    requestUpdatePrompt(1000);
    expect(updateRequestedAt()).toBe(1000);
    setUpdateWaiting(false);
    expect(updateRequestedAt()).toBeNull();
  });
});
