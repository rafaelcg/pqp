import { describe, expect, it } from "vitest";
import { pinSignatureOf } from "./use-pinned-count";

describe("pinSignatureOf", () => {
  it("changes when a pin lands, again when the server confirms it, and on an unpin", () => {
    const none = pinSignatureOf([{ id: "a" }, { id: "b", pinnedAt: null }]);
    const optimistic = pinSignatureOf([{ id: "a", pinnedAt: "t", pinnedBy: null }, { id: "b" }]);
    const confirmed = pinSignatureOf([{ id: "a", pinnedAt: "t", pinnedBy: { id: "u" } }, { id: "b" }]);
    expect(none).toBe("");
    expect(optimistic).not.toBe(none);
    expect(confirmed).not.toBe(optimistic);
    expect(pinSignatureOf([{ id: "a", pinnedAt: null }, { id: "b" }])).toBe(none);
  });
});
