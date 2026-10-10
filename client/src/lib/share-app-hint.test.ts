import { describe, expect, it } from "vitest";
import { shareAppTarget } from "./share-app-hint";

const PLAY = "https://play.google.com/store/apps/details?id=gg.pqp.app";
const TF = "https://testflight.apple.com/join/abc";

const base = { desktopApp: false, android: false, ios: false, playUrl: PLAY, testflight: TF };

describe("shareAppTarget", () => {
  it("points an Android browser without getDisplayMedia at Google Play", () => {
    expect(shareAppTarget({ ...base, canShareInBrowser: false, android: true })).toEqual({
      platform: "android",
      url: PLAY,
    });
  });

  it("points an iPhone at TestFlight", () => {
    expect(shareAppTarget({ ...base, canShareInBrowser: false, ios: true })).toEqual({
      platform: "ios",
      url: TF,
    });
  });

  it("offers nothing when the browser can capture, even on a phone", () => {
    expect(shareAppTarget({ ...base, canShareInBrowser: true, android: true })).toBeNull();
    expect(shareAppTarget({ ...base, canShareInBrowser: true, ios: true })).toBeNull();
  });

  it("offers nothing on a desktop browser or in the desktop app", () => {
    expect(shareAppTarget({ ...base, canShareInBrowser: false })).toBeNull();
    expect(
      shareAppTarget({ ...base, canShareInBrowser: false, desktopApp: true, android: true }),
    ).toBeNull();
  });

  it("offers nothing when the store link is hidden", () => {
    expect(
      shareAppTarget({ ...base, canShareInBrowser: false, android: true, playUrl: null }),
    ).toBeNull();
  });
});
