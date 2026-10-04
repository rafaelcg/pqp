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
}: {
  settings?: LocalSettings;
  voiceAnalyser?: AnalyserNode | null;
} = {}) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <TooltipProvider>
        <VoiceSection
          draftLocal={settings}
          patchLocal={() => undefined}
          inputs={[MIC]}
          outputs={[]}
          cameras={[]}
          onRevealCameras={() => undefined}
          devicesError={null}
          devicesLoaded
          voiceAnalyser={voiceAnalyser}
          metering
          showVoiceCleanBadge={false}
        />
      </TooltipProvider>,
    );
  });
  return host;
}

function micTestButton(): HTMLButtonElement {
  return host!.querySelector<HTMLButtonElement>("[data-mic-test]")!;
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
    expect(button.disabled).toBe(true);
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
    expect(micTestButton().disabled).toBe(true);
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
    expect(micTestButton().disabled).toBe(true);
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
