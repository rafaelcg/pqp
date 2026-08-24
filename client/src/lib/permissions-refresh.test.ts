import { describe, expect, it } from "vitest";
import { shouldApplyPermissionsVersion } from "./permissions-refresh";

describe("shouldApplyPermissionsVersion", () => {
  it("refetches when the incoming version is newer", () => {
    expect(shouldApplyPermissionsVersion(3, 4)).toBe(true);
    expect(shouldApplyPermissionsVersion(3, 3)).toBe(false);
    expect(shouldApplyPermissionsVersion(3, 2)).toBe(false);
  });

  it("refetches when the caller did not pass a version", () => {
    expect(shouldApplyPermissionsVersion(3, undefined)).toBe(true);
  });
});
