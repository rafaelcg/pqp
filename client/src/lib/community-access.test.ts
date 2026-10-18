import { describe, expect, it } from "vitest";
import {
  communityVisibility,
  doorsOpening,
  isServerPublic,
} from "./community-access";

describe("communityVisibility", () => {
  it("is private without an address, whatever else is set", () => {
    expect(communityVisibility({ isCommunity: false })).toBe("private");
    expect(communityVisibility({ isCommunity: false, isListed: true })).toBe(
      "private",
    );
  });

  it("is a public link with an address and no listing", () => {
    expect(communityVisibility({ isCommunity: true, isListed: false })).toBe(
      "public",
    );
    expect(communityVisibility({ isCommunity: true })).toBe("public");
  });

  it("is listed when the directory is on too", () => {
    expect(communityVisibility({ isCommunity: true, isListed: true })).toBe(
      "listed",
    );
  });

  it("reads a suspended community as not public, switches or no", () => {
    expect(
      communityVisibility({
        isCommunity: true,
        isListed: true,
        suspended: true,
      }),
    ).toBe("suspended");
  });
});

describe("isServerPublic", () => {
  it("follows the address, on an instance with communities", () => {
    expect(isServerPublic({ isCommunity: true }, true)).toBe(true);
    expect(isServerPublic({ isCommunity: false }, true)).toBe(false);
  });

  it("is never true with communities off, or without a server", () => {
    expect(isServerPublic({ isCommunity: true }, false)).toBe(false);
    expect(isServerPublic(null, true)).toBe(false);
    expect(isServerPublic(undefined, true)).toBe(false);
  });
});

describe("doorsOpening", () => {
  const closed = { isCommunity: false, isListed: false };
  const addressed = { isCommunity: true, isListed: false };
  const listed = { isCommunity: true, isListed: true };

  it("asks when the address goes on", () => {
    expect(doorsOpening(closed, addressed)).toBe("address");
  });

  it("asks when the directory goes on", () => {
    expect(doorsOpening(addressed, listed)).toBe("directory");
  });

  it("asks once, for both, when one save opens both doors", () => {
    expect(doorsOpening(closed, listed)).toBe("both");
  });

  it("never asks to close a door", () => {
    expect(doorsOpening(listed, addressed)).toBeNull();
    expect(doorsOpening(addressed, closed)).toBeNull();
    expect(doorsOpening(listed, closed)).toBeNull();
  });

  it("never asks when nothing about the doors changed", () => {
    expect(doorsOpening(closed, closed)).toBeNull();
    expect(doorsOpening(listed, listed)).toBeNull();
  });
});
