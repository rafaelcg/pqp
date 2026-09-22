import { describe, expect, it, vi } from "vitest";
import {
  shareInvite,
  shareInviteText,
  shareInviteUrl,
} from "./share-invite";

/**
 * The invite paste, without a browser.
 *
 * The decision tree matters more than it looks: it decides whether a
 * cancelled share is reported as a failure, whether the short line stays
 * short enough for Discord, and whether the link somebody pastes can be
 * counted when it arrives.
 */

const ORIGIN = "https://pqp.gg";
const CODE = "abc123";
const URL = "https://pqp.gg/app/invite/abc123?ref=convite";

describe("shareInviteUrl", () => {
  it("tags the link so an arrival can be counted", () => {
    expect(shareInviteUrl(ORIGIN, CODE)).toBe(URL);
  });

  it("strips a trailing slash on the origin", () => {
    expect(shareInviteUrl("https://pqp.gg/", CODE)).toBe(URL);
  });

  it("encodes the code", () => {
    expect(shareInviteUrl(ORIGIN, "a/b")).toBe(
      "https://pqp.gg/app/invite/a%2Fb?ref=convite",
    );
  });

  it("tags the invite a Discord import hands out as discord", () => {
    expect(shareInviteUrl(ORIGIN, CODE, "discord")).toBe(
      "https://pqp.gg/app/invite/abc123?ref=discord",
    );
  });

  it("tags the invite the first-run wizard hands out as onboarding", () => {
    expect(shareInviteUrl(ORIGIN, CODE, "onboarding")).toBe(
      "https://pqp.gg/app/invite/abc123?ref=onboarding",
    );
  });
});

describe("shareInviteText", () => {
  it("uses the pun in Portuguese, short and long", () => {
    expect(shareInviteText("short", "pt-BR", URL)).toBe(
      `Vem pra pqp: ${URL} #vemprapqp`,
    );
    expect(shareInviteText("long", "pt-BR", URL)).toBe(
      `A gente mudou pra pqp. Abre no navegador, entra na call e já era: ${URL} #vemprapqp`,
    );
  });

  it("does not try to translate the pun into English", () => {
    const short = shareInviteText("short", "en", URL);
    const long = shareInviteText("long", "en", URL);
    expect(short).toBe(`Come hang out on pqp: ${URL} #vemprapqp`);
    expect(long).toContain(URL);
    expect(long).toContain("#vemprapqp");
    expect(short).not.toContain("Vem pra");
    expect(long).not.toContain("tela no BR");
  });

  it("never references the Discord screen-share suspension", () => {
    for (const locale of ["pt-BR", "en"]) {
      for (const kind of ["short", "long"] as const) {
        const text = shareInviteText(kind, locale, URL).toLowerCase();
        expect(text).not.toMatch(/anpd|suspen|sem tela|screen share in brazil/);
      }
    }
  });

  it("never sells the move on another service being down", () => {
    // The paste is the most-copied sentence in the funnel. It says where the
    // group is, not what happened to the place they left.
    for (const locale of ["pt-BR", "en"]) {
      for (const kind of ["short", "long"] as const) {
        const text = shareInviteText(kind, locale, URL);
        expect(text).not.toMatch(/Discord|sem tela|screen share/i);
      }
    }
  });
});

describe("shareInvite", () => {
  it("prefers the native sheet when there is one", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    const copy = vi.fn().mockResolvedValue(undefined);
    await expect(
      shareInvite("short", "pt-BR", URL, { share, copy }),
    ).resolves.toBe("shared");
    expect(share).toHaveBeenCalledOnce();
    expect(copy).not.toHaveBeenCalled();
  });

  it("treats a cancelled sheet as a decision, not a failure", async () => {
    const abort = Object.assign(new Error("cancelled"), { name: "AbortError" });
    const share = vi.fn().mockRejectedValue(abort);
    const copy = vi.fn().mockResolvedValue(undefined);
    await expect(
      shareInvite("short", "pt-BR", URL, { share, copy }),
    ).resolves.toBe("dismissed");
    expect(copy).not.toHaveBeenCalled();
  });

  it("falls back to the clipboard when the sheet is broken", async () => {
    const share = vi.fn().mockRejectedValue(new Error("NotAllowedError"));
    const copy = vi.fn().mockResolvedValue(undefined);
    await expect(
      shareInvite("short", "pt-BR", URL, { share, copy }),
    ).resolves.toBe("copied");
    expect(copy).toHaveBeenCalledWith(`Vem pra pqp: ${URL} #vemprapqp`);
  });

  it("copies on a desktop, which has no sheet", async () => {
    const copy = vi.fn().mockResolvedValue(undefined);
    await expect(
      shareInvite("long", "en", URL, { copy }),
    ).resolves.toBe("copied");
    expect(copy).toHaveBeenCalledWith(
      `We moved to pqp. Opens in the browser, join the call and that's it: ${URL} #vemprapqp`,
    );
  });

  it("says so plainly when the device can do neither", async () => {
    await expect(shareInvite("short", "pt-BR", URL, {})).resolves.toBe(
      "failed",
    );
  });

  it("reports a refused clipboard as failed rather than pretending", async () => {
    const copy = vi.fn().mockRejectedValue(new Error("denied"));
    await expect(shareInvite("short", "pt-BR", URL, { copy })).resolves.toBe(
      "failed",
    );
  });
});
