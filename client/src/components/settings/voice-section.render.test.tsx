// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceSection } from "@/components/settings/voice-section";
import {
  defaultLocalSettings,
  type LocalSettings,
} from "@/components/settings/local-settings";
import { TooltipProvider } from "@/components/ui/tooltip";
import { setInCall } from "@/lib/in-call-state";
import { isMicTestRunning } from "@/lib/audio-devices";
import { setSoundEnabled } from "@/lib/sounds";

/**
 * Voz rendered for real, for the two things a static render cannot show.
 *
 * "Ouvir meu microfone" plays the microphone into the speakers. In a call that
 * loopback reaches the call's own microphone and goes out to the room, and a
 * second capture can mute the call's track on WebKit. So in a call the button
 * is disabled, says why, and the meter reads the call's analyser instead of
 * opening anything. `inCall` comes from the voice controller's status
 * (`lib/in-call-state.ts`), which a static render always reads as false.
 *
 * Atalhos links to `openSection("voice", "ptt")`. The target has to exist in
 * both input modes, or the link lands nowhere for half of the people.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let host: HTMLElement | null = null;
let getUserMedia: ReturnType<typeof vi.fn>;

const MIC = { deviceId: "mic-1", label: "USB mic" };

/** Enough of an AnalyserNode for the meter's frame loop. */
function fakeAnalyser(): AnalyserNode {
  return {
    frequencyBinCount: 4,
    getByteFrequencyData: () => undefined,
  } as unknown as AnalyserNode;
}

async function mount({
  settings = defaultLocalSettings,
  voiceAnalyser = null,
  inputs = [MIC],
  outputs = [],
  cameras = [],
  devicesError = null,
  devicesLoaded = true,
  patchLocal = () => undefined,
  onRevealCameras = () => undefined,
}: {
  settings?: LocalSettings;
  voiceAnalyser?: AnalyserNode | null;
  inputs?: { deviceId: string; label: string }[];
  outputs?: { deviceId: string; label: string }[];
  cameras?: { deviceId: string; label: string }[];
  devicesError?: string | null;
  devicesLoaded?: boolean;
  patchLocal?: (partial: Partial<LocalSettings>) => void;
  onRevealCameras?: (alreadyGranted?: boolean) => void;
} = {}) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const ui = (draft: LocalSettings) => (
    <TooltipProvider>
      <VoiceSection
        draftLocal={draft}
        patchLocal={patchLocal}
        inputs={inputs}
        outputs={outputs}
        cameras={cameras}
        onRevealCameras={onRevealCameras}
        devicesError={devicesError}
        devicesLoaded={devicesLoaded}
        voiceAnalyser={voiceAnalyser}
        metering
        showVoiceCleanBadge={false}
      />
    </TooltipProvider>
  );
  rerender = async (draft) => {
    await act(async () => {
      root!.render(ui(draft));
    });
  };
  await rerender(settings);
  return host;
}

/** Renders the section again with new settings, as the shell does on a patch. */
let rerender: (settings: LocalSettings) => Promise<void>;

function micTestButton(): HTMLButtonElement {
  return host!.querySelector<HTMLButtonElement>("[data-mic-test]")!;
}

/**
 * A button that does nothing right now but keeps its place in the tab order,
 * so a keyboard user who has it focused is not dropped onto the page.
 */
function isInert(button: HTMLButtonElement): boolean {
  return button.getAttribute("aria-disabled") === "true" && !button.disabled;
}

// Radix's Slider measures its thumb; jsdom has no layout to observe.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

beforeEach(() => {
  // A capture that never answers: enough to count who asked for one.
  getUserMedia = vi.fn(() => new Promise<MediaStream>(() => undefined));
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  setInCall(false);
});

describe("VoiceSection mic test", () => {
  it("is enabled outside a call", async () => {
    await mount();
    expect(micTestButton().disabled).toBe(false);
  });

  it("is disabled in a call, and the row says why", async () => {
    setInCall(true);
    await mount({ voiceAnalyser: fakeAnalyser() });
    const button = micTestButton();
    expect(isInert(button)).toBe(true);
    const row = button.closest("[data-settings-row]")!;
    expect(row.textContent).toMatch(/fora da call|outside a call|fuera de una llamada/);
  });

  it("opens no capture in a call: the meter reads the call's analyser", async () => {
    setInCall(true);
    await mount({ voiceAnalyser: fakeAnalyser() });
    await act(async () => {
      micTestButton().click();
    });
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("is disabled for a listen-only join, which has a call and no analyser", async () => {
    setInCall(true);
    await mount();
    expect(isInert(micTestButton())).toBe(true);
  });

  it("stops a running test when a call starts", async () => {
    await mount();
    const label = () =>
      micTestButton().querySelector("span > span:not([aria-hidden])")!.textContent;
    const idle = label();
    await act(async () => {
      micTestButton().click();
    });
    // The meter's preview and the test's own capture.
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(label()).not.toBe(idle);
    await act(async () => {
      setInCall(true);
    });
    expect(isInert(micTestButton())).toBe(true);
    expect(label()).toBe(idle);
    // Stopped by the call, not failed: no error status under the row.
    expect(host!.querySelector('[role="alert"]')).toBeNull();
  });
});

describe("VoiceSection ptt target", () => {
  it("is the input-mode group while voice activity is selected", async () => {
    await mount({
      settings: { ...defaultLocalSettings, inputMode: "voice-activity" },
    });
    const targets = host!.querySelectorAll('[data-settings-row="ptt"]');
    expect(targets).toHaveLength(1);
    expect(targets[0]!.tagName).toBe("SECTION");
    expect(targets[0]!.querySelector('[role="radiogroup"]')).not.toBeNull();
  });

  it("is the key row while push-to-talk is selected", async () => {
    await mount({
      settings: { ...defaultLocalSettings, inputMode: "push-to-talk" },
    });
    const targets = host!.querySelectorAll('[data-settings-row="ptt"]');
    expect(targets).toHaveLength(1);
    expect(targets[0]!.tagName).not.toBe("SECTION");
    expect(targets[0]!.querySelector('[role="radiogroup"]')).toBeNull();
  });

  it("gives each input mode card its own description", async () => {
    await mount();
    const radios = host!.querySelectorAll('[role="radiogroup"] [role="radio"]');
    expect(radios).toHaveLength(2);
    const descriptions = [...radios].map(
      (radio) =>
        document.getElementById(radio.getAttribute("aria-describedby") ?? "")
          ?.textContent ?? "",
    );
    expect(descriptions[0]).not.toBe("");
    expect(descriptions[1]).not.toBe("");
    expect(descriptions[0]).not.toBe(descriptions[1]);
  });
});

/* ------------------------------------------------------------------ helpers */

/** A microphone and a camera that open, and an audio graph that does nothing. */
function installWorkingMedia() {
  const tracks: { stop: ReturnType<typeof vi.fn> }[] = [];
  const open = vi.fn(async (_constraints?: MediaStreamConstraints) => {
    const track = { stop: vi.fn(), applyConstraints: vi.fn(async () => undefined) };
    tracks.push(track);
    return {
      getTracks: () => [track],
      getAudioTracks: () => [track],
    } as unknown as MediaStream;
  });
  const node = () => ({ connect: () => undefined, disconnect: () => undefined });
  class FakeContext {
    createAnalyser = () => ({
      fftSize: 0,
      frequencyBinCount: 4,
      getByteFrequencyData: () => undefined,
      ...node(),
    });
    createMediaStreamSource = () => node();
    createGain = () => ({ gain: { value: 1 }, ...node() });
    createMediaStreamDestination = () => ({ stream: {}, ...node() });
    close = async () => undefined;
  }
  vi.stubGlobal("AudioContext", FakeContext);
  getUserMedia = open;
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: open },
  });
  return { open, tracks };
}

function visibleLabel(button: HTMLElement): string {
  return button.querySelector("span > span:not([aria-hidden])")!.textContent ?? "";
}

function buttonByText(pattern: RegExp): HTMLButtonElement | undefined {
  return [...host!.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
    pattern.test(b.textContent ?? ""),
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

/* ------------------------------------------------------------ mic test timing */

describe("VoiceSection mic test timing", () => {
  it("says how long it plays and why to wear headphones", async () => {
    await mount();
    expect(visibleLabel(micTestButton())).toMatch(/\(5 s\)/);
    expect(host!.textContent).toMatch(
      /headphones.*(5 seconds)|fones.*(5 segundos)|auriculares.*(5 segundos)/i,
    );
  });

  it("counts down on the button once the microphone is playing, then ends by itself", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    installWorkingMedia();
    await mount();
    const idle = visibleLabel(micTestButton());
    await act(async () => {
      micTestButton().click();
    });
    expect(visibleLabel(micTestButton())).toMatch(/· 5 s$/);
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(visibleLabel(micTestButton())).toMatch(/· 4 s$/);
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(visibleLabel(micTestButton())).toMatch(/· 3 s$/);
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(visibleLabel(micTestButton())).toBe(idle);
  });

  it("closes the meter's own capture while the test plays", async () => {
    const { open, tracks } = installWorkingMedia();
    await mount();
    expect(open).toHaveBeenCalledTimes(1);
    const meterTrack = tracks[0]!;
    expect(meterTrack.stop).not.toHaveBeenCalled();
    await act(async () => {
      micTestButton().click();
    });
    expect(meterTrack.stop).toHaveBeenCalled();
    // The bar reads the test's own loop meanwhile: no third capture.
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("does not count while the permission prompt is still open", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    await mount();
    await act(async () => {
      micTestButton().click();
    });
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(visibleLabel(micTestButton())).not.toMatch(/\d s$/);
  });

  it("keeps both stop buttons secondary, so only one primary can ever show", async () => {
    await mount();
    expect(micTestButton().className).not.toMatch(/bg-accent/);
  });
});

/* ------------------------------------------------------- permission blocked */

describe("VoiceSection with the microphone blocked", () => {
  const blockedProps = {
    inputs: [],
    devicesLoaded: false,
    devicesError: "Needs the microphone to list devices.",
  };

  it("keeps the notice when another app still holds the microphone", async () => {
    getUserMedia = vi.fn(async () => {
      throw Object.assign(new Error("busy"), { name: "NotReadableError" });
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia, enumerateDevices: async () => [] },
    });
    await mount(blockedProps);
    await act(async () => {
      host!.querySelector<HTMLButtonElement>("[data-allow-microphone]")!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(getUserMedia).toHaveBeenCalled();
    expect(host!.querySelector("[data-allow-microphone]")).not.toBeNull();
  });

  it("offers a button and the padlock steps, and hides the device list", async () => {
    await mount(blockedProps);
    expect(host!.querySelector("[data-allow-microphone]")).not.toBeNull();
    expect(host!.querySelector("[data-mic-test]")).toBeNull();
    expect(host!.textContent).toMatch(/lock|candado|cadeado/i);
    expect(host!.textContent).toContain("Needs the microphone to list devices.");
  });

  it("greys out the sensitivity meter instead of showing a dead bar", async () => {
    await mount(blockedProps);
    expect(
      host!.querySelector('[role="slider"][aria-label="Sensitivity"]'),
    ).toBeNull();
    expect(host!.querySelector("[data-sensitivity-grabber]")).toBeNull();
    const row = host!.querySelector('[data-settings-row="sensitivity"]')!;
    expect(row.textContent).toMatch(/Allow the microphone|Libere o microfone|Permite el micrófono/);
  });

  it("asks on the click, and recovers on its own when the person allows it", async () => {
    const { open } = installWorkingMedia();
    Object.defineProperty(navigator.mediaDevices, "enumerateDevices", {
      configurable: true,
      value: async () => [
        { kind: "audioinput", deviceId: "mic-9", label: "Yeti Nano" },
      ],
    });
    await mount(blockedProps);
    // Blocked: the meter has not opened anything behind the button's back.
    expect(open).not.toHaveBeenCalled();
    const allow = host!.querySelector<HTMLButtonElement>("[data-allow-microphone]")!;
    allow.focus();
    await act(async () => {
      allow.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(open).toHaveBeenCalled();
    expect(host!.querySelector("[data-allow-microphone]")).toBeNull();
    // The pressed button went with its notice: the keyboard lands on the
    // microphone select, not on the page.
    expect(document.activeElement).toBe(
      host!.querySelector('[data-settings-row="input-device"] select'),
    );
    const options = [...host!.querySelectorAll("option")].map((o) => o.textContent);
    expect(options).toContain("Yeti Nano");
    expect(
      host!.querySelector('[role="slider"][aria-label="Sensitivity"]'),
    ).not.toBeNull();
  });

  it("stays blocked when the browser says no", async () => {
    vi.stubGlobal("AudioContext", class {});
    getUserMedia = vi.fn(async () => {
      throw new Error("denied");
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
    await mount(blockedProps);
    await act(async () => {
      host!.querySelector<HTMLButtonElement>("[data-allow-microphone]")!.click();
    });
    expect(host!.querySelector("[data-allow-microphone]")).not.toBeNull();
    expect(
      (host!.querySelector("[data-allow-microphone]") as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});

/* ------------------------------------------------------------- sensitivity */

describe("VoiceSection sensitivity", () => {
  it("has a visible grabber and tells a screen reader where the mic opens", async () => {
    await mount();
    expect(host!.querySelector("[data-sensitivity-grabber]")).not.toBeNull();
    const thumb = host!.querySelector('[role="slider"][aria-label="Sensitivity"]')!;
    expect(thumb.getAttribute("aria-valuetext")).toMatch(
      /^(Opens above|Abre acima de|Se abre por encima del) \d+%/,
    );
    // The same words are on screen, between the two ends of the bar.
    expect(
      host!.querySelector('[data-settings-row="sensitivity"]')!.textContent,
    ).toMatch(/(Opens above|Abre acima de|Se abre por encima de) \d+%/);
  });

  it("tells you what to do", async () => {
    await mount();
    expect(
      host!.querySelector('[data-settings-row="sensitivity"]')!.textContent,
    ).toMatch(/Drag the line|Arraste a linha|Arrastra la línea/);
  });
});

/* ------------------------------------------------------------------ volumes */

describe("VoiceSection volumes", () => {
  it("marks 100% on the input volume and warns about going over it", async () => {
    await mount();
    const row = host!.querySelector('[data-settings-row="input-volume"]')!;
    expect(row.querySelector("[data-volume-tick]")).not.toBeNull();
    expect(row.textContent).toMatch(/100%/);
    expect(row.textContent).toMatch(/distort|distorcer|distorsionar/);
    expect(
      host!.querySelector('[data-settings-row="output-volume"] [data-volume-tick]'),
    ).toBeNull();
  });

  it("gives both volume sliders a 40px touch strip", async () => {
    await mount();
    for (const id of ["input-volume", "output-volume"]) {
      const slider = host!.querySelector(`[data-settings-row="${id}"] [data-slider]`)!;
      expect(slider.className).toContain("h-10");
      expect(slider.className).not.toContain("h-4");
    }
  });

  it("says the microphone is silent at 0%, and only then", async () => {
    await mount();
    expect(host!.querySelector('[data-settings-row="input-volume"] [role="status"]')).toBeNull();
    act(() => root?.unmount());
    host?.remove();
    await mount({ settings: { ...defaultLocalSettings, inputVolume: 0 } });
    const status = host!.querySelector('[data-settings-row="input-volume"] [role="status"]');
    expect(status?.textContent).toMatch(/silent|sem som|sin sonido/);
  });
});

/* ------------------------------------------------------------------ devices */

describe("VoiceSection device lists", () => {
  it("merges the browser's default entry into 'System default (name)'", async () => {
    await mount({
      inputs: [
        { deviceId: "default", label: "Default - MacBook Pro Microphone" },
        { deviceId: "mic-1", label: "MacBook Pro Microphone" },
      ],
    });
    const select = host!.querySelector<HTMLSelectElement>(
      '[data-settings-row="input-device"] select',
    )!;
    const options = [...select.options].map((o) => [o.value, o.textContent]);
    expect(options).toHaveLength(2);
    expect(options[0]![0]).toBe("");
    expect(options[0]![1]).toMatch(/\(MacBook Pro Microphone\)$/);
    expect(options.some(([value]) => value === "default")).toBe(false);
  });

  it("shows a saved 'default' id as the system default", async () => {
    await mount({
      settings: { ...defaultLocalSettings, inputDeviceId: "default" },
      inputs: [
        { deviceId: "default", label: "Default - Mic" },
        { deviceId: "mic-1", label: "Mic" },
      ],
    });
    const select = host!.querySelector<HTMLSelectElement>(
      '[data-settings-row="input-device"] select',
    )!;
    expect(select.value).toBe("");
    expect(host!.textContent).not.toMatch(/not found|não encontrad|no encontrad/);
  });

  it("says when the saved microphone is gone, by name when it was seen before", async () => {
    window.localStorage.setItem(
      "pqp:voice:device-labels",
      JSON.stringify({ input: { id: "yeti", label: "Yeti Nano" } }),
    );
    await mount({
      settings: { ...defaultLocalSettings, inputDeviceId: "yeti" },
    });
    expect(
      host!.querySelector('[data-settings-row="input-device"]')!.textContent,
    ).toMatch(/Yeti Nano.*(not found|não encontrado|no encontrado)/);
  });

  it("says it without a name when it never saw the device", async () => {
    await mount({
      settings: { ...defaultLocalSettings, inputDeviceId: "yeti" },
    });
    expect(
      host!.querySelector('[data-settings-row="input-device"]')!.textContent,
    ).toMatch(/saved microphone|microfone salvo|micrófono guardado/);
  });

  it("opens the default microphone for the meter when the saved one is gone", async () => {
    await mount({
      settings: { ...defaultLocalSettings, inputDeviceId: "yeti" },
    });
    const asked = getUserMedia.mock.calls.map(
      (call) => (call as [MediaStreamConstraints])[0],
    );
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((c) => c.audio === true)).toBe(true);
  });

  it("keeps the gone device selected, so picking the default is a real change", async () => {
    const patchLocal = vi.fn();
    await mount({
      settings: { ...defaultLocalSettings, inputDeviceId: "yeti" },
      patchLocal,
    });
    const select = host!.querySelector<HTMLSelectElement>(
      '[data-settings-row="input-device"] select',
    )!;
    expect(select.value).toBe("yeti");
    expect(select.selectedOptions[0]!.disabled).toBe(true);
    await act(async () => {
      select.value = "";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(patchLocal).toHaveBeenCalledWith({ inputDeviceId: "" });
  });

  it("stays quiet while the list has not been read", async () => {
    await mount({
      settings: { ...defaultLocalSettings, inputDeviceId: "yeti" },
      devicesLoaded: false,
    });
    expect(host!.textContent).not.toMatch(/not found|não encontrad|no encontrad/);
  });

  it("remembers the name of the saved device while it is connected", async () => {
    await mount({
      settings: { ...defaultLocalSettings, inputDeviceId: "mic-1" },
    });
    expect(window.localStorage.getItem("pqp:voice:device-labels")).toContain("USB mic");
  });
});

/* --------------------------------------------------------------- noise hints */

describe("VoiceSection sound processing", () => {
  it("explains the chosen option in one line, each option differently", async () => {
    const hints = new Set<string>();
    for (const noiseSuppression of ["off", "browser", "advanced"] as const) {
      await mount({
        settings: {
          ...defaultLocalSettings,
          micProcessing: { ...defaultLocalSettings.micProcessing, noiseSuppression },
        },
      });
      hints.add(
        host!.querySelector('[data-settings-row="noise-suppression"] p')!.textContent ?? "",
      );
      act(() => root?.unmount());
      host?.remove();
    }
    expect(hints.size).toBe(3);
    expect(hints.has("")).toBe(false);
  });
});

/* -------------------------------------------------------------- push-to-talk */

describe("VoiceSection push-to-talk key", () => {
  const ptt = (key: Partial<LocalSettings["pushToTalkKey"]>): LocalSettings => ({
    ...defaultLocalSettings,
    inputMode: "push-to-talk",
    pushToTalkKey: { ...defaultLocalSettings.pushToTalkKey, ...key },
  });
  const keyButton = () =>
    host!.querySelector<HTMLButtonElement>("[data-key-binding-field]")!;

  it("warns about a lone modifier, and not about an F key", async () => {
    await mount({ settings: ptt({ code: "ControlLeft", label: "Left Ctrl" }) });
    expect(host!.textContent).toMatch(/alone opens the mic|sozinho abre o mic|solo abre el micro/);
    act(() => root?.unmount());
    host?.remove();
    await mount({ settings: ptt({ code: "F13", label: "F13" }) });
    expect(host!.textContent).not.toMatch(/alone opens the mic|sozinho abre o mic|solo abre el micro/);
  });

  it("recommends an F key in the hint", async () => {
    await mount({ settings: ptt({}) });
    expect(
      host!.querySelector('[data-settings-row="ptt"]')!.textContent,
    ).toMatch(/F key|tecla F/);
  });

  it("draws the stock key with the name the keyboard layout gives it", async () => {
    Object.defineProperty(navigator, "keyboard", {
      configurable: true,
      value: {
        getLayoutMap: async () => ({ get: () => "'" }),
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      },
    });
    await mount({ settings: ptt({}) });
    expect(keyButton().textContent).toContain("'");
    expect(keyButton().textContent).not.toContain("`");
    Reflect.deleteProperty(navigator, "keyboard");
  });

  it("survives a keyboard object that is not an event target (Chromium's)", async () => {
    Object.defineProperty(navigator, "keyboard", {
      configurable: true,
      value: { getLayoutMap: async () => ({ get: () => "'" }) },
    });
    await mount({ settings: ptt({}) });
    expect(keyButton().textContent).toContain("'");
    Reflect.deleteProperty(navigator, "keyboard");
  });

  it("names the refused combo, and leaves the old key on the button", async () => {
    const patch = vi.fn();
    await mount({ settings: ptt({}), patchLocal: patch });
    await act(async () => {
      keyButton().click();
    });
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { code: "ArrowUp", key: "ArrowUp", altKey: true }),
      );
    });
    expect(patch).not.toHaveBeenCalled();
    // The old key stays drawn, dimmed, beside the prompt.
    expect(keyButton().textContent).toContain("`");
    const alert = host!.querySelector('[data-settings-row="ptt"] [role="alert"]');
    expect(alert?.textContent).toMatch(/(already|já é|ya es)/);
    // Clicking the key again disarms it with no stale message.
    await act(async () => {
      keyButton().click();
    });
    expect(keyButton().getAttribute("aria-pressed")).toBe("false");
    expect(host!.querySelector('[data-settings-row="ptt"] [role="alert"]')).toBeNull();
  });

  it("stays armed after a conflict, as the Atalhos fields do, and binds the next free key", async () => {
    const patch = vi.fn();
    await mount({ settings: ptt({}), patchLocal: patch });
    await act(async () => {
      keyButton().click();
    });
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { code: "ArrowUp", key: "ArrowUp", altKey: true }),
      );
    });
    expect(keyButton().getAttribute("aria-pressed")).toBe("true");
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { code: "F9", key: "F9" }));
    });
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith(
      expect.objectContaining({
        pushToTalkKey: expect.objectContaining({ code: "F9" }),
      }),
    );
  });

  it("names a lone modifier for this keyboard and language, whatever label was saved", async () => {
    await mount({ settings: ptt({ code: "MetaLeft", label: "Left Cmd" }) });
    // jsdom is not an Apple platform: the Windows key, not Cmd.
    expect(keyButton().textContent).not.toContain("Cmd");
    expect(keyButton().textContent).toMatch(/Win/);
    expect(keyButton().textContent).toMatch(/Left Win|Win esquerdo|Win izquierdo/);
  });

  it("binds a free key", async () => {
    const patch = vi.fn();
    await mount({ settings: ptt({}), patchLocal: patch });
    await act(async () => {
      keyButton().click();
    });
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { code: "F9", key: "F9" }));
    });
    expect(patch).toHaveBeenCalledWith(
      expect.objectContaining({
        pushToTalkKey: expect.objectContaining({ code: "F9" }),
      }),
    );
  });

  it("calls the beep button 'Hear the beep', not 'Test'", async () => {
    await mount({ settings: ptt({}) });
    expect(buttonByText(/Hear the beep|Ouvir o bipe|Escuchar el pitido/)).toBeDefined();
  });
});

/* -------------------------------------------------------------------- camera */

describe("VoiceSection camera test", () => {
  it("opens a private preview and closes it on the second press", async () => {
    const { open, tracks } = installWorkingMedia();
    const reveal = vi.fn();
    await mount({ onRevealCameras: reveal });
    const button = host!.querySelector<HTMLButtonElement>("[data-camera-test]")!;
    await act(async () => {
      button.click();
    });
    const asked = open.mock.calls.map((call) => call[0] as MediaStreamConstraints);
    expect(asked.some((c) => c.video && c.audio === false)).toBe(true);
    expect(host!.querySelector("video")).not.toBeNull();
    expect(host!.textContent).toMatch(/Only you see this|Só você vê isso|Solo tú ves esto/);
    // The preview already holds the camera: the list is re-read without a
    // second capture, which Safari answers by muting the first.
    expect(reveal).toHaveBeenCalledWith(true);
    const stopsBefore = tracks.filter((t) => t.stop.mock.calls.length > 0).length;
    await act(async () => {
      button.click();
    });
    expect(host!.querySelector("video")).toBeNull();
    expect(tracks.filter((t) => t.stop.mock.calls.length > 0).length).toBeGreaterThan(
      stopsBefore,
    );
  });

  it("is disabled in a call, and says why", async () => {
    setInCall(true);
    await mount({ voiceAnalyser: fakeAnalyser() });
    const button = host!.querySelector<HTMLButtonElement>("[data-camera-test]")!;
    expect(isInert(button)).toBe(true);
    expect(
      host!.querySelector('[data-settings-row="camera"]')!.textContent,
    ).toMatch(/outside a call|fora da call|fuera de una llamada/);
  });

  it("says so when the camera cannot be opened", async () => {
    vi.stubGlobal("AudioContext", class {});
    getUserMedia = vi.fn(async (c: MediaStreamConstraints) => {
      if (c.video) {
        throw new Error("denied");
      }
      return { getTracks: () => [], getAudioTracks: () => [] } as unknown as MediaStream;
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
    await mount();
    await act(async () => {
      host!.querySelector<HTMLButtonElement>("[data-camera-test]")!.click();
    });
    expect(host!.querySelector("video")).toBeNull();
    expect(
      host!.querySelector('[data-settings-row="camera"] [role="alert"]'),
    ).not.toBeNull();
  });
});

/* ------------------------------------------------------------- video + call */

describe("VoiceSection copy", () => {
  it("names what the video quality covers, and uses plain words for the frame rate", async () => {
    await mount();
    expect(
      host!.querySelector('[data-settings-row="video-quality"]')!.textContent,
    ).toMatch(/camera and screen|câmera e tela|cámara y pantalla/);
    expect(
      host!.querySelector('[data-settings-row="screen-frame-rate"]')!.textContent,
    ).not.toMatch(/FPS/);
  });

  it("describes every switch in the call group", async () => {
    await mount();
    const says = (id: string) =>
      host!.querySelector(`[data-settings-row="${id}"]`)!.textContent ?? "";
    expect(says("mute-on-join")).toMatch(/push.to.talk/i);
    expect(says("compact-peers")).toMatch(/avatar/i);
    expect(says("music-auto-join")).toMatch(/whether to listen|se quer ouvir|si quieres escuchar/);
    expect(says("music-duck")).toMatch(/drops while|baixa enquanto|baja mientras/);
  });
});

/* ---------------------------------------------------- QA round 3, Voz e vídeo */

describe("VoiceSection allowing the microphone", () => {
  const blockedProps = {
    inputs: [],
    devicesLoaded: false,
    devicesError: "Needs the microphone to list devices.",
  };

  it("moves focus to the select as soon as it is on the page, not on a timer", async () => {
    // Timers never fire here. The old refocus waited for a zero-delay timer
    // that could run before React had drawn the select.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    installWorkingMedia();
    Object.defineProperty(navigator.mediaDevices, "enumerateDevices", {
      configurable: true,
      value: async () => [{ kind: "audioinput", deviceId: "mic-9", label: "Yeti Nano" }],
    });
    await mount(blockedProps);
    const allow = host!.querySelector<HTMLButtonElement>("[data-allow-microphone]")!;
    allow.focus();
    await act(async () => {
      allow.click();
    });
    expect(host!.querySelector("[data-allow-microphone]")).toBeNull();
    expect(document.activeElement).toBe(
      host!.querySelector('[data-settings-row="input-device"] select'),
    );
  });

  it("says there is no microphone, instead of asking again, when the machine has none", async () => {
    getUserMedia = vi.fn(async () => {
      throw new DOMException("Requested device not found", "NotFoundError");
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia, enumerateDevices: async () => [] },
    });
    await mount(blockedProps);
    await act(async () => {
      host!.querySelector<HTMLButtonElement>("[data-allow-microphone]")!.click();
    });
    expect(host!.querySelector("[data-allow-microphone]")).toBeNull();
    expect(
      host!.querySelector('[data-settings-row="input-device"]')!.textContent,
    ).toMatch(/No microphone found|Nenhum microfone encontrado|No se encontró/);
  });
});

describe("VoiceSection with no microphone", () => {
  it("greys the sensitivity meter out and says to plug one in", async () => {
    await mount({ inputs: [] });
    expect(
      host!.querySelector('[role="slider"][aria-label="Sensitivity"]'),
    ).toBeNull();
    expect(host!.querySelector("[data-sensitivity-grabber]")).toBeNull();
    expect(
      host!.querySelector('[data-settings-row="sensitivity"]')!.textContent,
    ).toMatch(/Plug in a microphone|Conecte um microfone|Conecta un micrófono/);
  });
});

describe("VoiceSection sensitivity range", () => {
  const thumb = () =>
    host!.querySelector('[role="slider"][aria-label="Sensitivity"]')!;

  it("ends where the line can really go: 54 at 30% input volume", async () => {
    await mount({ settings: { ...defaultLocalSettings, inputVolume: 0.3 } });
    expect(thumb().getAttribute("aria-valuemax")).toBe("54");
  });

  it("reaches 100 once the volume is high enough to fill the bar", async () => {
    await mount({ settings: { ...defaultLocalSettings, inputVolume: 1 } });
    expect(thumb().getAttribute("aria-valuemax")).toBe("100");
  });
});

describe("VoiceSection beep row", () => {
  it("says why the test button does nothing while app sounds are off", async () => {
    setSoundEnabled(false);
    try {
      await mount({
        settings: { ...defaultLocalSettings, inputMode: "push-to-talk", pttBeep: true },
      });
      const row = host!.querySelector('[data-settings-row="ptt-beep"]')!;
      expect(row.textContent).toMatch(/sounds are off|sons do app estão desligados|sonidos de la app/);
      expect(buttonByText(/Hear the beep|Ouvir o bipe|Escuchar el pitido/)!.disabled).toBe(true);
    } finally {
      setSoundEnabled(true);
    }
  });
});

describe("VoiceSection tests when a call starts", () => {
  it("keeps focus on the mic test button", async () => {
    await mount();
    micTestButton().focus();
    await act(async () => {
      setInCall(true);
    });
    expect(document.activeElement).toBe(micTestButton());
    await act(async () => {
      micTestButton().click();
    });
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("keeps focus on the camera test button, and opens no camera", async () => {
    await mount();
    const button = host!.querySelector<HTMLButtonElement>("[data-camera-test]")!;
    button.focus();
    await act(async () => {
      setInCall(true);
    });
    expect(document.activeElement).toBe(button);
    await act(async () => {
      button.click();
    });
    expect(host!.querySelector("video")).toBeNull();
  });
});

describe("VoiceSection mic test follows the settings", () => {
  it("opens the microphone again when the sound processing changes mid-test", async () => {
    const { open } = installWorkingMedia();
    await mount();
    await act(async () => {
      micTestButton().click();
    });
    // The meter's preview, then the test's own capture.
    expect(open).toHaveBeenCalledTimes(2);
    await rerender({
      ...defaultLocalSettings,
      micProcessing: { ...defaultLocalSettings.micProcessing, echoCancellation: false },
    });
    expect(open).toHaveBeenCalledTimes(3);
    expect(open.mock.calls[2]![0]).toMatchObject({
      audio: { echoCancellation: false },
    });
  });

  it("does not restart for a volume change, which the running loop takes live", async () => {
    const { open } = installWorkingMedia();
    await mount();
    await act(async () => {
      micTestButton().click();
    });
    await rerender({ ...defaultLocalSettings, inputVolume: 0.5, outputVolume: 0.2 });
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("does not open a capture for a processing change when nothing is playing", async () => {
    const { open } = installWorkingMedia();
    await mount();
    const before = open.mock.calls.length;
    await rerender({
      ...defaultLocalSettings,
      micProcessing: { ...defaultLocalSettings.micProcessing, autoGainControl: false },
    });
    expect(open.mock.calls.length).toBe(before);
  });
});

describe("VoiceSection push-to-talk key shared with a shortcut", () => {
  it("warns when a shortcut took the key while push-to-talk was off", async () => {
    const key = {
      code: "KeyK",
      label: "K",
      ctrl: false,
      alt: false,
      shift: false,
      meta: false,
      device: "keyboard" as const,
    };
    await mount({
      settings: {
        ...defaultLocalSettings,
        inputMode: "push-to-talk",
        pushToTalkKey: key,
        shortcuts: { ...defaultLocalSettings.shortcuts, toggleMute: key },
      },
    });
    expect(host!.querySelector('[data-settings-row="ptt"]')?.parentElement?.textContent).toMatch(
      /already the shortcut for|já é o atalho de|ya es el atajo de/,
    );
  });
});

describe("VoiceSection mic test running flag", () => {
  it("clears the flag when the test is stopped by hand and when Voz goes away", async () => {
    installWorkingMedia();
    await mount();
    await act(async () => {
      micTestButton().click();
    });
    expect(isMicTestRunning()).toBe(true);
    await act(async () => {
      micTestButton().click();
    });
    expect(isMicTestRunning()).toBe(false);

    await act(async () => {
      micTestButton().click();
    });
    expect(isMicTestRunning()).toBe(true);
    act(() => root?.unmount());
    root = null;
    expect(isMicTestRunning()).toBe(false);
  });
});
