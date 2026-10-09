// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/preferences", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/preferences")>()),
  usePreferenceSyncFailed: (keys: readonly string[]) => keys.includes("inputVolume"),
}));

const { VoiceSection } = await import("@/components/settings/voice-section");
const { defaultLocalSettings } = await import("@/components/settings/local-settings");
const { TooltipProvider } = await import("@/components/ui/tooltip");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("VoiceSection account sync", () => {
  it("says a volume or call preference did not reach the account", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn(() => new Promise(() => undefined)) },
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <TooltipProvider>
          <VoiceSection
            draftLocal={defaultLocalSettings}
            patchLocal={() => undefined}
            inputs={[]}
            outputs={[]}
            cameras={[]}
            onRevealCameras={() => undefined}
            devicesError={null}
            devicesLoaded
            voiceAnalyser={null}
            metering={false}
            showVoiceCleanBadge={false}
          />
        </TooltipProvider>,
      );
    });
    expect(host.textContent).toMatch(/Could not save to your account|Não deu pra salvar na sua conta/);
  });
});
