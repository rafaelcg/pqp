import { describe, expect, it } from "vitest";
import {
  ANDROID_APK_DOWNLOAD_URL,
  androidApkUrlFrom,
} from "./android-apk";

describe("androidApkUrlFrom", () => {
  it("falls back to the GitHub latest-release APK when unset", () => {
    expect(androidApkUrlFrom(undefined)).toBe(ANDROID_APK_DOWNLOAD_URL);
    expect(androidApkUrlFrom("")).toBe(ANDROID_APK_DOWNLOAD_URL);
  });

  it("honours an override URL", () => {
    expect(androidApkUrlFrom("https://cdn.example/pqp.apk")).toBe(
      "https://cdn.example/pqp.apk",
    );
  });

  it("trims the override", () => {
    expect(androidApkUrlFrom("  https://cdn.example/pqp.apk  ")).toBe(
      "https://cdn.example/pqp.apk",
    );
  });

  it("hides the CTA when the env is a single space", () => {
    expect(androidApkUrlFrom(" ")).toBeNull();
  });
});
