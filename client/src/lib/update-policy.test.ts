import { describe, expect, it } from "vitest";
import {
  AUTO_RELOAD_COOLDOWN_MS,
  DEFAULT_MAX_STALE_MS,
  IDLE_RELOAD_MS,
  autoReloadAllowed,
  decideUpdateAction,
  isBlockingUpdate,
  maxStaleMsFromEnv,
  recordAutoReload,
  type UpdatePolicyInput,
} from "./update-policy";

const base: UpdatePolicyInput = {
  stale: true,
  forced: false,
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
    expect(decide({ stale: false, forced: true, idleMs: 9e9 })).toBe("none");
  });

  it("shows the card, and only the card, to somebody who is active", () => {
    expect(decide({})).toBe("banner");
  });

  it("reloads on its own once the page has been idle long enough", () => {
    expect(decide({ idleMs: IDLE_RELOAD_MS - 1 })).toBe("banner");
    expect(decide({ idleMs: IDLE_RELOAD_MS })).toBe("auto-reload");
  });

  it("reloads without asking past the long-stale limit, active or not", () => {
    expect(decide({ staleForMs: DEFAULT_MAX_STALE_MS - 1 })).toBe("banner");
    expect(decide({ staleForMs: DEFAULT_MAX_STALE_MS })).toBe("auto-reload");
  });

  it("honours a custom long-stale limit, and 0 turns that rule off", () => {
    expect(decide({ staleForMs: 3_600_000, maxStaleMs: 3_600_000 })).toBe("auto-reload");
    expect(decide({ staleForMs: 9e12, maxStaleMs: 0 })).toBe("banner");
  });

  describe("never interrupts", () => {
    it("a call: not idle, not stale for days, not even forced", () => {
      for (const over of [
        { idleMs: 9e9 },
        { staleForMs: 9e12 },
        { forced: true },
        { forced: true, idleMs: 9e9, staleForMs: 9e12 },
      ]) {
        expect(decide({ inCall: true, ...over })).toBe("banner");
      }
    });

    it("somebody typing, even when idle by the clock or stale past the limit", () => {
      expect(decide({ typing: true, idleMs: 9e9 })).toBe("banner");
      expect(decide({ typing: true, staleForMs: 9e12 })).toBe("banner");
    });

    it("somebody watching a live party", () => {
      expect(decide({ watching: true, idleMs: 9e9 })).toBe("banner");
      expect(decide({ watching: true, staleForMs: 9e12 })).toBe("banner");
    });
  });

  it("does not reload twice in a row for the same build", () => {
    expect(decide({ autoReloadAllowed: false, idleMs: 9e9 })).toBe("banner");
    expect(decide({ autoReloadAllowed: false, staleForMs: 9e12 })).toBe("banner");
  });

  describe("forced", () => {
    it("blocks, whatever the person is doing except being in a call", () => {
      expect(decide({ forced: true })).toBe("block");
      expect(decide({ forced: true, typing: true })).toBe("block");
      expect(decide({ forced: true, watching: true })).toBe("block");
    });

    it("is not held back by the auto-reload loop guard: the person must press the button", () => {
      expect(decide({ forced: true, autoReloadAllowed: false })).toBe("block");
    });

    it("blocks once the call ends", () => {
      expect(decide({ forced: true, inCall: true })).toBe("banner");
      expect(decide({ forced: true, inCall: false })).toBe("block");
    });
  });
});

describe("isBlockingUpdate", () => {
  it("is the same rule the policy uses for the forced screen", () => {
    expect(isBlockingUpdate({ stale: true, forced: true }, false)).toBe(true);
    expect(isBlockingUpdate({ stale: true, forced: true }, true)).toBe(false);
    expect(isBlockingUpdate({ stale: true, forced: false }, false)).toBe(false);
    expect(isBlockingUpdate({ stale: false, forced: true }, false)).toBe(false);
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
    expect(autoReloadAllowed("b2", 1_000, memoryStorage())).toBe(true);
  });

  it("refuses a second one for the same build inside the cooldown, then allows it", () => {
    const storage = memoryStorage();
    expect(recordAutoReload("b2", 1_000, storage)).toBe(true);
    expect(autoReloadAllowed("b2", 1_000 + AUTO_RELOAD_COOLDOWN_MS - 1, storage)).toBe(false);
    expect(autoReloadAllowed("b2", 1_000 + AUTO_RELOAD_COOLDOWN_MS, storage)).toBe(true);
  });

  it("does not hold a newer build back for the last one's cooldown", () => {
    const storage = memoryStorage();
    recordAutoReload("b2", 1_000, storage);
    expect(autoReloadAllowed("b3", 2_000, storage)).toBe(true);
  });

  it("refuses to reload when it cannot remember having done so", () => {
    expect(autoReloadAllowed("b2", 1_000, null)).toBe(false);
    expect(recordAutoReload("b2", 1_000, null)).toBe(false);
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(autoReloadAllowed("b2", 1_000, broken)).toBe(false);
    expect(recordAutoReload("b2", 1_000, broken)).toBe(false);
  });
});
