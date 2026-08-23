import { describe, expect, it } from "vitest";
import { screenShareStageLayout } from "./screen-stage";

describe("screenShareStageLayout", () => {
  it("splits only two shares on a wide window", () => {
    expect(screenShareStageLayout(2, true)).toBe("split");
    expect(screenShareStageLayout(2, false)).toBe("focus");
    expect(screenShareStageLayout(1, true)).toBe("focus");
    expect(screenShareStageLayout(3, true)).toBe("focus");
  });
});
