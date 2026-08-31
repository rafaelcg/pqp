import { describe, expect, it, vi } from "vitest";
import { androidApkClickUrlFrom, recordAndroidApkClick } from "./android-apk-click";

describe("androidApkClickUrlFrom", () => {
  it("is off when unset, so a self-hosted build never pings us", () => {
    expect(androidApkClickUrlFrom(undefined)).toBeNull();
    expect(androidApkClickUrlFrom("")).toBeNull();
    expect(androidApkClickUrlFrom(" ")).toBeNull();
  });

  it("accepts a public Worker URL", () => {
    expect(androidApkClickUrlFrom("https://pqp-admin.example/apk-click")).toBe(
      "https://pqp-admin.example/apk-click",
    );
    expect(androidApkClickUrlFrom("  https://pqp-admin.example/apk-click  ")).toBe(
      "https://pqp-admin.example/apk-click",
    );
  });
});

describe("recordAndroidApkClick", () => {
  it("does not send when the URL is unset", () => {
    const send = vi.fn(() => true);
    expect(recordAndroidApkClick(send, undefined)).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("sends once to the configured URL", () => {
    const send = vi.fn(() => true);
    expect(recordAndroidApkClick(send, "https://pqp-admin.example/apk-click")).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("https://pqp-admin.example/apk-click");
  });

  it("swallows a send that throws", () => {
    const send = vi.fn(() => {
      throw new Error("offline");
    });
    expect(recordAndroidApkClick(send, "https://pqp-admin.example/apk-click")).toBe(false);
  });
});
