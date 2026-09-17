import { describe, expect, it } from "vitest";
import { isNoIndexAppPath } from "./app-robots";

describe("isNoIndexAppPath", () => {
  it("marks the app shell and every page under it", () => {
    expect(isNoIndexAppPath("/app")).toBe(true);
    expect(isNoIndexAppPath("/app/")).toBe(true);
    expect(
      isNoIndexAppPath("/app/server/2cfeb1b2-b7a3-4b5a-be64-455f50c769eb"),
    ).toBe(true);
    expect(
      isNoIndexAppPath(
        "/app/server/2cfeb1b2-b7a3-4b5a-be64-455f50c769eb/channel/93b4bb93-0000-0000-0000-000000000000",
      ),
    ).toBe(true);
    expect(isNoIndexAppPath("/app/settings")).toBe(true);
  });

  it("leaves the invite door alone, which owns its own noindex", () => {
    expect(isNoIndexAppPath("/app/invite/aBc12_xY")).toBe(false);
    expect(isNoIndexAppPath("/app/invite/")).toBe(false);
  });

  it("does not touch anything outside /app", () => {
    for (const path of ["/", "/tela", "/blog", "/appstore", "/apparel", "/api/health"]) {
      expect(isNoIndexAppPath(path)).toBe(false);
    }
  });
});
