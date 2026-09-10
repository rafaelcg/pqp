import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  resetHideScreenPreviewForTests,
  setHideScreenPreview,
} from "@/lib/screen-preview-pref";
import { ScreenShareView } from "./screen-share-view";

/**
 * The suite runs under vitest's `node` environment, which has no
 * `localStorage` global at all. Just enough of the real API for the pref.
 */
function fakeLocalStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => store.clear(),
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", fakeLocalStorage());
  resetHideScreenPreviewForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetHideScreenPreviewForTests();
});

const fakeStream = {} as unknown as MediaStream;

function render(isSelf: boolean, onStopSharing?: () => void) {
  return renderToStaticMarkup(
    <TooltipProvider>
      <ScreenShareView
        stream={fakeStream}
        presenterName="Ana"
        isSelf={isSelf}
        onStopSharing={onStopSharing}
      />
    </TooltipProvider>,
  );
}

describe("ScreenShareView self preview", () => {
  it("mounts a live video for the host by default", () => {
    const html = render(true, () => {});
    expect(html).toContain("<video");
    expect(html).toContain("Stop sharing");
  });

  it("does not mount a video when the host hid their own preview", () => {
    setHideScreenPreview(true);
    const html = render(true, () => {});
    expect(html).not.toContain("<video");
    expect(html).toContain("You are sharing");
    expect(html).toContain("Stop sharing");
    expect(html).toContain("data-self-preview-hidden");
  });

  it("still mounts a peer's video even when the host hid their preview", () => {
    setHideScreenPreview(true);
    expect(render(false)).toContain("<video");
    expect(render(false)).not.toContain("data-self-preview-hidden");
  });
});
