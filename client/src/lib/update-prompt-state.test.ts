import { beforeEach, describe, expect, it } from "vitest";
import {
  FRESH_BUILD,
  getBuildStaleness,
  isUpdateOffered,
  isUpdateWaiting,
  resetUpdateState,
  setBuildStaleness,
  setUpdateWaiting,
  type BuildStaleness,
} from "./update-prompt-state";

/**
 * The rule this file exists for: a person with a new build to take must always
 * be able to find the button, and a build that has not been announced yet must
 * not draw one (the daily cadence, `lib/client-version.ts`).
 */

const STALE: BuildStaleness = {
  stale: true,
  forced: false,
  latestBuild: "b2",
  since: 1_000,
};

beforeEach(() => resetUpdateState());

describe("isUpdateOffered", () => {
  it("offers nothing when the page is current and no worker is waiting", () => {
    expect(isUpdateOffered({ build: FRESH_BUILD, waiting: false }, 5)).toBe(false);
  });

  it("offers a stale build that is announced, or was never held back", () => {
    expect(isUpdateOffered({ build: STALE, waiting: false }, 5)).toBe(true);
    expect(
      isUpdateOffered({ build: { ...STALE, announceAt: 100 }, waiting: false }, 100),
    ).toBe(true);
  });

  it("offers nothing while the build is held back for the daily announcement", () => {
    expect(
      isUpdateOffered({ build: { ...STALE, announceAt: 100 }, waiting: false }, 99),
    ).toBe(false);
  });

  it("does not let a waiting worker undo the hold: it would only be the same notice a minute earlier", () => {
    expect(
      isUpdateOffered({ build: { ...STALE, announceAt: 100 }, waiting: true }, 99),
    ).toBe(false);
  });

  it("offers a waiting worker for a page the version poll has not spoken about", () => {
    expect(isUpdateOffered({ build: FRESH_BUILD, waiting: true }, 5)).toBe(true);
  });
});

describe("the store", () => {
  it("remembers a waiting worker and forgets it", () => {
    setUpdateWaiting(true);
    expect(isUpdateWaiting()).toBe(true);
    setUpdateWaiting(false);
    expect(isUpdateWaiting()).toBe(false);
  });

  it("publishes a new object only when something moved", () => {
    setBuildStaleness(STALE);
    const first = getBuildStaleness();
    setBuildStaleness({ ...STALE });
    expect(getBuildStaleness()).toBe(first);
    // `critical` and `announceAt` count: a force that arrives later, or a
    // different morning, must reach whoever is drawing the indicator.
    setBuildStaleness({ ...STALE, critical: true });
    expect(getBuildStaleness()).not.toBe(first);
    const second = getBuildStaleness();
    setBuildStaleness({ ...STALE, critical: true, announceAt: 500 });
    expect(getBuildStaleness()).not.toBe(second);
  });
});
