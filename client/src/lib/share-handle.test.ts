import { describe, expect, it, vi } from "vitest";
import { shareHandle, shareTextFor, shareUrlFor } from "./share-handle";

/**
 * The share, without a browser.
 *
 * The decision tree matters more than it looks: it decides whether a cancelled
 * share is reported as a failure, whether a device with no sheet is left with
 * nothing, and whether the link somebody pastes into a group chat can be
 * counted when it arrives.
 */

describe("shareUrlFor", () => {
  it("tags the link so an arrival can be counted", () => {
    // A channel we cannot count is a channel we cannot repeat. This is the
    // whole reason the button is worth building.
    expect(shareUrlFor("rafa")).toBe("https://pqp.gg/@rafa?ref=perfil");
  });
});

describe("shareTextFor", () => {
  it("uses the pun in Portuguese", () => {
    expect(shareTextFor("rafa", "pt-BR")).toBe(
      "eu fui pra pqp. me acha em https://pqp.gg/@rafa?ref=perfil",
    );
  });

  it("does not try to translate the pun into English", () => {
    // "vem pra pqp" only works in Portuguese. A literal rendering would be
    // neither funny nor clear, so English gets the plain sentence.
    const en = shareTextFor("rafa", "en");
    expect(en).toContain("https://pqp.gg/@rafa?ref=perfil");
    expect(en).not.toContain("fui pra");
  });
});

describe("shareHandle", () => {
  it("prefers the native sheet when there is one", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    const copy = vi.fn().mockResolvedValue(undefined);
    await expect(shareHandle("rafa", "pt-BR", { share, copy })).resolves.toBe(
      "shared",
    );
    expect(share).toHaveBeenCalledOnce();
    expect(copy).not.toHaveBeenCalled();
  });

  it("treats a cancelled sheet as a decision, not a failure", async () => {
    // navigator.share rejects with AbortError when somebody backs out. Calling
    // that "sharing failed" would be telling them their own choice went wrong,
    // and would send us on to silently copy something they declined to send.
    const abort = Object.assign(new Error("cancelled"), { name: "AbortError" });
    const share = vi.fn().mockRejectedValue(abort);
    const copy = vi.fn().mockResolvedValue(undefined);
    await expect(shareHandle("rafa", "pt-BR", { share, copy })).resolves.toBe(
      "dismissed",
    );
    expect(copy).not.toHaveBeenCalled();
  });

  it("falls back to the clipboard when the sheet is broken", async () => {
    const share = vi.fn().mockRejectedValue(new Error("NotAllowedError"));
    const copy = vi.fn().mockResolvedValue(undefined);
    await expect(shareHandle("rafa", "pt-BR", { share, copy })).resolves.toBe(
      "copied",
    );
    expect(copy).toHaveBeenCalledWith(
      "eu fui pra pqp. me acha em https://pqp.gg/@rafa?ref=perfil",
    );
  });

  it("copies on a desktop, which has no sheet", async () => {
    const copy = vi.fn().mockResolvedValue(undefined);
    await expect(shareHandle("rafa", "pt-BR", { copy })).resolves.toBe("copied");
  });

  it("says so plainly when the device can do neither", async () => {
    await expect(shareHandle("rafa", "pt-BR", {})).resolves.toBe("failed");
  });

  it("reports a refused clipboard as failed rather than pretending", async () => {
    const copy = vi.fn().mockRejectedValue(new Error("denied"));
    await expect(shareHandle("rafa", "pt-BR", { copy })).resolves.toBe("failed");
  });
});
