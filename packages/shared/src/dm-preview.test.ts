import { describe, expect, it } from "vitest";
import {
  buildMessagePreview,
  stripMarkdownForPreview,
  truncatePreview,
} from "./dm-preview.js";

describe("stripMarkdownForPreview", () => {
  it("strips bold, italic, strikethrough and inline code", () => {
    expect(stripMarkdownForPreview("**bora** hoje à *noite*?")).toBe(
      "bora hoje à noite?",
    );
    expect(stripMarkdownForPreview("~~cancelado~~ confirmado")).toBe(
      "cancelado confirmado",
    );
    expect(stripMarkdownForPreview("roda `npm install` primeiro")).toBe(
      "roda npm install primeiro",
    );
  });

  it("keeps a link's label and drops the URL", () => {
    expect(
      stripMarkdownForPreview("olha [esse mapa](https://example.com/x)"),
    ).toBe("olha esse mapa");
  });

  it("strips a blockquote marker", () => {
    expect(stripMarkdownForPreview("> cita isso\nresposta")).toBe(
      "cita isso resposta",
    );
  });

  it("collapses newlines and runs of whitespace to one space", () => {
    expect(stripMarkdownForPreview("linha 1\n\nlinha   2\t\tfim")).toBe(
      "linha 1 linha 2 fim",
    );
  });

  it("never touches an @mention — already plain text in this codebase", () => {
    expect(stripMarkdownForPreview("oi @rafa tudo bem?")).toBe(
      "oi @rafa tudo bem?",
    );
  });

  it("trims leading and trailing whitespace", () => {
    expect(stripMarkdownForPreview("   oi   ")).toBe("oi");
  });
});

describe("truncatePreview", () => {
  it("passes short text through unchanged", () => {
    expect(truncatePreview("bora hoje?")).toBe("bora hoje?");
  });

  it("caps at 140 chars with a trailing ellipsis", () => {
    const long = "a".repeat(200);
    const truncated = truncatePreview(long);
    expect(truncated.length).toBe(140);
    expect(truncated.endsWith("…")).toBe(true);
    expect(truncated.slice(0, 139)).toBe("a".repeat(139));
  });

  it("does not add an ellipsis to text exactly at the cap", () => {
    const exact = "a".repeat(140);
    expect(truncatePreview(exact)).toBe(exact);
  });
});

describe("buildMessagePreview", () => {
  it("returns the stripped, truncated body for ordinary text", () => {
    const result = buildMessagePreview({
      body: "**bora** hoje?",
      hasAttachments: false,
    });
    expect(result).toEqual({
      preview: "bora hoje?",
      isAttachment: false,
      isGif: false,
      isVoice: false,
      voiceDurationMs: null,
    });
  });

  it("an attachment-only message (empty body) yields empty preview + isAttachment", () => {
    const result = buildMessagePreview({
      body: "",
      hasAttachments: true,
    });
    expect(result).toEqual({
      preview: "",
      isAttachment: true,
      isGif: false,
      isVoice: false,
      voiceDurationMs: null,
    });
  });

  it("a body that is only markdown noise (e.g. an empty bold pair) still counts as attachment-only", () => {
    const result = buildMessagePreview({
      body: "   ",
      hasAttachments: true,
    });
    expect(result.isAttachment).toBe(true);
    expect(result.preview).toBe("");
  });

  it("flags a GIF attachment separately from a generic file", () => {
    const gif = buildMessagePreview({
      body: "",
      hasAttachments: true,
      isGifAttachment: true,
    });
    expect(gif).toEqual({ preview: "", isAttachment: true, isGif: true, isVoice: false, voiceDurationMs: null });

    const file = buildMessagePreview({
      body: "",
      hasAttachments: true,
      isGifAttachment: false,
    });
    expect(file).toEqual({ preview: "", isAttachment: true, isGif: false, isVoice: false, voiceDurationMs: null });
  });

  it("a caption alongside an attachment is real text, not the attachment label", () => {
    const result = buildMessagePreview({
      body: "olha essa foto",
      hasAttachments: true,
    });
    expect(result).toEqual({
      preview: "olha essa foto",
      isAttachment: false,
      isGif: false,
      isVoice: false,
      voiceDurationMs: null,
    });
  });

  it("marks a voice note and carries its duration", () => {
    expect(
      buildMessagePreview({ body: "", hasAttachments: true, voiceDurationMs: 12_400 }),
    ).toEqual({
      preview: "",
      isAttachment: true,
      isGif: false,
      isVoice: true,
      voiceDurationMs: 12_400,
    });
  });

  it("a duration on a message with text is not a voice note", () => {
    const result = buildMessagePreview({
      body: "oi",
      hasAttachments: true,
      voiceDurationMs: 12_400,
    });
    expect(result.isVoice).toBe(false);
    expect(result.voiceDurationMs).toBeNull();
  });

  it("truncates to 140 chars end to end", () => {
    const result = buildMessagePreview({
      body: "a".repeat(200),
      hasAttachments: false,
    });
    expect(result.preview.length).toBe(140);
  });
});
