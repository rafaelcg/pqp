import { describe, expect, it } from "vitest";
import { supportLinksFrom, supportPagePath } from "./support-links";

describe("supportLinksFrom", () => {
  it("is off when nothing is set, so a self-hosted build ships no donation links", () => {
    expect(supportLinksFrom({})).toBeNull();
    expect(
      supportLinksFrom({
        VITE_SPONSOR_URL: undefined,
        VITE_PIX_KEY: undefined,
        VITE_PIX_BRCODE: undefined,
      }),
    ).toBeNull();
    expect(supportLinksFrom({ VITE_SPONSOR_URL: "", VITE_PIX_KEY: "" })).toBeNull();
  });

  it("treats whitespace-only values as unset", () => {
    expect(supportLinksFrom({ VITE_SPONSOR_URL: "   ", VITE_PIX_KEY: "\n\t" })).toBeNull();
  });

  it("ignores values that are not strings", () => {
    expect(supportLinksFrom({ VITE_SPONSOR_URL: 42, VITE_PIX_KEY: true })).toBeNull();
  });

  it("a BR code alone does not turn the page on", () => {
    expect(supportLinksFrom({ VITE_PIX_BRCODE: "00020126..." })).toBeNull();
  });

  it("is on with only a Sponsors URL", () => {
    expect(supportLinksFrom({ VITE_SPONSOR_URL: "https://github.com/sponsors/rafaelcg" })).toEqual({
      sponsorUrl: "https://github.com/sponsors/rafaelcg",
      pixKey: null,
      pixBrCode: null,
    });
  });

  it("is on with only a Pix key", () => {
    expect(supportLinksFrom({ VITE_PIX_KEY: "9c1b6f8e-1111-4222-8333-444455556666" })).toEqual({
      sponsorUrl: null,
      pixKey: "9c1b6f8e-1111-4222-8333-444455556666",
      pixBrCode: null,
    });
  });

  it("trims every value and keeps the BR code only next to a key", () => {
    expect(
      supportLinksFrom({
        VITE_SPONSOR_URL: "  https://github.com/sponsors/rafaelcg  ",
        VITE_PIX_KEY: " 9c1b6f8e-1111-4222-8333-444455556666 ",
        VITE_PIX_BRCODE: " 00020126580014br.gov.bcb.pix... ",
      }),
    ).toEqual({
      sponsorUrl: "https://github.com/sponsors/rafaelcg",
      pixKey: "9c1b6f8e-1111-4222-8333-444455556666",
      pixBrCode: "00020126580014br.gov.bcb.pix...",
    });
    expect(
      supportLinksFrom({
        VITE_SPONSOR_URL: "https://github.com/sponsors/rafaelcg",
        VITE_PIX_BRCODE: "00020126...",
      }),
    ).toEqual({
      sponsorUrl: "https://github.com/sponsors/rafaelcg",
      pixKey: null,
      pixBrCode: null,
    });
  });

  it("an empty BR code shows only the key", () => {
    expect(
      supportLinksFrom({ VITE_PIX_KEY: "abc", VITE_PIX_BRCODE: "   " }),
    ).toEqual({ sponsorUrl: null, pixKey: "abc", pixBrCode: null });
  });
});

describe("supportPagePath", () => {
  it("sends Portuguese to /apoie and everyone else to /support", () => {
    expect(supportPagePath("pt-BR")).toBe("/apoie");
    expect(supportPagePath("pt")).toBe("/apoie");
    expect(supportPagePath("PT-PT")).toBe("/apoie");
    expect(supportPagePath("en")).toBe("/support");
    expect(supportPagePath("es")).toBe("/support");
    expect(supportPagePath("")).toBe("/support");
  });
});
