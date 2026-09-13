import { describe, expect, it } from "vitest";
import { isSeatedOnAnotherDevice } from "./dual-device-watch";

/**
 * C4 (`docs/plans/WATCH_PARTY_POSTMORTEM_2026-09-12.md`): "to fora da call e
 * só na watch pq tava duplicado". Watching a channel's HLS stream while the
 * same account also holds a seat in its call, from a different device or a
 * second tab, echoes: live through the seat, ~25s behind through the stream.
 */
describe("isSeatedOnAnotherDevice", () => {
  it("is false with no roster at all", () => {
    expect(isSeatedOnAnotherDevice(undefined, "user-1", false)).toBe(false);
    expect(isSeatedOnAnotherDevice([], "user-1", false)).toBe(false);
  });

  it("is false when nobody signed in yet", () => {
    expect(
      isSeatedOnAnotherDevice([{ userId: "user-1" }], null, false),
    ).toBe(false);
  });

  it("is false when the seat belongs to someone else", () => {
    expect(
      isSeatedOnAnotherDevice([{ userId: "user-2" }], "user-1", false),
    ).toBe(false);
  });

  it("is true when this account holds a seat this device is not in", () => {
    expect(
      isSeatedOnAnotherDevice(
        [{ userId: "user-2" }, { userId: "user-1" }],
        "user-1",
        false,
      ),
    ).toBe(true);
  });

  // A second tab, same account, same browser: a distinct WS connection with
  // its own `voiceState`, so from THIS tab's point of view it is exactly the
  // "another device" case — the roster carries the same userId twice under
  // two different peerIds, and this function never looks at peerId at all.
  it("is true for a second tab on the same account", () => {
    expect(
      isSeatedOnAnotherDevice(
        [{ userId: "user-1" }, { userId: "user-1" }],
        "user-1",
        false,
      ),
    ).toBe(true);
  });

  // The escape hatch: a device that is ITSELF the seat must never warn about
  // itself. `WatchStage` already hides the stream entirely in this case
  // (`inThisCall`), but the detector is asserted here too so nothing upstream
  // of that gate can turn this into a false "you are duplicated" for the
  // seated device's own watch surface.
  it("is false when this device is the one holding the seat", () => {
    expect(
      isSeatedOnAnotherDevice([{ userId: "user-1" }], "user-1", true),
    ).toBe(false);
  });
});
