import { afterEach, describe, expect, it } from "vitest";
import {
  dispatchShareView,
  resetShareViewForTests,
  shareViewMode,
} from "./share-view-store";

afterEach(() => {
  resetShareViewForTests();
});

describe("share view store", () => {
  it("starts as a popout and follows the transitions", () => {
    expect(shareViewMode()).toBe("popout");
    dispatchShareView({ type: "maximize" });
    expect(shareViewMode()).toBe("theater");
    dispatchShareView({ type: "escape" });
    expect(shareViewMode()).toBe("popout");
  });

  it("goes back to a popout when the call changes", () => {
    dispatchShareView({ type: "maximize" });
    dispatchShareView({ type: "call-changed" });
    expect(shareViewMode()).toBe("popout");
  });

  it("ignores escape outside the theater", () => {
    dispatchShareView({ type: "escape" });
    expect(shareViewMode()).toBe("popout");
  });
});

