// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import { I18nProvider } from "@/lib/i18n";
import { BauShareButton } from "./community-home-share-public";

const URL_ = "https://pqp.gg/c/mesa/p/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";

let host: HTMLDivElement;
let unmount: () => void;

function pointer(coarse: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("pointer: coarse") ? coarse : false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

async function mount(surface: "card" | "page" = "card") {
  host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <I18nProvider>
        <BauShareButton publicUrl={URL_} title="Patch 1.2" surface={surface} />
      </I18nProvider>,
    );
  });
  unmount = () => act(() => root.unmount());
  return host.querySelector<HTMLButtonElement>("button")!;
}

describe("BauShareButton", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    unmount?.();
    host?.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("on a touch device with a share sheet it opens the sheet with the native campaign link", async () => {
    pointer(true);
    const share = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { share });
    const button = await mount();
    expect(button.getAttribute("aria-haspopup")).toBeNull();
    await act(async () => {
      button.click();
    });
    expect(share).toHaveBeenCalledWith({
      url: `${URL_}?utm_source=native&utm_medium=share&utm_campaign=bau`,
      title: "Patch 1.2",
    });
  });

  it("a sheet that fails falls back to copying the link, and says so", async () => {
    pointer(true);
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", {
      share: vi.fn(async () => {
        throw new DOMException("no", "NotAllowedError");
      }),
      clipboard: { writeText },
    });
    const button = await mount();
    await act(async () => {
      button.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith(
      `${URL_}?utm_source=copy&utm_medium=share&utm_campaign=bau`,
    );
    expect(host.textContent).toContain("Link copied");
    // The confirmation does not stay.
    await act(async () => {
      vi.advanceTimersByTime(2100);
    });
    expect(host.textContent).not.toContain("Link copied");
  });

  it("a dismissed sheet is not an error and copies nothing", async () => {
    pointer(true);
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", {
      share: vi.fn(async () => {
        throw new DOMException("dismissed", "AbortError");
      }),
      clipboard: { writeText },
    });
    const button = await mount();
    await act(async () => {
      button.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(writeText).not.toHaveBeenCalled();
  });

  it("on desktop it is a menu, even when the browser exposes navigator.share", async () => {
    pointer(false);
    const share = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { share });
    const button = await mount();
    expect(button.getAttribute("aria-haspopup")).toBe("menu");
    expect(share).not.toHaveBeenCalled();
  });

  it("wears the surface it sits on, so the page and the card can be styled apart", async () => {
    pointer(false);
    vi.stubGlobal("navigator", {});
    const button = await mount("page");
    expect(button.getAttribute("data-bau-share")).toBe("page");
    expect(button.textContent).toBe("Share");
  });
});
