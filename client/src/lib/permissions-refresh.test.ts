import { describe, expect, it } from "vitest";
import {
  shouldApplyPermissionsVersion,
  shouldWipePermissionsOnFetchFailure,
} from "./permissions-refresh";

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

describe("shouldWipePermissionsOnFetchFailure", () => {
  it("keeps the snapshot when a bump-refetch of the same server fails", () => {
    expect(shouldWipePermissionsOnFetchFailure("server-a", "server-a")).toBe(
      false,
    );
  });

  it("wipes when the first load fails, or the new server fails after a switch", () => {
    expect(shouldWipePermissionsOnFetchFailure(null, "server-a")).toBe(true);
    expect(shouldWipePermissionsOnFetchFailure("server-a", "server-b")).toBe(
      true,
    );
  });
});
