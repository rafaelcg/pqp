// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceNoteTranscript } from "@pqp/shared";
import { VoiceNoteTranscriptLine } from "@/components/chat/voice-note-transcript";
import {
  applyVoiceNoteTranscript,
  resetVoiceNoteTranscriptsForTests,
} from "@/lib/voice-note-transcript";
import {
  resetVoiceTranscriptionForTests,
  setVoiceTranscription,
} from "@/lib/voice-transcription-prefs";

const requestVoiceNoteTranscript = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  requestVoiceNoteTranscript,
  updatePreferences: vi.fn(() => Promise.resolve({ preferences: {} })),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;

function mount(base: VoiceNoteTranscript | undefined, isMine = false) {
  act(() => {
    root.render(<VoiceNoteTranscriptLine attachmentId="a-1" base={base} isMine={isMine} />);
  });
}

beforeEach(() => {
  resetVoiceNoteTranscriptsForTests();
  resetVoiceTranscriptionForTests();
  requestVoiceNoteTranscript.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("VoiceNoteTranscriptLine", () => {
  it("draws nothing when the read had no transcript block", () => {
    mount(undefined);
    expect(host.textContent).toBe("");
  });

  it("draws the text of a finished transcript", () => {
    mount({ status: "done", text: "oi, tudo bem?" });
    expect(host.textContent).toContain("oi, tudo bem?");
    expect(host.querySelector("button")).toBeNull();
  });

  it("offers show more only for a long text, and toggles it", () => {
    mount({ status: "done", text: "palavra ".repeat(60) });
    const button = host.querySelector("button")!;
    expect(button.textContent).toBe("show more");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    act(() => button.click());
    expect(host.querySelector("button")!.textContent).toBe("show less");
    expect(host.querySelector("p")!.className).not.toContain("line-clamp-2");
  });

  it("shows a quiet line while pending", () => {
    mount({ status: "pending" });
    expect(host.querySelector('[data-voice-note-transcript="pending"]')).not.toBeNull();
  });

  it("says little when there was no speech, and nothing when unavailable", () => {
    mount({ status: "no_speech" });
    expect(host.querySelector('[data-voice-note-transcript="no_speech"]')).not.toBeNull();
    mount({ status: "unavailable" });
    expect(host.textContent).toBe("");
  });

  it("offers Transcribe on a note nobody has asked for, once, and turns it into pending", async () => {
    let resolve!: (value: unknown) => void;
    requestVoiceNoteTranscript.mockReturnValue(new Promise((r) => (resolve = r)));
    mount({ status: "none" });
    const button = host.querySelector("button")!;
    expect(button.textContent).toBe("Transcribe");
    await act(async () => {
      button.click();
    });
    expect(host.querySelector('[data-voice-note-transcript="pending"]')).not.toBeNull();
    expect(requestVoiceNoteTranscript).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolve({ transcript: { status: "pending" } });
    });
    await act(async () => {
      applyVoiceNoteTranscript({
        type: "voice-note-transcript",
        channelId: "c",
        messageId: "m",
        attachmentId: "a-1",
        transcript: { status: "done", text: "chegou pelo frame" },
      });
    });
    expect(host.textContent).toContain("chegou pelo frame");
  });

  it("does not offer the button on your own note", () => {
    mount({ status: "none" }, true);
    expect(host.textContent).toBe("");
  });

  it("hides the button for good after a 403", async () => {
    const { ApiError } = await import("@/lib/api");
    requestVoiceNoteTranscript.mockRejectedValue(new ApiError(403, "no"));
    mount({ status: "none" });
    await act(async () => {
      host.querySelector("button")!.click();
    });
    expect(host.textContent).toBe("");
  });

  it("draws nothing at all when the reader turned transcripts off", () => {
    setVoiceTranscription({ show: false });
    mount({ status: "done", text: "oi" });
    expect(host.textContent).toBe("");
    mount({ status: "none" });
    expect(host.textContent).toBe("");
  });
});
