import { describe, expect, it } from "vitest";
import { stagePipTarget } from "./stage-pip-target";

const none = { soloPeerId: null, pinnedTileId: null, focusedPeerId: null };

describe("stagePipTarget", () => {
  it("is nothing when no remote share can go into PiP", () => {
    expect(stagePipTarget({ ...none, candidates: [] })).toBeNull();
  });

  it("is the only share when there is one", () => {
    expect(stagePipTarget({ ...none, candidates: ["a"] })).toBe("a");
  });

  it("prefers the pinned share", () => {
    expect(
      stagePipTarget({
        ...none,
        candidates: ["a", "b"],
        pinnedTileId: "b",
        focusedPeerId: "a",
      }),
    ).toBe("b");
  });

  it("prefers the share alone in fullscreen over the pin", () => {
    expect(
      stagePipTarget({
        candidates: ["a", "b"],
        soloPeerId: "a",
        pinnedTileId: "b",
        focusedPeerId: "b",
      }),
    ).toBe("a");
  });

  it("falls back to the focused share, then the first", () => {
    expect(
      stagePipTarget({ ...none, candidates: ["a", "b"], focusedPeerId: "b" }),
    ).toBe("b");
    expect(stagePipTarget({ ...none, candidates: ["a", "b"] })).toBe("a");
  });

  it("ignores a pin or focus that is not a candidate", () => {
    // A pinned camera, our own share, or a solo camera in fullscreen.
    expect(
      stagePipTarget({
        candidates: ["b"],
        soloPeerId: "camera:x",
        pinnedTileId: "camera:y",
        focusedPeerId: "self",
      }),
    ).toBe("b");
  });
});
