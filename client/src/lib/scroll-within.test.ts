import { describe, expect, it } from "vitest";
import { scrollTopToReveal, type RevealGeometry } from "./scroll-within";

/** A 600px transcript over 2000px of messages, currently at the top. */
const base: RevealGeometry = {
  scrollTop: 0,
  clientHeight: 600,
  scrollHeight: 2000,
  nodeTop: 0,
  nodeHeight: 20,
};

describe("scrollTopToReveal", () => {
  it("centres a node the container can centre", () => {
    expect(scrollTopToReveal({ ...base, nodeTop: 1000 }, "center")).toBe(710);
  });

  it("stops at the end instead of handing the rest to an ancestor", () => {
    // A NEW divider a few rows from the end: centring it would need 1690,
    // the container tops out at 1400. The 290 left over is the distance that
    // used to slide the whole app up.
    expect(scrollTopToReveal({ ...base, nodeTop: 1980 }, "center")).toBe(1400);
  });

  it("never goes above the top", () => {
    expect(
      scrollTopToReveal({ ...base, scrollTop: 100, nodeTop: -90 }, "center"),
    ).toBe(0);
  });

  it("aligns to the top for start", () => {
    expect(scrollTopToReveal({ ...base, scrollTop: 200, nodeTop: 50 }, "start")).toBe(250);
  });

  it("leaves a visible node alone for nearest", () => {
    expect(
      scrollTopToReveal({ ...base, scrollTop: 300, nodeTop: 100 }, "nearest"),
    ).toBe(300);
  });

  it("moves the least for nearest", () => {
    expect(
      scrollTopToReveal({ ...base, scrollTop: 300, nodeTop: 590 }, "nearest"),
    ).toBe(310);
    expect(
      scrollTopToReveal({ ...base, scrollTop: 300, nodeTop: -15 }, "nearest"),
    ).toBe(285);
  });

  it("shows the top of a node taller than the view for nearest", () => {
    expect(
      scrollTopToReveal(
        { ...base, scrollTop: 300, nodeTop: 400, nodeHeight: 900 },
        "nearest",
      ),
    ).toBe(700);
  });
});
