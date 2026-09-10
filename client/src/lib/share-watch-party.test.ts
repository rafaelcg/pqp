import { describe, expect, it, vi } from "vitest";
import {
  shareWatchParty,
  watchPartyShareText,
  watchPartyShareUrl,
} from "./share-watch-party";

describe("watchPartyShareUrl", () => {
  it("points at the channel on the page's own origin", () => {
    expect(watchPartyShareUrl("https://staging.pqp-3yr.pages.dev/", "s1", "c1")).toBe(
      "https://staging.pqp-3yr.pages.dev/app/server/s1/channel/c1",
    );
  });
});

describe("watchPartyShareText", () => {
  it("speaks the locale", () => {
    expect(watchPartyShareText("Cinemoon", "https://x/y", "pt-BR")).toBe(
      "watch party: Cinemoon. entra em https://x/y",
    );
    expect(watchPartyShareText("Cinemoon", "https://x/y", "en")).toBe(
      "watch party: Cinemoon. join at https://x/y",
    );
  });
});

describe("shareWatchParty", () => {
  const input = { name: "Cinemoon", url: "https://x/y", locale: "pt-BR" };

  it("prefers the native sheet and sends the sentence", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    const copy = vi.fn();
    await expect(shareWatchParty(input, { share, copy })).resolves.toBe("shared");
    expect(share).toHaveBeenCalledWith({
      text: "watch party: Cinemoon. entra em https://x/y",
      url: "https://x/y",
    });
    expect(copy).not.toHaveBeenCalled();
  });

  it("copies the bare url when there is no sheet", async () => {
    const copy = vi.fn().mockResolvedValue(undefined);
    await expect(shareWatchParty(input, { copy })).resolves.toBe("copied");
    expect(copy).toHaveBeenCalledWith("https://x/y");
  });

  it("treats a dismissed sheet as a decision, not a failure", async () => {
    const abort = new Error("nope");
    abort.name = "AbortError";
    const share = vi.fn().mockRejectedValue(abort);
    const copy = vi.fn();
    await expect(shareWatchParty(input, { share, copy })).resolves.toBe("dismissed");
    expect(copy).not.toHaveBeenCalled();
  });

  it("falls through to the clipboard when the sheet is broken", async () => {
    const share = vi.fn().mockRejectedValue(new Error("no sheet"));
    const copy = vi.fn().mockResolvedValue(undefined);
    await expect(shareWatchParty(input, { share, copy })).resolves.toBe("copied");
  });

  it("fails when the device can do neither", async () => {
    await expect(shareWatchParty(input, {})).resolves.toBe("failed");
  });
});
