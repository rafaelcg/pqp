import { afterEach, describe, expect, it } from "vitest";
import {
  recordSharePopout,
  resetSharePopoutForTests,
  setSharePopout,
  sharePopoutActive,
  sharePopoutKnown,
} from "./share-popout-flag";

const SERVER = "7a0b3f3e-2f55-4c1e-9f3a-8d2c1b0a9e11";
const OTHER = "0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f";

describe("share popout flag", () => {
  afterEach(() => {
    resetSharePopoutForTests();
  });

  it("is off for a server nobody has asked about", () => {
    expect(sharePopoutActive(SERVER)).toBe(false);
    expect(sharePopoutActive(null)).toBe(false);
  });

  it("answers per server, and a DM call reads the global answer", () => {
    recordSharePopout(SERVER, true);
    expect(sharePopoutActive(SERVER)).toBe(true);
    expect(sharePopoutActive(OTHER)).toBe(false);
    expect(sharePopoutActive(null)).toBe(false);
    recordSharePopout(null, true);
    expect(sharePopoutActive(null)).toBe(true);
    expect(sharePopoutActive(undefined)).toBe(true);
  });

  it("follows a later answer, so the operator can turn it off live", () => {
    recordSharePopout(SERVER, true);
    recordSharePopout(SERVER, false);
    expect(sharePopoutActive(SERVER)).toBe(false);
  });

  it("can be forced for every server and released again", () => {
    setSharePopout(true);
    expect(sharePopoutActive(OTHER)).toBe(true);
    setSharePopout(null);
    expect(sharePopoutActive(OTHER)).toBe(false);
  });

  it("tells an answer of off apart from no answer yet", () => {
    expect(sharePopoutKnown(SERVER)).toBe(false);
    recordSharePopout(SERVER, false);
    expect(sharePopoutKnown(SERVER)).toBe(true);
    expect(sharePopoutActive(SERVER)).toBe(false);
    setSharePopout(true);
    expect(sharePopoutKnown(OTHER)).toBe(true);
  });
});
