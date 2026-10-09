import { describe, expect, it } from "vitest";
import {
  attachmentFilenameSchema,
  attachmentSchema,
  createAttachmentSchema,
  DEFAULT_MAX_ATTACHMENT_BYTES,
  formatNoteDuration,
  isImageContentType,
  isVoiceNoteContentType,
  noteByteBudget,
  VOICE_NOTE_MAX_DURATION_MS,
  VOICE_NOTE_MIN_DURATION_MS,
  VOICE_NOTE_WAVEFORM_MAX_LENGTH,
  VOICE_NOTE_WAVEFORM_PEAKS,
} from "./attachments.js";
import { chatClientMessageSchema, messageCreateMessageSchema } from "./chat.js";

const CHANNEL_ID = "00000000-0000-4000-8000-000000000002";
const ATTACHMENT_ID = "00000000-0000-4000-8000-000000000009";

describe("createAttachmentSchema", () => {
  const base = {
    filename: "cat.png",
    contentType: "image/png",
    byteSize: 1024,
  };

  it("accepts a plausible mint request", () => {
    expect(createAttachmentSchema.safeParse(base).success).toBe(true);
  });

  it("rejects a content type that is not on the allowlist", () => {
    // The allowlist exists so nothing that executes script can ever be served
    // from our own origin — SVG and HTML are documents, not media.
    expect(
      createAttachmentSchema.safeParse({
        ...base,
        contentType: "image/svg+xml",
      }).success,
    ).toBe(false);
    expect(
      createAttachmentSchema.safeParse({ ...base, contentType: "text/html" })
        .success,
    ).toBe(false);
    expect(
      createAttachmentSchema.safeParse({
        ...base,
        contentType: "application/octet-stream",
      }).success,
    ).toBe(false);
  });

  it("rejects a size outside the protocol ceiling", () => {
    expect(
      createAttachmentSchema.safeParse({
        ...base,
        byteSize: DEFAULT_MAX_ATTACHMENT_BYTES,
      }).success,
    ).toBe(true);
    expect(
      createAttachmentSchema.safeParse({
        ...base,
        byteSize: DEFAULT_MAX_ATTACHMENT_BYTES + 1,
      }).success,
    ).toBe(false);
    expect(createAttachmentSchema.safeParse({ ...base, byteSize: 0 }).success).toBe(
      false,
    );
  });
});

describe("voice notes", () => {
  const waveform = btoa(
    String.fromCharCode(...new Array<number>(VOICE_NOTE_WAVEFORM_PEAKS).fill(128)),
  );
  const note = {
    filename: "voice.webm",
    contentType: "audio/webm",
    byteSize: 40_000,
    voice: { durationMs: 12_000, waveform },
  };

  it("accepts a note in each recorder container", () => {
    for (const contentType of ["audio/mp4", "audio/webm", "audio/ogg"]) {
      expect(createAttachmentSchema.safeParse({ ...note, contentType }).success).toBe(
        true,
      );
    }
  });

  it("allows mp4 and webm audio as ordinary attachments too", () => {
    for (const contentType of ["audio/mp4", "audio/webm"]) {
      expect(
        createAttachmentSchema.safeParse({ filename: "a", contentType, byteSize: 10 })
          .success,
      ).toBe(true);
    }
  });

  it("refuses a voice block on a type a recorder never produces", () => {
    for (const contentType of ["audio/mpeg", "audio/wav", "video/webm", "image/png"]) {
      expect(createAttachmentSchema.safeParse({ ...note, contentType }).success).toBe(
        false,
      );
    }
  });

  it("refuses a parameterised content type, which the claim HEAD would never match", () => {
    expect(
      createAttachmentSchema.safeParse({ ...note, contentType: "audio/webm;codecs=opus" })
        .success,
    ).toBe(false);
  });

  it("bounds the duration at 300 ms and five minutes", () => {
    const at = (durationMs: number) =>
      createAttachmentSchema.safeParse({ ...note, voice: { durationMs, waveform } }).success;
    expect(at(VOICE_NOTE_MIN_DURATION_MS)).toBe(true);
    expect(at(VOICE_NOTE_MIN_DURATION_MS - 1)).toBe(false);
    expect(at(VOICE_NOTE_MAX_DURATION_MS)).toBe(true);
    expect(at(VOICE_NOTE_MAX_DURATION_MS + 1)).toBe(false);
    expect(at(1500.5)).toBe(false);
  });

  it("takes exactly 64 peaks of base64, nothing shorter or longer", () => {
    const withWave = (value: string) =>
      createAttachmentSchema.safeParse({ ...note, voice: { durationMs: 1000, waveform: value } })
        .success;
    const peaks = (count: number) =>
      btoa(String.fromCharCode(...new Array<number>(count).fill(7)));
    expect(waveform).toHaveLength(88);
    expect(waveform.length).toBeLessThanOrEqual(VOICE_NOTE_WAVEFORM_MAX_LENGTH);
    expect(withWave(waveform)).toBe(true);
    expect(withWave(peaks(63))).toBe(false);
    expect(withWave(peaks(65))).toBe(false);
    expect(withWave(peaks(96))).toBe(false);
    expect(withWave("A".repeat(VOICE_NOTE_WAVEFORM_MAX_LENGTH))).toBe(false);
    expect(withWave("")).toBe(false);
    expect(withWave(`${"!".repeat(86)}==`)).toBe(false);
  });

  it("budgets 16 KiB a started second plus 32 KiB", () => {
    expect(noteByteBudget(300)).toBe(16 * 1024 + 32 * 1024);
    expect(noteByteBudget(1000)).toBe(16 * 1024 + 32 * 1024);
    expect(noteByteBudget(1001)).toBe(2 * 16 * 1024 + 32 * 1024);
    expect(noteByteBudget(VOICE_NOTE_MAX_DURATION_MS)).toBe(300 * 16 * 1024 + 32 * 1024);
    // The longest note fits under the protocol ceiling, so the budget, not
    // the global cap, is what refuses an inflated one.
    expect(noteByteBudget(VOICE_NOTE_MAX_DURATION_MS)).toBeLessThan(
      DEFAULT_MAX_ATTACHMENT_BYTES,
    );
  });

  it("formats a duration the way the card and the push show it", () => {
    expect(formatNoteDuration(12_000)).toBe("0:12");
    expect(formatNoteDuration(12_400)).toBe("0:12");
    expect(formatNoteDuration(300)).toBe("0:01");
    expect(formatNoteDuration(65_000)).toBe("1:05");
    expect(formatNoteDuration(VOICE_NOTE_MAX_DURATION_MS)).toBe("5:00");
  });

  it("reads a stored note with or without the later fields", () => {
    const stored = {
      id: ATTACHMENT_ID,
      filename: "voice.webm",
      contentType: "audio/webm",
      byteSize: 40_000,
      width: null,
      height: null,
      url: "https://storage.test/x",
    };
    expect(attachmentSchema.safeParse(stored).success).toBe(true);
    expect(
      attachmentSchema.safeParse({ ...stored, voice: { durationMs: 12_000, waveform } })
        .success,
    ).toBe(true);
    expect(
      attachmentSchema.safeParse({
        ...stored,
        voice: {
          durationMs: 12_000,
          waveform,
          listenedByMe: true,
          listenedBy: [ATTACHMENT_ID],
          transcript: { status: "done", text: "oi", language: "pt" },
        },
      }).success,
    ).toBe(true);
    expect(isVoiceNoteContentType("audio/mp4")).toBe(true);
    expect(isVoiceNoteContentType("audio/mpeg")).toBe(false);
  });
});

describe("attachmentFilenameSchema", () => {
  it("accepts an ordinary filename, spaces and unicode included", () => {
    expect(attachmentFilenameSchema.safeParse("holiday photo.jpeg").success).toBe(
      true,
    );
    expect(attachmentFilenameSchema.safeParse("répertoire — 2026.pdf").success).toBe(
      true,
    );
  });

  it("rejects path separators", () => {
    // A filename is display text. It never reaches a storage key, and this is
    // the check that keeps it that way if someone later reaches for it.
    expect(attachmentFilenameSchema.safeParse("../../etc/passwd").success).toBe(
      false,
    );
    expect(attachmentFilenameSchema.safeParse("dir/file.png").success).toBe(false);
    expect(attachmentFilenameSchema.safeParse("dir\\file.png").success).toBe(false);
  });

  it("rejects control characters", () => {
    // CR and LF in a Content-Disposition filename is header injection; NUL is
    // rejected by Postgres at the driver level.
    expect(
      attachmentFilenameSchema.safeParse("a\r\nX-Evil: 1").success,
    ).toBe(false);
    expect(
      attachmentFilenameSchema.safeParse(`nul${String.fromCharCode(0)}.png`)
        .success,
    ).toBe(false);
    expect(
      attachmentFilenameSchema.safeParse(`del${String.fromCharCode(127)}.png`)
        .success,
    ).toBe(false);
  });

  it("rejects an empty or oversized name", () => {
    expect(attachmentFilenameSchema.safeParse("").success).toBe(false);
    expect(attachmentFilenameSchema.safeParse(`${"x".repeat(256)}`).success).toBe(
      false,
    );
  });
});

describe("isImageContentType", () => {
  it("is true for the types the client may put in an img", () => {
    expect(isImageContentType("image/png")).toBe(true);
    expect(isImageContentType("IMAGE/WEBP")).toBe(true);
  });

  it("is false for everything else, SVG included", () => {
    // A prefix test on "image/" would render this inline, and an SVG runs
    // script in whatever origin serves it.
    expect(isImageContentType("image/svg+xml")).toBe(false);
    expect(isImageContentType("application/pdf")).toBe(false);
    expect(isImageContentType("video/mp4")).toBe(false);
  });
});

describe("message-create emptiness rule", () => {
  const base = {
    type: "message-create" as const,
    channelId: CHANNEL_ID,
  };

  it("rejects an empty body with no attachments", () => {
    expect(
      messageCreateMessageSchema.safeParse({ ...base, body: "" }).success,
    ).toBe(false);
    expect(
      messageCreateMessageSchema.safeParse({
        ...base,
        body: "",
        attachmentIds: [],
      }).success,
    ).toBe(false);
  });

  it("accepts an empty body when attachments carry the message", () => {
    expect(
      messageCreateMessageSchema.safeParse({
        ...base,
        body: "",
        attachmentIds: [ATTACHMENT_ID],
      }).success,
    ).toBe(true);
  });

  it("still accepts a plain text message", () => {
    expect(
      messageCreateMessageSchema.safeParse({ ...base, body: "hi" }).success,
    ).toBe(true);
  });

  it("caps the number of attachments and requires ids to be uuids", () => {
    expect(
      messageCreateMessageSchema.safeParse({
        ...base,
        body: "",
        attachmentIds: Array.from({ length: 11 }, () => ATTACHMENT_ID),
      }).success,
    ).toBe(false);
    expect(
      messageCreateMessageSchema.safeParse({
        ...base,
        body: "",
        attachmentIds: ["not-a-uuid"],
      }).success,
    ).toBe(false);
  });

  it("enforces the same rule through the union the server parses with", () => {
    // The refinement cannot live inside a discriminatedUnion option, so it is
    // re-applied to the union. If that ever falls off, every empty message a
    // client sends is stored.
    expect(
      chatClientMessageSchema.safeParse({ ...base, body: "" }).success,
    ).toBe(false);
    expect(
      chatClientMessageSchema.safeParse({
        ...base,
        body: "",
        attachmentIds: [ATTACHMENT_ID],
      }).success,
    ).toBe(true);
  });

  it("still rejects control characters in a body", () => {
    expect(
      messageCreateMessageSchema.safeParse({
        ...base,
        body: `bad${String.fromCharCode(0)}`,
      }).success,
    ).toBe(false);
  });
});
