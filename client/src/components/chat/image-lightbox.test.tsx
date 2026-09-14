// @vitest-environment jsdom
import type { Attachment } from "@pqp/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import * as api from "@/lib/api";
import { ImageLightbox } from "./image-lightbox";

vi.mock("@/lib/api", () => ({ fetchAttachmentUrl: vi.fn() }));

/**
 * The interactive half of the lightbox — everything `image-lightbox.test.ts`
 * cannot reach because it needs a real DOM: Escape, the arrow keys, the
 * bounds at either end of the strip, the clipboard actions and their
 * fallback, and focus returning to whatever opened it.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

// jsdom does not implement ResizeObserver at all. Stubbed fresh per test
// because `afterEach` below unstubs every global to undo the clipboard stubs
// some tests add.
class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});

function attachment(id: string, filename: string): Attachment {
  return {
    id,
    filename,
    contentType: "image/png",
    byteSize: 1024,
    width: 800,
    height: 600,
    url: `https://bucket.example/${id}`,
  };
}

const ONE: Attachment[] = [attachment("a1", "screenshot.png")];
const THREE: Attachment[] = [
  attachment("a1", "first.png"),
  attachment("a2", "second.png"),
  attachment("a3", "third.png"),
];

let root: Root | null = null;
let host: HTMLElement | null = null;

function mount(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root!.render(node);
  });
}

function unmount() {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
}

/**
 * jsdom does not implement the Clipboard API, so `navigator.clipboard` is
 * `undefined` in every test unless this defines it. A plain
 * `Object.defineProperty` rather than `vi.stubGlobal("navigator", …)`: the
 * latter replaces the whole host object with a shallow copy, which drops
 * everything jsdom itself put on the prototype.
 */
function stubClipboard(clipboard: Partial<Clipboard>) {
  Object.defineProperty(navigator, "clipboard", {
    value: clipboard,
    configurable: true,
  });
}

afterEach(() => {
  unmount();
  Reflect.deleteProperty(navigator, "clipboard");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function pressKey(key: string, options: Partial<KeyboardEventInit> = {}) {
  act(() => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options }),
    );
  });
}

function dialog(): HTMLElement | null {
  return document.querySelector('[role="dialog"]');
}

describe("ImageLightbox", () => {
  it("renders as a labelled dialog with the current filename", () => {
    mount(
      <TooltipProvider>
        <ImageLightbox
          attachments={ONE}
          index={0}
          onClose={() => {}}
          onIndexChange={() => {}}
        />
      </TooltipProvider>,
    );
    const node = dialog();
    expect(node).not.toBeNull();
    expect(node?.getAttribute("aria-modal")).toBe("true");
    expect(node?.getAttribute("aria-label")).toBe("screenshot.png");
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    mount(
      <TooltipProvider>
        <ImageLightbox
          attachments={ONE}
          index={0}
          onClose={onClose}
          onIndexChange={() => {}}
        />
      </TooltipProvider>,
    );
    pressKey("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  describe("clicking outside the image", () => {
    /**
     * The stage — the flex box the image is centred in — is what a real
     * click on "outside the image" actually lands on: it fully covers the
     * `bg-surface-0/95` backdrop div underneath, so a synthetic mousedown
     * dispatched straight at the dialog root (matching `target ===
     * currentTarget` there) proved nothing about a real click, only about
     * itself. This is the shape Farol's review of this PR caught.
     */
    function stage(): HTMLElement {
      // The stage is the only `<div>` in the tree with both `overflow-hidden`
      // and `flex-1` — a positional query rather than a test id, since
      // nothing here is meant to be a public hook.
      return document.querySelector(".overflow-hidden.p-6") as HTMLElement;
    }

    function clickAt(el: HTMLElement, x: number, y: number, sameTarget = true) {
      act(() => {
        el.dispatchEvent(
          new MouseEvent("mousedown", { bubbles: true, clientX: x, clientY: y }),
        );
        el.dispatchEvent(
          new MouseEvent("mouseup", {
            bubbles: true,
            clientX: sameTarget ? x : x + 40,
            clientY: y,
          }),
        );
      });
    }

    it("closes on a press-and-release on the stage's empty area", () => {
      const onClose = vi.fn();
      mount(
        <TooltipProvider>
          <ImageLightbox
            attachments={ONE}
            index={0}
            onClose={onClose}
            onIndexChange={() => {}}
          />
        </TooltipProvider>,
      );
      clickAt(stage(), 10, 10);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("does not close when the image itself is pressed", () => {
      const onClose = vi.fn();
      mount(
        <TooltipProvider>
          <ImageLightbox
            attachments={ONE}
            index={0}
            onClose={onClose}
            onIndexChange={() => {}}
          />
        </TooltipProvider>,
      );
      const img = dialog()!.querySelector('img[alt="screenshot.png"]') as HTMLElement;
      clickAt(img, 10, 10);
      expect(onClose).not.toHaveBeenCalled();
    });

    it("does not close on a drag across the stage (press and release at different points)", () => {
      const onClose = vi.fn();
      mount(
        <TooltipProvider>
          <ImageLightbox
            attachments={ONE}
            index={0}
            onClose={onClose}
            onIndexChange={() => {}}
          />
        </TooltipProvider>,
      );
      clickAt(stage(), 10, 10, /* sameTarget */ false);
      expect(onClose).not.toHaveBeenCalled();
    });

    it("does not close while a text selection is active", () => {
      const onClose = vi.fn();
      mount(
        <TooltipProvider>
          <ImageLightbox
            attachments={ONE}
            index={0}
            onClose={onClose}
            onIndexChange={() => {}}
          />
        </TooltipProvider>,
      );
      const range = document.createRange();
      range.selectNodeContents(dialog()!);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      expect(selection.toString().length).toBeGreaterThan(0);

      clickAt(stage(), 10, 10);
      expect(onClose).not.toHaveBeenCalled();
      selection.removeAllRanges();
    });
  });

  it("moves right and left with the arrow keys, without wrapping at either end", () => {
    let index = 0;
    const onIndexChange = vi.fn((next: number) => {
      index = next;
    });
    function renderAt(current: number) {
      act(() => {
        root!.render(
          <TooltipProvider>
            <ImageLightbox
              attachments={THREE}
              index={current}
              onClose={() => {}}
              onIndexChange={onIndexChange}
            />
          </TooltipProvider>,
        );
      });
    }
    // The parent (`AttachmentGrid`) owns `index` as state and re-renders with
    // whatever `onIndexChange` reported — this harness plays that role by
    // hand instead of pulling in a second state-holding component.
    const rerender = () => renderAt(index);

    mount(
      <TooltipProvider>
        <ImageLightbox
          attachments={THREE}
          index={index}
          onClose={() => {}}
          onIndexChange={onIndexChange}
        />
      </TooltipProvider>,
    );

    // First attachment: left does nothing, right advances.
    pressKey("ArrowLeft");
    expect(onIndexChange).not.toHaveBeenCalled();
    pressKey("ArrowRight");
    expect(onIndexChange).toHaveBeenLastCalledWith(1);
    rerender();

    pressKey("ArrowRight");
    expect(onIndexChange).toHaveBeenLastCalledWith(2);
    rerender();

    // Last attachment: right does nothing further.
    onIndexChange.mockClear();
    pressKey("ArrowRight");
    expect(onIndexChange).not.toHaveBeenCalled();

    pressKey("ArrowLeft");
    expect(onIndexChange).toHaveBeenLastCalledWith(1);
  });

  it("shows no counter and no nav arrows for a single-image message", () => {
    mount(
      <TooltipProvider>
        <ImageLightbox
          attachments={ONE}
          index={0}
          onClose={() => {}}
          onIndexChange={() => {}}
        />
      </TooltipProvider>,
    );
    expect(document.body.textContent).not.toContain("1 / 1");
    expect(document.querySelectorAll('button[aria-label="Next image"]').length).toBe(0);
    expect(document.querySelectorAll('button[aria-label="Previous image"]').length).toBe(0);
  });

  it("shows a 2 / 3 counter and both arrows in the middle of a strip", () => {
    mount(
      <TooltipProvider>
        <ImageLightbox
          attachments={THREE}
          index={1}
          onClose={() => {}}
          onIndexChange={() => {}}
        />
      </TooltipProvider>,
    );
    expect(document.body.textContent).toContain("2 / 3");
    expect(document.querySelector('button[aria-label="Previous image"]')).not.toBeNull();
    expect(document.querySelector('button[aria-label="Next image"]')).not.toBeNull();
  });

  it("copies the link to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard({ writeText });
    mount(
      <TooltipProvider>
        <ImageLightbox
          attachments={ONE}
          index={0}
          onClose={() => {}}
          onIndexChange={() => {}}
        />
      </TooltipProvider>,
    );
    const button = document.querySelector(
      'button[aria-label="Copy link"]',
    ) as HTMLButtonElement;
    expect(button).not.toBeNull();
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith(ONE[0]!.url);
  });

  it("falls back to copying the link and says so, when copying the image fails", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    // No `clipboard.write` / no `ClipboardItem` — the unsupported-image path.
    stubClipboard({ writeText });
    mount(
      <TooltipProvider>
        <ImageLightbox
          attachments={ONE}
          index={0}
          onClose={() => {}}
          onIndexChange={() => {}}
        />
      </TooltipProvider>,
    );
    const button = document.querySelector(
      'button[aria-label="Copy image"]',
    ) as HTMLButtonElement;
    expect(button).not.toBeNull();
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith(ONE[0]!.url);
    expect(document.body.textContent).toContain(
      "Couldn't copy the image, link copied instead",
    );
  });

  it("reports honestly when the fallback link copy also fails, without claiming the link copied", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    // No `clipboard.write` / no `ClipboardItem` — the image copy fails first,
    // and now the fallback `writeText` fails too.
    stubClipboard({ writeText });
    mount(
      <TooltipProvider>
        <ImageLightbox
          attachments={ONE}
          index={0}
          onClose={() => {}}
          onIndexChange={() => {}}
        />
      </TooltipProvider>,
    );
    const button = document.querySelector(
      'button[aria-label="Copy image"]',
    ) as HTMLButtonElement;
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith(ONE[0]!.url);
    // Neither happy-path toast, and specifically not the one claiming the
    // link made it to the clipboard when it did not.
    expect(document.body.textContent).not.toContain(
      "Couldn't copy the image, link copied instead",
    );
    expect(document.body.textContent).toContain("Couldn't copy the image");
  });

  it("uses the refreshed URL in every action once a presigned URL has been renewed", async () => {
    const freshUrl = "https://bucket.example/a1-fresh";
    vi.mocked(api.fetchAttachmentUrl).mockResolvedValue({
      url: freshUrl,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    const clipboardWrite = vi.fn().mockResolvedValue(undefined);
    stubClipboard({ writeText, write: clipboardWrite });
    // `ClipboardItem` does not exist in jsdom either — stubbed just enough to
    // exercise `handleCopyImage`'s happy path rather than its "unsupported"
    // branch, which is already covered by the tests above.
    vi.stubGlobal(
      "ClipboardItem",
      class {
        constructor(public items: Record<string, Blob>) {}
      },
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(new Blob(["x"], { type: "image/png" })));
    vi.stubGlobal("fetch", fetchMock);

    mount(
      <TooltipProvider>
        <ImageLightbox
          attachments={ONE}
          index={0}
          onClose={() => {}}
          onIndexChange={() => {}}
        />
      </TooltipProvider>,
    );

    // The presigned GET baked into `ONE[0].url` has expired; the `<img>`
    // fails to load and the component fetches a fresh one for rendering.
    const img = dialog()!.querySelector('img[alt="screenshot.png"]') as HTMLImageElement;
    await act(async () => {
      img.dispatchEvent(new Event("error"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.fetchAttachmentUrl).toHaveBeenCalledWith("a1");

    // Open original: the anchor's href follows the refresh.
    const openOriginal = document.querySelector(
      'a[aria-label="Open original"]',
    ) as HTMLAnchorElement;
    expect(openOriginal.getAttribute("href")).toBe(freshUrl);

    // Copy link: writes the refreshed URL, not the expired one the message
    // still carries in `attachment.url`.
    const copyLinkButton = document.querySelector(
      'button[aria-label="Copy link"]',
    ) as HTMLButtonElement;
    await act(async () => {
      copyLinkButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenLastCalledWith(freshUrl);

    // Copy image and download both fetch the refreshed URL's bytes.
    const copyImageButton = document.querySelector(
      'button[aria-label="Copy image"]',
    ) as HTMLButtonElement;
    fetchMock.mockClear();
    await act(async () => {
      copyImageButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledWith(freshUrl);

    const downloadButton = document.querySelector(
      'button[aria-label="Download"]',
    ) as HTMLButtonElement;
    fetchMock.mockClear();
    await act(async () => {
      downloadButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledWith(freshUrl);
  });

  it("returns focus to whatever opened it when it closes", async () => {
    const opener = document.createElement("button");
    opener.textContent = "open";
    document.body.append(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    mount(
      <TooltipProvider>
        <ImageLightbox
          attachments={ONE}
          index={0}
          onClose={() => {}}
          onIndexChange={() => {}}
        />
      </TooltipProvider>,
    );
    // The move into the panel happens on a `setTimeout(0)`, the same way
    // `Dialog` defers it, so an autofocused element inside is not fought over.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(document.activeElement).not.toBe(opener);

    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
