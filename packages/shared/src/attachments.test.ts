import { describe, expect, it } from "vitest";
import {
  attachmentFilenameSchema,
  createAttachmentSchema,
  DEFAULT_MAX_ATTACHMENT_BYTES,
  isImageContentType,
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
