// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

// `startHintConfig` asks the real fetcher; here it never answers, so the only
// answers in a test are the ones the test hands `loadHintConfig` itself.
vi.mock("@/lib/api", () => ({ apiFetch: () => new Promise(() => {}) }));
import {
  CORNER_HINT_ORDER,
  winningCornerHint,
  type CornerHintId,
} from "./corner-hints";
import {
  ATTACHED_FEATURE_HINT_ORDER,
  FEATURE_HINT_IDS,
  FEATURE_HINT_STORAGE_KEYS,
  isFeatureHintSeen,
  rememberFeatureHint,
  resetFeatureHintsForTests,
  winningFeatureHint,
  type AttachedFeatureHintId,
  type FeatureHintId,
} from "./feature-hints";
import {
  HINT_DIET_IDS,
  hintDietFromConfig,
  hintDietHides,
  isHintDietOn,
  resetHintDietForTests,
  setHintDiet,
} from "./hint-diet";
import {
  isHintConfigSettled,
  loadHintConfig,
  resetHintConfigForTests,
  startHintConfig,
} from "./hint-config";
import { isHintBudgetOn, resetHintQuietForTests } from "./hint-quiet";

/*
 * THE DIET: one list of ids, checked where the queues read.
 *
 * The properties that matter, each pinned below: flag ON hides exactly the
 * listed ids and nothing else; flag OFF changes nothing at all; a hidden hint
 * writes no storage, so turning the flag off restores every card.
 */

afterEach(() => {
  resetHintDietForTests();
  resetHintQuietForTests();
  resetHintConfigForTests();
  resetFeatureHintsForTests();
});

/** A storage that remembers every write, so "nothing was stored" is checkable. */
function spyStorage(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed));
  const writes: string[] = [];
  return {
    writes,
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      writes.push(key);
      data.set(key, value);
    },
  };
}

const ALL_CORNER: Partial<Record<CornerHintId, boolean>> = Object.fromEntries(
  CORNER_HINT_ORDER.map((id) => [id, true]),
);
const ALL_ATTACHED: Partial<Record<AttachedFeatureHintId, boolean>> =
  Object.fromEntries(ATTACHED_FEATURE_HINT_ORDER.map((id) => [id, true]));

describe("the id list", () => {
  it("is only the owner's invite button", () => {
    // Every corner card and coach mark the diet used to hide was removed
    // outright on 2026-11-01. The flag and the queue checks stay.
    expect([...HINT_DIET_IDS]).toEqual(["ownerInviteButton"]);
  });

  it("never names a hint that is still in a queue", () => {
    for (const kept of [
      "listingNudge",
      "notifyOffer",
      "communityHomePost",
      "watchPartyHost",
      "watchPartyViewer",
      "voiceNoteTranscription",
    ]) {
      expect(HINT_DIET_IDS as readonly string[], kept).not.toContain(kept);
    }
  });
});

describe("the flag read", () => {
  it("is on only for an explicit true", () => {
    expect(hintDietFromConfig({ hintDiet: true })).toBe(true);
    for (const value of [false, undefined, null, "true", 1, {}]) {
      expect(hintDietFromConfig({ hintDiet: value }), String(value)).toBe(false);
    }
    expect(hintDietFromConfig({})).toBe(false);
  });

  it("loadHintConfig applies both switches, and a failed ask keeps the last answer", async () => {
    await loadHintConfig(async () => ({ hintDiet: true, hintBudget: true }));
    expect(isHintDietOn()).toBe(true);
    expect(isHintBudgetOn()).toBe(true);
    await loadHintConfig(async () => {
      throw new Error("offline");
    });
    expect(isHintDietOn()).toBe(true);
    expect(isHintBudgetOn()).toBe(true);
    await loadHintConfig(async () => ({ hintDiet: false }));
    expect(isHintDietOn()).toBe(false);
    expect(isHintBudgetOn()).toBe(false);
  });

  it("an older API that sends neither field is off", async () => {
    await loadHintConfig(async () => ({}));
    expect(isHintDietOn()).toBe(false);
    expect(isHintBudgetOn()).toBe(false);
  });

  it("a request that outlives its lifecycle neither applies nor releases the queues", async () => {
    let release!: (value: { hintDiet: boolean }) => void;
    const stop1 = startHintConfig();
    // The first lifecycle's own request is the real fetcher; start a pending one by hand.
    const pending = loadHintConfig(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    stop1(); // the account signed out
    const stop2 = startHintConfig(); // and another signed in; its answer has not come
    expect(isHintConfigSettled()).toBe(false);
    release({ hintDiet: true });
    await pending;
    expect(isHintDietOn()).toBe(false);
    expect(isHintConfigSettled()).toBe(false);
    stop2();
  });

  it("a slow stale answer cannot undo a newer one", async () => {
    let releaseSlow!: (value: { hintDiet: boolean }) => void;
    const slow = loadHintConfig(
      () =>
        new Promise((resolve) => {
          releaseSlow = resolve;
        }),
    );
    await loadHintConfig(async () => ({ hintDiet: false }));
    releaseSlow({ hintDiet: true });
    await slow;
    expect(isHintDietOn()).toBe(false);
  });
});

describe("flag OFF changes nothing", () => {
  it("hides no id", () => {
    for (const id of HINT_DIET_IDS) {
      expect(hintDietHides(id), id).toBe(false);
    }
  });

  it("the corner queue still follows its own order", () => {
    expect(winningCornerHint(ALL_CORNER)).toBe("communityHomePost");
    expect(winningCornerHint({ notifyOffer: true, listingNudge: true })).toBe(
      "notifyOffer",
    );
  });

  it("the attached queue still follows its own order", () => {
    expect(winningFeatureHint(ALL_ATTACHED)).toBe("watchPartyHost");
    expect(winningFeatureHint({ watchPartyViewer: true })).toBe(
      "watchPartyViewer",
    );
  });

  it("a coach mark is eligible and remembers its impression", () => {
    const storage = spyStorage();
    expect(isFeatureHintSeen("watchPartyViewer", storage, true)).toBe(false);
    rememberFeatureHint("watchPartyViewer", storage, true);
    expect(storage.writes).toEqual([FEATURE_HINT_STORAGE_KEYS.watchPartyViewer]);
    expect(isFeatureHintSeen("watchPartyViewer", storage, true)).toBe(true);
  });
});

describe("flag ON hides exactly the listed ids", () => {
  it("hides the owner's invite button and nothing else", () => {
    setHintDiet(true);
    expect(hintDietHides("ownerInviteButton")).toBe(true);
    for (const id of [...CORNER_HINT_ORDER, ...FEATURE_HINT_IDS]) {
      expect(hintDietHides(id), id).toBe(false);
    }
  });

  it("every corner id still wins exactly as before", () => {
    setHintDiet(true);
    for (const id of CORNER_HINT_ORDER) {
      expect(winningCornerHint({ [id]: true }), id).toBe(id);
    }
    expect(winningCornerHint(ALL_CORNER)).toBe("communityHomePost");
  });

  it("every attached id still wins exactly as before", () => {
    setHintDiet(true);
    for (const id of ATTACHED_FEATURE_HINT_ORDER) {
      expect(winningFeatureHint({ [id]: true }), id).toBe(id);
    }
    expect(winningFeatureHint(ALL_ATTACHED)).toBe("watchPartyHost");
  });

  it("no coach mark is hidden, and each still writes its impression", () => {
    setHintDiet(true);
    const storage = spyStorage();
    for (const id of FEATURE_HINT_IDS) {
      expect(isFeatureHintSeen(id as FeatureHintId, storage, true), id).toBe(
        false,
      );
      rememberFeatureHint(id as FeatureHintId, storage, true);
    }
    expect(new Set(storage.writes)).toEqual(
      new Set(FEATURE_HINT_IDS.map((id) => FEATURE_HINT_STORAGE_KEYS[id])),
    );
  });

  it("turning the flag OFF again changes nothing for the kept hints", () => {
    const storage = spyStorage();
    setHintDiet(true);
    rememberFeatureHint("watchPartyViewer", storage, true);
    setHintDiet(false);
    expect(isFeatureHintSeen("watchPartyViewer", storage, true)).toBe(true);
    expect(winningFeatureHint({ watchPartyHost: true })).toBe("watchPartyHost");
  });
});
