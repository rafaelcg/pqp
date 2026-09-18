import { describe, expect, it } from "vitest";
import { STAGE_LAYER, callControlsLayer } from "./stage-layers";

/** `z-40` / `z-[60]` as a number, for comparing two rungs. */
function rung(token: string): number {
  const match = /^z-(?:\[)?(\d+)(?:\])?$/.exec(token);
  expect(match, `unexpected rung token: ${token}`).not.toBeNull();
  return Number(match![1]);
}

describe("callControlsLayer", () => {
  /**
   * 2026-09-18, 20:57 UTC. The party bar and `CallStage`'s control bar are
   * both `absolute inset-x-0 bottom-0` in the same stacking context, and the
   * call bar is later in `App.tsx`'s document order. At the same rung it wins
   * every hit test, and its right-hand control is the red hang-up: a host
   * aiming at the party's own controls left the room mid-broadcast, twice.
   */
  it("keeps the call stage's bar below the party bar on a watch party channel", () => {
    expect(rung(callControlsLayer(true))).toBeLessThan(
      rung(STAGE_LAYER.chrome),
    );
  });

  it("leaves an ordinary call's bar on the chrome rung", () => {
    expect(callControlsLayer(false)).toBe(STAGE_LAYER.chrome);
  });
});
