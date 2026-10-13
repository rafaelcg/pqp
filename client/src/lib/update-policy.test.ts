import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_STALE_MS,
  IDLE_RELOAD_MS,
  LEFT_CALL_RELOAD_MS,
  autoReloadAllowed,
  decideUpdateAction,
  forgetAutoReload,
  isBlockingUpdate,
  maxStaleMsFromEnv,
  recordAutoReload,
  type UpdatePolicyInput,
} from "./update-policy";

const base: UpdatePolicyInput = {
  stale: true,
  staleForMs: 60_000,
  idleMs: 0,
  inCall: false,
  watching: false,
  typing: false,
  autoReloadAllowed: true,
};

function decide(over: Partial<UpdatePolicyInput>) {
  return decideUpdateAction({ ...base, ...over });
}

describe("decideUpdateAction", () => {
  it("does nothing when up to date", () => {
    expect(decide({ stale: false, idleMs: 9e9 })).toBe("none");
  });

  it("shows the indicator, and only the indicator, to somebody who is active", () => {
    expect(decide({})).toBe("indicator");
  });

  it("reloads on its own once the page has been idle long enough", () => {
    expect(decide({ idleMs: IDLE_RELOAD_MS - 1 })).toBe("indicator");
    expect(decide({ idleMs: IDLE_RELOAD_MS })).toBe("auto-reload");
  });

  it("reloads without asking past the long-stale limit, active or not", () => {
    expect(decide({ staleForMs: DEFAULT_MAX_STALE_MS - 1 })).toBe("indicator");
    expect(decide({ staleForMs: DEFAULT_MAX_STALE_MS })).toBe("auto-reload");
  });

  it("honours a custom long-stale limit, and 0 turns that rule off", () => {
    expect(decide({ staleForMs: 3_600_000, maxStaleMs: 3_600_000 })).toBe("auto-reload");
    expect(decide({ staleForMs: 9e12, maxStaleMs: 0 })).toBe("indicator");
  });

  describe("a build that has not been announced yet", () => {
    it("does nothing at all: no indicator, no reload, however idle or hidden", () => {
      for (const over of [
        {},
        { idleMs: 9e9 },
        { staleForMs: 9e12 },
        { hidden: true },
        { sinceCallEndedMs: 0 },
      ]) {
        expect(decide({ announced: false, ...over })).toBe("none");
      }
    });

    it("is acted on the moment it is announced", () => {
      expect(decide({ announced: true, hidden: true })).toBe("auto-reload");
      // Absent means announced, for a caller that holds nothing back.
      expect(decide({ hidden: true })).toBe("auto-reload");
    });
  });

  describe("never reloads on its own", () => {
    it("in a call: not idle, not stale for days, not hidden, not just hung up", () => {
      for (const over of [
        { idleMs: 9e9 },
        { staleForMs: 9e12 },
        { hidden: true },
        { idleMs: 9e9, staleForMs: 9e12, hidden: true, sinceCallEndedMs: 0 },
      ]) {
        expect(decide({ inCall: true, ...over })).toBe("indicator");
      }
    });

    it("while somebody is typing, even when idle by the clock or stale past the limit", () => {
      expect(decide({ typing: true, idleMs: 9e9 })).toBe("indicator");
      expect(decide({ typing: true, staleForMs: 9e12 })).toBe("indicator");
    });

    it("while somebody watches a live party", () => {
      expect(decide({ watching: true, idleMs: 9e9 })).toBe("indicator");
      expect(decide({ watching: true, staleForMs: 9e12 })).toBe("indicator");
      expect(decide({ watching: true, hidden: true })).toBe("indicator");
    });

    it("twice for the same build", () => {
      expect(decide({ autoReloadAllowed: false, idleMs: 9e9 })).toBe("indicator");
      expect(decide({ autoReloadAllowed: false, staleForMs: 9e12 })).toBe("indicator");
      expect(decide({ autoReloadAllowed: false, hidden: true })).toBe("indicator");
    });

    it("and never turns into a blocking screen, whatever the person is doing", () => {
      for (const over of [
        {},
        { typing: true },
        { watching: true },
        { inCall: true },
        { autoReloadAllowed: false },
      ]) {
        expect(decide(over)).not.toBe("block");
      }
    });
  });
});

describe("safe moments", () => {
  it("reloads a hidden tab at once, unless it is watching a party or in a call", () => {
    expect(decide({ hidden: true })).toBe("auto-reload");
    expect(decide({ hidden: true, typing: true })).toBe("auto-reload");
    expect(decide({ hidden: true, watching: true })).toBe("indicator");
    expect(decide({ hidden: true, inCall: true })).toBe("indicator");
    expect(decide({ hidden: true, autoReloadAllowed: false })).toBe("indicator");
  });

  it("reloads right after a hangup, unless somebody is typing", () => {
    expect(decide({ sinceCallEndedMs: 0 })).toBe("auto-reload");
    expect(decide({ sinceCallEndedMs: LEFT_CALL_RELOAD_MS - 1 })).toBe("auto-reload");
    expect(decide({ sinceCallEndedMs: LEFT_CALL_RELOAD_MS })).toBe("indicator");
    expect(decide({ sinceCallEndedMs: 0, typing: true })).toBe("indicator");
    expect(decide({ sinceCallEndedMs: null })).toBe("indicator");
  });
});

describe("critical", () => {
  it("is the one thing that reloads in a call, while typing or watching", () => {
    expect(decide({ critical: true, inCall: true })).toBe("auto-reload");
    expect(decide({ critical: true, typing: true, watching: true })).toBe("auto-reload");
  });

  it("falls back to the blocking screen when a reload for this build did not land", () => {
    expect(decide({ critical: true, inCall: true, autoReloadAllowed: false })).toBe("block");
  });

  it("still waits for the daily announcement unless the operator made it urgent", () => {
    // `critical` is only ever published together with an announcement of NOW
    // (`createVersionWatch`), so a held-back build is never a critical one.
    expect(decide({ critical: true, announced: false })).toBe("none");
  });
});

describe("isBlockingUpdate", () => {
  it("is for a CRITICAL update and nothing else, in a call too", () => {
    expect(isBlockingUpdate({ stale: true, critical: true })).toBe(true);
    expect(isBlockingUpdate({ stale: false, critical: true })).toBe(false);
  });

  it("is not what the force switch does any more", () => {
    // `client_force_update` alone is `forced` with no `critical`: it announces
    // at once and draws the indicator louder, and blocks nobody.
    expect(isBlockingUpdate({ stale: true })).toBe(false);
    expect(isBlockingUpdate({ stale: true, critical: false })).toBe(false);
  });
});

describe("maxStaleMsFromEnv", () => {
  it("defaults to twelve hours", () => {
    expect(maxStaleMsFromEnv(undefined)).toBe(12 * 3_600_000);
    expect(maxStaleMsFromEnv("")).toBe(12 * 3_600_000);
    expect(maxStaleMsFromEnv("soon")).toBe(12 * 3_600_000);
    expect(maxStaleMsFromEnv("-3")).toBe(12 * 3_600_000);
  });

  it("reads hours, fractions included, and 0 as off", () => {
    expect(maxStaleMsFromEnv("6")).toBe(6 * 3_600_000);
    expect(maxStaleMsFromEnv("0.5")).toBe(1_800_000);
    expect(maxStaleMsFromEnv("0")).toBe(0);
  });
});

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

describe("the auto-reload loop guard", () => {
  it("allows the first reload toward a build", () => {
    expect(autoReloadAllowed("b2", memoryStorage())).toBe(true);
  });

  it("allows ONE reload per build, ever: never a second, however long it has been", () => {
    const storage = memoryStorage();
    expect(recordAutoReload("b2", 1_000, storage)).toBe(true);
    expect(autoReloadAllowed("b2", storage)).toBe(false);
    // There is no clock in the question any more: a page that keeps landing on
    // the build it was on would otherwise reload itself every quarter of an hour.
    expect(autoReloadAllowed("b2", storage)).toBe(false);
  });

  it("does not hold a newer build back for the last one's reload", () => {
    const storage = memoryStorage();
    recordAutoReload("b2", 1_000, storage);
    expect(autoReloadAllowed("b3", storage)).toBe(true);
  });

  it("gives the reload back when it was refused at the last moment", () => {
    const storage = memoryStorage();
    recordAutoReload("b2", 1_000, storage);
    forgetAutoReload("b2", storage);
    expect(autoReloadAllowed("b2", storage)).toBe(true);
    // Only its own build's record is taken back.
    recordAutoReload("b3", 2_000, storage);
    forgetAutoReload("b2", storage);
    expect(autoReloadAllowed("b3", storage)).toBe(false);
  });

  it("refuses to reload when it cannot remember having done so", () => {
    expect(autoReloadAllowed("b2", null)).toBe(false);
    expect(recordAutoReload("b2", 1_000, null)).toBe(false);
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(autoReloadAllowed("b2", broken)).toBe(false);
    expect(recordAutoReload("b2", 1_000, broken)).toBe(false);
  });
});
