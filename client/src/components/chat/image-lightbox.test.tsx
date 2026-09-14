// @vitest-environment jsdom
import type { Attachment } from "@pqp/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ImageLightbox } from "./image-lightbox";

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

  it("closes when the backdrop itself is clicked, not when the panel is", () => {
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
    const node = dialog()!;
    act(() => {
      node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    onClose.mockClear();
    const img = node.querySelector("img[alt]") as HTMLElement;
    act(() => {
      img.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();
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
