import { afterEach, describe, expect, it } from "vitest";
import { isInCall, setInCall } from "./in-call-state";

describe("in-call state", () => {
  afterEach(() => setInCall(false));

  it("starts out of a call and reflects writes", () => {
    expect(isInCall()).toBe(false);
    setInCall(true);
    expect(isInCall()).toBe(true);
    setInCall(false);
    expect(isInCall()).toBe(false);
  });
});
