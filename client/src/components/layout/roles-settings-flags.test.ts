import { describe, expect, it } from "vitest";
import { flagGatedOff } from "./roles-settings-section";

describe("which permission switches the role editor draws", () => {
  it("hides USE_APPS until the apps flag is on for the server, and only that one", () => {
    expect(flagGatedOff("USE_APPS", { storiesOn: true, appsOn: false })).toBe(true);
    expect(flagGatedOff("USE_APPS", { storiesOn: false, appsOn: true })).toBe(false);
    expect(flagGatedOff("SEND_MESSAGES", { storiesOn: false, appsOn: false })).toBe(false);
  });

  it("keeps POST_STORIES behind its own flag, independent of the apps one", () => {
    expect(flagGatedOff("POST_STORIES", { storiesOn: false, appsOn: true })).toBe(true);
    expect(flagGatedOff("POST_STORIES", { storiesOn: true, appsOn: false })).toBe(false);
  });
});
