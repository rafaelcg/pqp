import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { STRINGS } from "./i18n";
import {
  ALL_STEPS,
  createWalkthrough,
  hasSeenOnboarding,
  markOnboardingSeen,
  nextTabIndex,
  resetOnboardingSession,
  SEEN_KEY,
  shouldShowOnboarding,
} from "./onboarding";
import { KEY_PATTERN, memoryStore, StoreError, type DeviceStore } from "./store";

beforeEach(() => resetOnboardingSession());

describe("the seen flag", () => {
  it("uses a key the store accepts", () => {
    expect(KEY_PATTERN.test(SEEN_KEY)).toBe(true);
    expect(SEEN_KEY).toBe("seen:onboarding");
  });

  it("is shown on a fresh device, then never again once marked, even in a later session", async () => {
    const store = memoryStore();
    expect(await shouldShowOnboarding(store)).toBe(true);
    await markOnboardingSeen(store, () => 1234);
    expect((await store.get(SEEN_KEY))?.meta).toEqual({ at: 1234 });
    // a later visit: the session flag is gone, the store remembers
    resetOnboardingSession();
    expect(await hasSeenOnboarding(store)).toBe(true);
    expect(await shouldShowOnboarding(store)).toBe(false);
  });

  it("without a store is once per session", async () => {
    expect(await shouldShowOnboarding(undefined)).toBe(true);
    await markOnboardingSeen(undefined);
    expect(await shouldShowOnboarding(undefined)).toBe(false);
    resetOnboardingSession();
    expect(await shouldShowOnboarding(undefined)).toBe(true);
  });

  it("falls back to the session when the store refuses or fails", async () => {
    const broken: DeviceStore = {
      ...memoryStore(),
      get: async () => {
        throw new Error("bridge gone");
      },
      put: async () => {
        throw new StoreError("too-large", "full");
      },
    };
    expect(await shouldShowOnboarding(broken)).toBe(true);
    await expect(markOnboardingSeen(broken)).resolves.toBeUndefined();
    expect(await shouldShowOnboarding(broken)).toBe(false);
  });

  it("is per store: a second device starts unseen", async () => {
    await markOnboardingSeen(memoryStore());
    resetOnboardingSession();
    expect(await shouldShowOnboarding(memoryStore())).toBe(true);
  });
});

describe("the walkthrough", () => {
  it("walks the two screens forward and back, and stops at the ends", () => {
    const seen: number[] = [];
    const w = createWalkthrough(ALL_STEPS, (step) => seen.push(step));
    expect(ALL_STEPS).toEqual([1, 2]);
    expect([w.step, w.isFirst, w.isLast]).toEqual([1, true, false]);
    expect(w.back()).toBe(false);
    expect(w.next()).toBe(true);
    expect([w.step, w.index, w.isLast]).toEqual([2, 1, true]);
    expect(w.next()).toBe(false);
    expect(w.back()).toBe(true);
    expect(w.step).toBe(1);
    expect(seen).toEqual([2, 1]);
  });

  it("can be the controller map alone, reopened from Controles", () => {
    const w = createWalkthrough([3]);
    expect([w.step, w.isFirst, w.isLast]).toEqual([3, true, true]);
    expect(w.next()).toBe(false);
    expect(w.back()).toBe(false);
    expect(() => createWalkthrough([])).toThrow();
  });
});

describe("the Tab wrap that keeps a keyboard inside the panel", () => {
  it("wraps at both ends and enters from outside", () => {
    expect(nextTabIndex(2, 3, false)).toBe(0);
    expect(nextTabIndex(0, 3, true)).toBe(2);
    expect(nextTabIndex(1, 3, false)).toBe(2);
    expect(nextTabIndex(1, 3, true)).toBe(0);
    expect(nextTabIndex(-1, 3, false)).toBe(0);
    expect(nextTabIndex(-1, 3, true)).toBe(2);
    expect(nextTabIndex(0, 0, false)).toBe(-1);
  });
});

describe("the onboarding copy", () => {
  it("has the words of every step in all three languages", () => {
    const keys = [
      "onb.1.sub",
      "onb.2.title",
      "onb.2.sub",
      "onb.3.sub",
      "onb.4.title",
      "onb.4.body",
      "onb.once",
      "onb.step",
      "onb.reset",
      "remap.swap",
      "remap.keep",
      "pad.change",
      "pad.button",
    ] as const;
    for (const locale of ["pt-BR", "en", "es"] as const) {
      for (const key of keys) expect(STRINGS[locale][key].length, `${locale}.${key}`).toBeGreaterThan(0);
    }
    expect(STRINGS["pt-BR"]["onb.step"]).toContain("{n}");
    expect(STRINGS.en["onb.step"]).toContain("{total}");
  });
});

describe("the stylesheet", () => {
  const css = readFileSync(new URL("./styles/onboarding.css", import.meta.url), "utf8");
  const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"), css.indexOf(':root[data-reduced-motion="true"]'));

  it("removes the flicker, the panel rise and the ring pulse under both reduced-motion switches", () => {
    for (const selector of [".loc-onb-neon", ".loc-onb-panel", ".loc-pad-ring"]) {
      expect(reduced.includes(selector), `media ${selector}`).toBe(true);
      expect(css.includes(`:root[data-reduced-motion="true"] ${selector}`), `attr ${selector}`).toBe(true);
    }
    expect(reduced).toContain("animation: none");
  });

  it("keeps the listening ring on screen, still, when motion is off", () => {
    expect(reduced).toMatch(/\.loc-pad-ring \{\s*opacity: 0\.9;/);
  });

  it("flickers at most twice (WCAG 2.3.1), once, in 1.2 s", () => {
    const frames = css.match(/@keyframes loc-onb-flick \{([\s\S]*?)\n\}\n/)?.[1] ?? "";
    expect((frames.match(/opacity: 0\.(25|5)/g) ?? []).length).toBeLessThanOrEqual(2);
    expect(css).toContain("animation: loc-onb-flick 1.2s steps(1) 1 backwards");
  });

  it("has no em dash", () => {
    expect(css.includes(String.fromCharCode(0x2014))).toBe(false);
  });
});
