import { describe, expect, it } from "vitest";
import {
  applyVoiceNoteListened,
  getListened,
  getPlayerState,
  isRetryableListenError,
  nextRate,
  nextUnheardNote,
  parseRate,
  resetVoiceNotePlayerForTests,
  setVoiceNoteViewer,
  type VoiceNoteEntry,
} from "./voice-note-player";

function note(
  id: string,
  createdAt: string,
  extra: Partial<VoiceNoteEntry> = {},
): VoiceNoteEntry {
  return {
    attachmentId: `a-${id}`,
    messageId: `m-${id}`,
    channelId: "dm-1",
    createdAt,
    authorId: "dede",
    authorName: "dede",
    url: `https://storage.test/${id}`,
    durationMs: 5000,
    listenedByMe: false,
    ...extra,
  };
}

describe("nextUnheardNote", () => {
  const playing = note("1", "2026-10-08T21:00:00Z");

  it("moves to the oldest unheard note after the one that ended", () => {
    const later = note("3", "2026-10-08T21:05:00Z");
    const sooner = note("2", "2026-10-08T21:02:00Z");
    expect(nextUnheardNote([later, playing, sooner], playing, "rafa")?.attachmentId).toBe("a-2");
  });

  it("skips what was already heard, my own notes, and anything older", () => {
    const entries = [
      playing,
      note("0", "2026-10-08T20:59:00Z"),
      note("2", "2026-10-08T21:01:00Z", { listenedByMe: true }),
      note("3", "2026-10-08T21:02:00Z", { authorId: "rafa" }),
      note("4", "2026-10-08T21:03:00Z"),
    ];
    expect(nextUnheardNote(entries, playing, "rafa")?.attachmentId).toBe("a-4");
  });

  it("stays in the channel it was playing", () => {
    const elsewhere = note("2", "2026-10-08T21:01:00Z", { channelId: "dm-2" });
    expect(nextUnheardNote([playing, elsewhere], playing, "rafa")).toBeNull();
  });

  it("asks the caller what counts as heard, so this tab's own listens count", () => {
    const next = note("2", "2026-10-08T21:01:00Z");
    const heardHere = new Set(["a-2"]);
    expect(
      nextUnheardNote([playing, next], playing, "rafa", (entry) =>
        entry.listenedByMe || heardHere.has(entry.attachmentId),
      ),
    ).toBeNull();
  });

  it("breaks a tie on time by message id", () => {
    const b = note("b", "2026-10-08T21:01:00Z");
    const a = note("a", "2026-10-08T21:01:00Z");
    expect(nextUnheardNote([b, a, playing], playing, "rafa")?.attachmentId).toBe("a-a");
  });

  it("ends the queue when nothing is left", () => {
    expect(nextUnheardNote([playing], playing, "rafa")).toBeNull();
  });
});

describe("speed pill", () => {
  it("steps 1x, 1.5x, 2x and wraps", () => {
    expect(nextRate(1)).toBe(1.5);
    expect(nextRate(1.5)).toBe(2);
    expect(nextRate(2)).toBe(1);
  });

  it("reads a stored speed and refuses anything else", () => {
    expect(parseRate("1.5")).toBe(1.5);
    expect(parseRate("3")).toBe(1);
    expect(parseRate(null)).toBe(1);
  });
});

describe("account switches", () => {
  const frame = (userId: string) => ({
    type: "voice-note-listened" as const,
    channelId: "dm-1",
    messageId: "m-1",
    attachmentId: "a-1",
    userId,
    listenedAt: "2026-10-08T21:00:00Z",
  });

  it("forgets what the previous account heard", () => {
    resetVoiceNotePlayerForTests();
    setVoiceNoteViewer("alice");
    applyVoiceNoteListened(frame("alice"));
    expect(getListened("a-1")?.me).toBe(true);
    setVoiceNoteViewer("bob");
    expect(getListened("a-1")).toBeUndefined();
    expect(getPlayerState().current).toBeNull();
  });

  it("keeps a receipt from someone else apart from the reader's own dot", () => {
    resetVoiceNotePlayerForTests();
    setVoiceNoteViewer("alice");
    applyVoiceNoteListened(frame("bob"));
    expect(getListened("a-1")?.me).toBe(false);
    expect(getListened("a-1")?.by.get("bob")).toBe("2026-10-08T21:00:00Z");
  });
});

describe("listen report retries", () => {
  it("retries the network and the server, never a refusal", () => {
    expect(isRetryableListenError({ status: 0 })).toBe(true);
    expect(isRetryableListenError({ status: 503 })).toBe(true);
    expect(isRetryableListenError({ status: 429 })).toBe(true);
    expect(isRetryableListenError(new TypeError("offline"))).toBe(true);
    expect(isRetryableListenError({ status: 403 })).toBe(false);
    expect(isRetryableListenError({ status: 404 })).toBe(false);
  });
});
