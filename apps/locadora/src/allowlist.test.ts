import { describe, expect, it } from "vitest";
import { LOCADORA_ALLOWLIST } from "./allowlist";

/**
 * THE ALLOWLIST IS EMPTY, AND THIS TEST KEEPS IT THAT WAY.
 *
 * `allowlist.ts` is the only place a game could ever be named in Locadora, and it
 * may name one only after a human verified it is homebrew or public domain AND the
 * lawyer review in docs/EMULATOR_ROOM.md is done. An entry is a deliberate change
 * to this test too, in a pull request that says so; it cannot slip in with an
 * unrelated edit. (The same test guards the old menu entry's copy at
 * client/src/lib/emulator/emulator-allowlist.test.ts, for as long as it exists.)
 */
describe("the Locadora allowlist", () => {
  it("is empty: pqp provides, lists and names no game", () => {
    expect(LOCADORA_ALLOWLIST).toEqual([]);
    expect(LOCADORA_ALLOWLIST).toHaveLength(0);
  });
});
