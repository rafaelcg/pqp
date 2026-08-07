import { describe, expect, it } from "vitest";
import { validateChannelIconInput } from "./channel-meta-dialog";

describe("validateChannelIconInput", () => {
  it("accepts an empty value — clearing the icon", () => {
    expect(validateChannelIconInput("")).toBeNull();
    expect(validateChannelIconInput("   ")).toBeNull();
  });

  it("accepts an emoji or short label untouched", () => {
    expect(validateChannelIconInput("📡")).toBeNull();
    expect(validateChannelIconInput("chat")).toBeNull();
  });

  it("accepts an https URL", () => {
    expect(
      validateChannelIconInput("https://cdn.example.com/icon.png"),
    ).toBeNull();
  });

  // The channel image renders to every member of the server, so a plain
  // http:// link — unencrypted, and broken outright when the app itself is
  // served over https — is refused rather than silently accepted.
  it("rejects an http URL", () => {
    expect(
      validateChannelIconInput("http://cdn.example.com/icon.png"),
    ).toBe("channel.meta.image.error.httpsOnly");
  });

  it("rejects a non-http(s) scheme", () => {
    expect(validateChannelIconInput("ftp://cdn.example.com/icon.png")).toBe(
      "channel.meta.image.error.httpsOnly",
    );
    expect(validateChannelIconInput("javascript://alert(1)")).toBe(
      "channel.meta.image.error.httpsOnly",
    );
  });

  it("rejects a malformed URL", () => {
    expect(validateChannelIconInput("https://")).toBe(
      "channel.meta.image.error.invalid",
    );
  });
});
