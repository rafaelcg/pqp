// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceNotesGroup } from "@/components/settings/voice-notes-group";
import { SettingsSectionContext } from "@/components/settings/kit/sections";
import { resetSettingsRowsForTest } from "@/components/settings/kit/registry";
import {
  adoptVoiceTranscription,
  getVoiceTranscription,
  markTranscriptionAvailable,
  resetTranscriptionAvailableForTests,
  resetVoiceTranscriptionForTests,
} from "@/lib/voice-transcription-prefs";

const updatePreferences = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  updatePreferences,
}));
const loadVoiceTranscriptionEnabled = vi.hoisted(() => vi.fn());
vi.mock("@/lib/attachments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/attachments")>()),
  loadVoiceTranscriptionEnabled,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;

async function mount() {
  await act(async () => {
    root.render(
      <SettingsSectionContext.Provider value="privacy">
        <VoiceNotesGroup />
      </SettingsSectionContext.Provider>,
    );
  });
}

function switchByLabel(label: string): HTMLElement {
  const found = [...host.querySelectorAll<HTMLElement>('[role="switch"]')].find((one) =>
    one.textContent?.includes(label),
  );
  if (!found) {
    throw new Error(`no switch "${label}"`);
  }
  return found;
}

beforeEach(() => {
  resetVoiceTranscriptionForTests();
  resetTranscriptionAvailableForTests();
  resetSettingsRowsForTest();
  updatePreferences.mockReset().mockResolvedValue({ preferences: {} });
  loadVoiceTranscriptionEnabled.mockReset().mockResolvedValue(true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("VoiceNotesGroup", () => {
  it("has both switches on by default", async () => {
    await mount();
    expect(switchByLabel("Transcribe my voice messages").getAttribute("aria-checked")).toBe("true");
    expect(switchByLabel("Show transcripts").getAttribute("aria-checked")).toBe("true");
  });

  it("turns off 'mine' and sends BOTH halves, because the preference is replaced whole", async () => {
    await mount();
    await act(async () => {
      switchByLabel("Transcribe my voice messages").click();
    });
    expect(getVoiceTranscription()).toEqual({ mine: false, show: true });
    expect(updatePreferences).toHaveBeenCalledWith({
      voiceTranscription: { mine: false, show: true },
    });
    expect(switchByLabel("Transcribe my voice messages").getAttribute("aria-checked")).toBe("false");
  });

  it("turns off 'show' without touching 'mine'", async () => {
    await mount();
    await act(async () => {
      switchByLabel("Show transcripts").click();
    });
    expect(updatePreferences).toHaveBeenLastCalledWith({
      voiceTranscription: { mine: true, show: false },
    });
  });

  it("follows the account when it says something else", async () => {
    await mount();
    await act(async () => {
      adoptVoiceTranscription({ voiceTranscription: { mine: false, show: false } });
    });
    expect(switchByLabel("Show transcripts").getAttribute("aria-checked")).toBe("false");
    // Adopting never writes back.
    expect(updatePreferences).not.toHaveBeenCalled();
  });

  it("is not drawn where transcription does not exist", async () => {
    loadVoiceTranscriptionEnabled.mockResolvedValue(false);
    await mount();
    expect(host.textContent).toBe("");
  });

  it("is drawn when a note elsewhere showed that transcription exists", async () => {
    loadVoiceTranscriptionEnabled.mockResolvedValue(false);
    await mount();
    await act(async () => {
      markTranscriptionAvailable();
    });
    expect(host.textContent).toContain("Voice messages");
  });
});
