// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "@pqp/shared";
import { setMicTestRunning } from "@/lib/audio-devices";
import { setInCall } from "@/lib/in-call-state";

/**
 * Opening Voz e vídeo reads the device list. Browsers hide microphone names
 * until the microphone was opened once, so the shell opens it for a moment,
 * and that capture of the default microphone is the problem when something
 * already holds it: a call, or "Ouvir meu microfone". A second capture can
 * mute the first on Safari. So the probe is skipped when a holder is known or
 * the names are readable already, and a machine with no microphone is told so
 * instead of being told to allow one.
 */

vi.stubEnv("VITE_DEV_AUTH_BYPASS", "true");

const { SettingsModal, defaultLocalSettings } = await import("./settings-modal");
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
let getUserMedia: ReturnType<typeof vi.fn>;

type Device = { kind: string; deviceId: string; label: string };

function installMedia({
  devices,
  open = async () => ({ getTracks: () => [{ stop: () => undefined }] }),
}: {
  devices: Device[];
  open?: () => Promise<unknown>;
}) {
  getUserMedia = vi.fn(open);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia,
      enumerateDevices: async () => devices,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    },
  });
}

async function mount(voiceAnalyser: AnalyserNode | null = null) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <TooltipProvider>
        <SettingsModal
          open
          user={{ id: "u1", displayName: "Rafa", username: "rafa", handle: null } as unknown as User}
          localSettings={defaultLocalSettings}
          voiceAnalyser={voiceAnalyser}
          blockedUsers={[]}
          onClose={() => {}}
          onLocalSave={() => {}}
          onUserUpdated={() => {}}
          onUnblockUser={() => {}}
          requestedSection="voice"
        />
      </TooltipProvider>,
    );
  });
  // The list is read after an await or two.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const analyser = () =>
  ({ frequencyBinCount: 4, getByteFrequencyData: () => undefined }) as unknown as AnalyserNode;

const MIC: Device = { kind: "audioinput", deviceId: "mic-1", label: "USB mic" };
const MIC_NO_NAME: Device = { kind: "audioinput", deviceId: "mic-1", label: "" };

beforeEach(() => {
  vi.stubGlobal("AudioContext", class {
    createAnalyser = () => ({ fftSize: 0, frequencyBinCount: 4, getByteFrequencyData: () => undefined, connect: () => undefined });
    createMediaStreamSource = () => ({ connect: () => undefined });
    close = async () => undefined;
  });
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  setInCall(false);
  setMicTestRunning(false);
  vi.unstubAllGlobals();
});

describe("SettingsModal device list and the microphone", () => {
  it("opens no probe capture in a call, even with the names hidden", async () => {
    setInCall(true);
    installMedia({ devices: [MIC_NO_NAME] });
    await mount(analyser());
    expect(getUserMedia).not.toHaveBeenCalled();
    // The list is still read: the select is there.
    expect(document.querySelector('[data-settings-row="input-device"] select')).not.toBeNull();
  });

  it("opens no probe capture while the mic test holds the microphone", async () => {
    setMicTestRunning(true);
    installMedia({ devices: [MIC_NO_NAME] });
    await mount();
    // Only the level meter's own preview, which is not the probe.
    const probes = getUserMedia.mock.calls.filter(
      ([c]) => (c as MediaStreamConstraints).audio === true,
    );
    expect(probes.length).toBeLessThanOrEqual(1);
    expect(getUserMedia.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("does not probe when the browser already shows the microphone's name", async () => {
    installMedia({ devices: [MIC] });
    await mount();
    // The meter's preview opens one capture; the probe would be a second.
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("probes when the names are hidden and nothing holds the microphone", async () => {
    installMedia({ devices: [MIC_NO_NAME] });
    await mount();
    expect(getUserMedia.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(document.querySelector('[data-settings-row="input-device"] select')).not.toBeNull();
  });
});

describe("SettingsModal microphone failures", () => {
  const fail = (name: string) => async () => {
    throw new DOMException(name, name);
  };

  it("says there is no microphone when the machine has none, not that permission is needed", async () => {
    installMedia({ devices: [], open: fail("NotFoundError") });
    await mount();
    expect(document.querySelector("[data-allow-microphone]")).toBeNull();
    expect(
      document.querySelector('[data-settings-row="input-device"]')!.textContent,
    ).toMatch(/No microphone found/);
    // And the sensitivity meter is not operable with nothing to listen to.
    expect(document.querySelector('[role="slider"][aria-label="Sensitivity"]')).toBeNull();
  });

  it("still offers the permission in a call that holds no microphone (listen-only)", async () => {
    setInCall(true);
    installMedia({ devices: [MIC_NO_NAME], open: fail("NotAllowedError") });
    await mount(null);
    expect(document.querySelector("[data-allow-microphone]")).not.toBeNull();
  });

  it("asks for permission when it was refused", async () => {
    installMedia({ devices: [MIC_NO_NAME], open: fail("NotAllowedError") });
    await mount();
    expect(document.querySelector("[data-allow-microphone]")).not.toBeNull();
    expect(document.body.textContent).toMatch(/Microphone permission needed/);
  });

  it("says another app may hold the microphone when it would not start", async () => {
    installMedia({ devices: [MIC_NO_NAME], open: fail("NotReadableError") });
    await mount();
    expect(document.body.textContent).toMatch(/Another app may be using it/);
    expect(document.body.textContent).not.toMatch(/Microphone permission needed/);
  });
});
