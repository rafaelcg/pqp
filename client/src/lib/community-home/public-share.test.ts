import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BAU_SHARE_NETWORKS,
  copyShareLink,
  prefersNativeShare,
  shareNatively,
  shareNetworkHref,
} from "./public-share";

const URL_ = "https://pqp.gg/c/mesa/p/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";

describe("shareNetworkHref", () => {
  it("hands every network the link with its own campaign", () => {
    for (const network of BAU_SHARE_NETWORKS) {
      const href = shareNetworkHref(network, URL_, "Patch 1.2 saiu");
      const decoded = decodeURIComponent(href);
      expect(decoded, network).toContain(`${URL_}?utm_source=${network}&utm_medium=share&utm_campaign=bau`);
      expect(decoded, network).toContain("Patch 1.2 saiu");
    }
  });

  it("goes to the compose page of each network", () => {
    expect(shareNetworkHref("x", URL_, "t")).toMatch(/^https:\/\/x\.com\/intent\/post\?/);
    expect(shareNetworkHref("reddit", URL_, "t")).toMatch(/^https:\/\/www\.reddit\.com\/submit\?/);
    expect(shareNetworkHref("whatsapp", URL_, "t")).toMatch(/^https:\/\/wa\.me\/\?text=/);
    expect(shareNetworkHref("telegram", URL_, "t")).toMatch(/^https:\/\/t\.me\/share\/url\?/);
  });

  it("encodes the title so it cannot add parameters of its own", () => {
    const href = shareNetworkHref("x", URL_, "a&url=https://evil.example&b=c#d");
    const parsed = new URL(href);
    expect(parsed.searchParams.getAll("url")).toEqual([
      `${URL_}?utm_source=x&utm_medium=share&utm_campaign=bau`,
    ]);
    expect(parsed.searchParams.get("text")).toBe("a&url=https://evil.example&b=c#d");
  });

  it("works with no title at all", () => {
    for (const network of BAU_SHARE_NETWORKS) {
      const href = shareNetworkHref(network, URL_, "   ");
      expect(decodeURIComponent(href)).toContain(URL_);
      expect(href).not.toContain("text=%20");
    }
  });

  it("whatsapp gets the words and then the link on its own line", () => {
    const text = new URL(shareNetworkHref("whatsapp", URL_, "Olha isso")).searchParams.get("text");
    expect(text).toBe(
      `Olha isso\n${URL_}?utm_source=whatsapp&utm_medium=share&utm_campaign=bau`,
    );
  });
});

describe("the system sheet and the clipboard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("prefers the sheet only on a touch device that can share", () => {
    vi.stubGlobal("navigator", { share: vi.fn() });
    vi.stubGlobal("window", { matchMedia: () => ({ matches: true }) });
    expect(prefersNativeShare()).toBe(true);
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
    expect(prefersNativeShare()).toBe(false);
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("window", { matchMedia: () => ({ matches: true }) });
    expect(prefersNativeShare()).toBe(false);
  });

  it("shares the native link and reports a dismissed sheet as cancelled, not failed", async () => {
    const share = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { share });
    expect(await shareNatively(URL_, " Patch ")).toBe("shared");
    expect(share).toHaveBeenCalledWith({
      url: `${URL_}?utm_source=native&utm_medium=share&utm_campaign=bau`,
      title: "Patch",
    });

    vi.stubGlobal("navigator", {
      share: vi.fn(async () => {
        throw new DOMException("dismissed", "AbortError");
      }),
    });
    expect(await shareNatively(URL_, "")).toBe("cancelled");
    vi.stubGlobal("navigator", {
      share: vi.fn(async () => {
        throw new DOMException("no", "NotAllowedError");
      }),
    });
    expect(await shareNatively(URL_, "")).toBe("failed");
  });

  it("copies the link with the copy campaign, and says so when the browser refuses", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    expect(await copyShareLink(URL_)).toBe(true);
    expect(writeText).toHaveBeenCalledWith(
      `${URL_}?utm_source=copy&utm_medium=share&utm_campaign=bau`,
    );
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn(async () => Promise.reject(new Error("no"))) },
    });
    expect(await copyShareLink(URL_)).toBe(false);
    vi.stubGlobal("navigator", {});
    expect(await copyShareLink(URL_)).toBe(false);
  });
});
