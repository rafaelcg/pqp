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
  featureHintEligible,
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
  it("is exactly the audit's approved set", () => {
    expect([...HINT_DIET_IDS].sort()).toEqual(
      [
        "whatsNew",
        "cargos",
        "shortcuts",
        "voiceClean",
        "seasonalLook",
        "callDock",
        "watchParty",
        "music",
        "musicField",
        "composerFormat",
        "channelPin",
        "ownerInviteButton",
      ].sort(),
    );
  });

  it("never names the hints the audit said to keep", () => {
    for (const kept of [
      "qg",
      "listingNudge",
      "mobileBeta",
      "notifyOffer",
      "communityHomePost",
      "bringFriends",
      "watchNow",
      "watchPartyHost",
      "watchPartyViewer",
      "forum",
      "voiceNoteTranscription",
    ]) {
      expect(HINT_DIET_IDS as readonly string[], kept).not.toContain(kept);
    }
  });

  it("every id is something a queue or the empty state can actually ask about", () => {
    const known = new Set<string>([
      ...CORNER_HINT_ORDER,
      ...FEATURE_HINT_IDS,
      "ownerInviteButton",
    ]);
    for (const id of HINT_DIET_IDS) {
      expect(known.has(id), id).toBe(true);
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
    expect(winningCornerHint({ whatsNew: true, cargos: true })).toBe("whatsNew");
    expect(winningCornerHint({ cargos: true, shortcuts: true })).toBe("cargos");
    expect(winningCornerHint({ voiceClean: true, mobileBeta: true })).toBe(
      "voiceClean",
    );
  });

  it("the attached queue still follows its own order", () => {
    expect(winningFeatureHint(ALL_ATTACHED)).toBe("callDock");
    expect(winningFeatureHint({ music: true, channelPin: true })).toBe("music");
  });

  it("a coach mark is eligible and remembers its impression", () => {
    const storage = spyStorage();
    expect(isFeatureHintSeen("channelPin", storage, true)).toBe(false);
    rememberFeatureHint("channelPin", storage, true);
    expect(storage.writes).toEqual([FEATURE_HINT_STORAGE_KEYS.channelPin]);
    expect(isFeatureHintSeen("channelPin", storage, true)).toBe(true);
  });
});

describe("flag ON hides exactly the listed ids", () => {
  it("every listed corner id is skipped and the next card takes the slot", () => {
    setHintDiet(true);
    for (const id of HINT_DIET_IDS) {
      if (!(CORNER_HINT_ORDER as readonly string[]).includes(id)) {
        continue;
      }
      expect(winningCornerHint({ [id]: true }), id).toBeNull();
    }
    // The audit's sequence: What's new, cargos and shortcuts gone, the QG stays.
    expect(
      winningCornerHint({ whatsNew: true, cargos: true, shortcuts: true }),
    ).toBeNull();
    expect(
      winningCornerHint({ qg: true, whatsNew: true, cargos: true }),
    ).toBe("qg");
    expect(
      winningCornerHint({ whatsNew: true, mobileBeta: true, cargos: true }),
    ).toBe("mobileBeta");
  });

  it("every corner id not listed still wins exactly as before", () => {
    setHintDiet(true);
    for (const id of CORNER_HINT_ORDER) {
      if ((HINT_DIET_IDS as readonly string[]).includes(id)) {
        continue;
      }
      expect(winningCornerHint({ [id]: true }), id).toBe(id);
    }
  });

  it("every listed attached id is skipped, the rest still win", () => {
    setHintDiet(true);
    for (const id of ATTACHED_FEATURE_HINT_ORDER) {
      const hidden = (HINT_DIET_IDS as readonly string[]).includes(id);
      expect(winningFeatureHint({ [id]: true }), id).toBe(hidden ? null : id);
    }
    // callDock first in the order is gone, so what was behind it is now first.
    expect(winningFeatureHint(ALL_ATTACHED)).toBe("watchNow");
    expect(winningFeatureHint({ callDock: true, music: true })).toBeNull();
  });

  it("a hidden coach mark is never eligible, in any host", () => {
    setHintDiet(true);
    const storage = spyStorage();
    for (const id of FEATURE_HINT_IDS) {
      const hidden = (HINT_DIET_IDS as readonly string[]).includes(id);
      expect(isFeatureHintSeen(id as FeatureHintId, storage, true), id).toBe(
        hidden,
      );
      // Even where nothing persists (localhost), the diet still says seen.
      expect(isFeatureHintSeen(id as FeatureHintId, storage, false), id).toBe(
        hidden,
      );
    }
  });

  it("featureHintEligible follows the diet", () => {
    expect(featureHintEligible("composerFormat")).toBe(true);
    setHintDiet(true);
    expect(featureHintEligible("composerFormat")).toBe(false);
    expect(featureHintEligible("forum")).toBe(true);
  });

  it("a hidden hint writes NOTHING to storage, a kept one still does", () => {
    setHintDiet(true);
    const storage = spyStorage();
    for (const id of FEATURE_HINT_IDS) {
      rememberFeatureHint(id as FeatureHintId, storage, true);
    }
    const written = new Set(storage.writes);
    for (const id of FEATURE_HINT_IDS) {
      const hidden = (HINT_DIET_IDS as readonly string[]).includes(id);
      expect(
        written.has(FEATURE_HINT_STORAGE_KEYS[id as FeatureHintId]),
        id,
      ).toBe(!hidden);
    }
  });

  it("turning the flag OFF again restores every card, even after the control was used", () => {
    const storage = spyStorage();
    setHintDiet(true);
    // The person uses the format bar while the diet is on.
    rememberFeatureHint("composerFormat", storage, true);
    expect(storage.writes).toEqual([]);
    setHintDiet(false);
    expect(isFeatureHintSeen("composerFormat", storage, true)).toBe(false);
    expect(winningFeatureHint({ composerFormat: true })).toBe("composerFormat");
    expect(winningCornerHint({ whatsNew: true })).toBe("whatsNew");
  });
});
