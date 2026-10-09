import type { VoiceNoteTranscript } from "@pqp/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import {
  MAX_STORED_TRANSCRIPTS,
  RECHECK_AFTER_MS,
  RECHECK_LIMIT,
  SLOW_DOWN_MS,
  applyVoiceNoteTranscript,
  getStoredTranscript,
  isVoiceNoteTranscriptFrame,
  isVoiceNoteUpdatedFrame,
  requestTranscript,
  resetVoiceNoteTranscriptsForTests,
  resolveTranscript,
} from "./voice-note-transcript";

const requestVoiceNoteTranscript = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  requestVoiceNoteTranscript,
}));

const ID = "a-1";

function frame(status: string, text: string | null = null) {
  return {
    type: "voice-note-transcript" as const,
    channelId: "c-1",
    messageId: "m-1",
    attachmentId: ID,
    transcript: { status: status as VoiceNoteTranscript["status"], text, language: "pt" },
  };
}

beforeEach(() => {
  resetVoiceNoteTranscriptsForTests();
  requestVoiceNoteTranscript.mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("frame guards", () => {
  it("accepts a transcript frame and rejects a malformed one", () => {
    expect(isVoiceNoteTranscriptFrame(frame("done", "oi"))).toBe(true);
    expect(isVoiceNoteTranscriptFrame(frame("shrug"))).toBe(false);
    expect(isVoiceNoteTranscriptFrame({ type: "voice-note-transcript", attachmentId: ID })).toBe(false);
    expect(isVoiceNoteTranscriptFrame(null)).toBe(false);
    expect(isVoiceNoteTranscriptFrame({ ...frame("done"), type: "voice-note-listened" })).toBe(false);
  });

  it("accepts an updated frame", () => {
    expect(
      isVoiceNoteUpdatedFrame({
        type: "voice-note-updated",
        channelId: "c",
        messageId: "m",
        attachmentId: ID,
        playbackReady: true,
      }),
    ).toBe(true);
    expect(isVoiceNoteUpdatedFrame({ type: "voice-note-updated" })).toBe(false);
  });
});

describe("the frame reducer", () => {
  it("stores what a frame says, replacing pending with done", () => {
    applyVoiceNoteTranscript(frame("pending"));
    expect(getStoredTranscript(ID)?.status).toBe("pending");
    applyVoiceNoteTranscript(frame("done", "oi, tudo bem?"));
    expect(getStoredTranscript(ID)).toMatchObject({ status: "done", text: "oi, tudo bem?" });
  });

  it("is keyed by attachment, so another note is untouched", () => {
    applyVoiceNoteTranscript(frame("done", "um"));
    expect(getStoredTranscript("a-2")).toBeUndefined();
  });
});

describe("resolveTranscript", () => {
  const none = { status: "none" as const };
  const pending = { status: "pending" as const };
  const done = { status: "done" as const, text: "oi" };

  it("draws nothing without a base, whatever a frame said", () => {
    expect(resolveTranscript(undefined, done)).toBeUndefined();
  });

  it("uses the base until something newer arrives", () => {
    expect(resolveTranscript(none, undefined)).toBe(none);
    expect(resolveTranscript(none, pending)).toBe(pending);
    expect(resolveTranscript(pending, done)).toBe(done);
  });

  it("lets a finished read beat a pending the tab is still holding", () => {
    expect(resolveTranscript(done, pending)).toBe(done);
  });

  it("lets a new request show over an old unavailable", () => {
    const unavailable = { status: "unavailable" as const };
    expect(resolveTranscript(unavailable, pending)).toBe(pending);
  });
});

describe("requestTranscript", () => {
  it("sends one request however many times it is pressed", async () => {
    let resolve!: (value: unknown) => void;
    requestVoiceNoteTranscript.mockReturnValue(new Promise((r) => (resolve = r)));
    const first = requestTranscript(ID);
    const second = requestTranscript(ID);
    void requestTranscript(ID);
    expect(requestVoiceNoteTranscript).toHaveBeenCalledTimes(1);
    expect(getStoredTranscript(ID)?.status).toBe("pending");
    resolve({ transcript: { status: "done", text: "oi" } });
    await Promise.all([first, second]);
    expect(getStoredTranscript(ID)).toMatchObject({ status: "done", text: "oi" });
  });

  it("keeps pending on a 202 and lets the frame finish it", async () => {
    requestVoiceNoteTranscript.mockResolvedValue({ transcript: { status: "pending" } });
    await requestTranscript(ID);
    expect(getStoredTranscript(ID)?.status).toBe("pending");
    applyVoiceNoteTranscript(frame("done", "chegou"));
    expect(getStoredTranscript(ID)?.text).toBe("chegou");
  });

  it("takes the stored answer on a 200", async () => {
    requestVoiceNoteTranscript.mockResolvedValue({
      transcript: { status: "no_speech", text: null },
    });
    await requestTranscript(ID);
    expect(getStoredTranscript(ID)?.status).toBe("no_speech");
  });

  it("goes back to the button on a 403 and on a 404", async () => {
    requestVoiceNoteTranscript.mockRejectedValue(new ApiError(403, "no"));
    await requestTranscript(ID);
    expect(getStoredTranscript(ID)).toBeUndefined();
    requestVoiceNoteTranscript.mockRejectedValue(new ApiError(404, "gone"));
    await requestTranscript("a-2");
    expect(getStoredTranscript("a-2")).toBeUndefined();
  });

  it("goes back to the button on a 429, and may be asked again", async () => {
    requestVoiceNoteTranscript.mockRejectedValueOnce(new ApiError(429, "slow"));
    await requestTranscript(ID);
    expect(getStoredTranscript(ID)).toBeUndefined();
    vi.advanceTimersByTime(SLOW_DOWN_MS + 1);
    requestVoiceNoteTranscript.mockResolvedValueOnce({ transcript: { status: "pending" } });
    await requestTranscript(ID);
    expect(requestVoiceNoteTranscript).toHaveBeenCalledTimes(2);
    expect(getStoredTranscript(ID)?.status).toBe("pending");
  });

  it("does not leave a note pending when the request never got through", async () => {
    requestVoiceNoteTranscript.mockRejectedValue(new Error("offline"));
    await requestTranscript(ID);
    expect(getStoredTranscript(ID)).toBeUndefined();
  });

  it("asks again later when a pending answer's frame never comes, a few times at most", async () => {
    requestVoiceNoteTranscript.mockResolvedValue({ transcript: { status: "pending" } });
    await requestTranscript(ID);
    for (let i = 0; i < RECHECK_LIMIT + 3; i += 1) {
      await vi.advanceTimersByTimeAsync(RECHECK_AFTER_MS + 1);
    }
    expect(requestVoiceNoteTranscript).toHaveBeenCalledTimes(1 + RECHECK_LIMIT);
  });

  it("stops asking once the frame arrives", async () => {
    requestVoiceNoteTranscript.mockResolvedValue({ transcript: { status: "pending" } });
    await requestTranscript(ID);
    applyVoiceNoteTranscript(frame("done", "oi"));
    await vi.advanceTimersByTimeAsync(RECHECK_AFTER_MS * 3);
    expect(requestVoiceNoteTranscript).toHaveBeenCalledTimes(1);
  });

  it("stops showing 'transcribing' once the rechecks run out", async () => {
    requestVoiceNoteTranscript.mockResolvedValue({ transcript: { status: "pending" } });
    await requestTranscript(ID);
    for (let i = 0; i < RECHECK_LIMIT + 2; i += 1) {
      await vi.advanceTimersByTimeAsync(RECHECK_AFTER_MS + 1);
    }
    expect(getStoredTranscript(ID)).toBeUndefined();
  });

  it("drops the pending note when a recheck is refused", async () => {
    requestVoiceNoteTranscript.mockResolvedValueOnce({ transcript: { status: "pending" } });
    await requestTranscript(ID);
    requestVoiceNoteTranscript.mockRejectedValueOnce(new ApiError(403, "no"));
    await vi.advanceTimersByTimeAsync(RECHECK_AFTER_MS + 1);
    expect(getStoredTranscript(ID)).toBeUndefined();
  });

  it("keeps trying through the limiter instead of abandoning the note", async () => {
    requestVoiceNoteTranscript.mockResolvedValueOnce({ transcript: { status: "pending" } });
    await requestTranscript(ID);
    requestVoiceNoteTranscript.mockRejectedValueOnce(new ApiError(429, "slow"));
    await vi.advanceTimersByTimeAsync(RECHECK_AFTER_MS + 1);
    expect(getStoredTranscript(ID)?.status).toBe("pending");
    requestVoiceNoteTranscript.mockResolvedValueOnce({
      transcript: { status: "done", text: "saiu" },
    });
    await vi.advanceTimersByTimeAsync(RECHECK_AFTER_MS + 1);
    expect(getStoredTranscript(ID)?.text).toBe("saiu");
  });

  it("does not let a late 202 undo a transcript the frame already delivered", async () => {
    let resolve!: (value: unknown) => void;
    requestVoiceNoteTranscript.mockReturnValue(new Promise((r) => (resolve = r)));
    const asked = requestTranscript(ID);
    applyVoiceNoteTranscript(frame("done", "rápido"));
    resolve({ transcript: { status: "pending" } });
    await asked;
    expect(getStoredTranscript(ID)).toMatchObject({ status: "done", text: "rápido" });
    await vi.advanceTimersByTimeAsync(RECHECK_AFTER_MS * 3);
    expect(requestVoiceNoteTranscript).toHaveBeenCalledTimes(1);
  });
});

describe("the cache", () => {
  it("is bounded, and drops the oldest first", () => {
    for (let i = 0; i < MAX_STORED_TRANSCRIPTS + 25; i += 1) {
      applyVoiceNoteTranscript({ ...frame("done", `n${i}`), attachmentId: `n-${i}` });
    }
    expect(getStoredTranscript("n-0")).toBeUndefined();
    expect(getStoredTranscript(`n-${MAX_STORED_TRANSCRIPTS + 24}`)?.text).toBe(
      `n${MAX_STORED_TRANSCRIPTS + 24}`,
    );
  });
});
