import { describe, expect, it } from "vitest";
import {
  shouldShowCommunityHomeSettingsNew,
  shouldShowCommunityHomeSettingsRow,
} from "./settings-row";

describe("shouldShowCommunityHomeSettingsRow", () => {
  it("fails closed when the instance flag/latch is off", () => {
    expect(
      shouldShowCommunityHomeSettingsRow({
        featureOn: false,
        canManageServer: true,
      }),
    ).toBe(false);
  });

  it("hides the row without MANAGE_SERVER even when the flag is on", () => {
    expect(
      shouldShowCommunityHomeSettingsRow({
        featureOn: true,
        canManageServer: false,
      }),
    ).toBe(false);
  });

  it("shows the Server settings toggle when flag on + MANAGE_SERVER", () => {
    expect(
      shouldShowCommunityHomeSettingsRow({
        featureOn: true,
        canManageServer: true,
      }),
    ).toBe(true);
  });
});

describe("shouldShowCommunityHomeSettingsNew", () => {
  it("puts NEW on the control while the bit is false and unseen", () => {
    expect(
      shouldShowCommunityHomeSettingsNew({
        enabled: false,
        settingsNew: true,
      }),
    ).toBe(true);
  });

  it("hides NEW once the bit is on", () => {
    expect(
      shouldShowCommunityHomeSettingsNew({
        enabled: true,
        settingsNew: true,
      }),
    ).toBe(false);
  });

  it("hides NEW after the control has been acted on", () => {
    expect(
      shouldShowCommunityHomeSettingsNew({
        enabled: false,
        settingsNew: false,
      }),
    ).toBe(false);
  });
});
