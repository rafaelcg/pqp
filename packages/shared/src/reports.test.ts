import { describe, expect, it } from "vitest";
import { AUDIT_ACTIONS } from "./audit.js";
import {
  allReportSchema,
  createReportSchema,
  REPORT_ATTACHMENT_BLOCK_REASONS,
  REPORT_ATTACHMENT_KINDS,
  reportAttachmentRevealSchema,
  reportAttachmentSchema,
  reportSchema,
} from "./reports.js";

const ID = "6b1f3a52-5c0e-4a53-9d0b-3e0f6a1d9a11";

const baseReport = {
  id: "42",
  subjectType: "message",
  contextKind: "server",
  reason: "spam",
  details: null,
  status: "open",
  createdAt: "2026-10-22T12:00:00.000Z",
  reporterId: null,
  reporterName: null,
  reportedUserId: null,
  reportedUserName: null,
  messageId: ID,
  messageDeleted: false,
  contentSnapshot: "",
  channelId: null,
  channelName: null,
  resolvedAt: null,
  resolvedByName: null,
  resolutionNote: null,
};

describe("report attachments", () => {
  it("parses a list entry with the scanner's verdict and the preview decision", () => {
    const entry = reportAttachmentSchema.parse({
      id: ID,
      kind: "gif",
      contentType: "image/gif",
      scan: { status: "pass", provider: "openai", score: 0.02, labels: [] },
      preview: "available",
      blockReason: null,
    });
    expect(entry.kind).toBe("gif");
  });

  it("only knows the four kinds a moderator is shown", () => {
    expect([...REPORT_ATTACHMENT_KINDS]).toEqual(["image", "gif", "video", "file"]);
    expect(() =>
      reportAttachmentSchema.parse({
        id: ID,
        kind: "audio",
        contentType: "audio/ogg",
        scan: { status: "skipped", provider: null, score: null, labels: [] },
        preview: "unsupported",
        blockReason: null,
      }),
    ).toThrow();
  });

  it("names every reason the runbook refuses, and no other", () => {
    expect([...REPORT_ATTACHMENT_BLOCK_REASONS]).toEqual([
      "scan_status",
      "illegal_label",
      "quarantined",
      "minor_report",
    ]);
  });

  it("refuses a preview verdict it does not know", () => {
    expect(() =>
      reportAttachmentSchema.parse({
        id: ID,
        kind: "image",
        contentType: "image/png",
        scan: { status: "pass", provider: null, score: null, labels: [] },
        preview: "maybe",
        blockReason: null,
      }),
    ).toThrow();
  });

  it("defaults a report's attachments to none, so an older payload still parses", () => {
    expect(reportSchema.parse(baseReport).attachments).toEqual([]);
    const all = allReportSchema.parse({
      ...baseReport,
      serverId: null,
      serverName: null,
      scan: null,
    });
    expect(all.attachments).toEqual([]);
  });

  it("requires a real URL and a positive lifetime in a reveal answer", () => {
    expect(
      reportAttachmentRevealSchema.parse({
        url: "https://storage.example/obj?sig=1",
        expiresInSeconds: 60,
      }).expiresInSeconds,
    ).toBe(60);
    expect(() =>
      reportAttachmentRevealSchema.parse({ url: "nope", expiresInSeconds: 60 }),
    ).toThrow();
    expect(() =>
      reportAttachmentRevealSchema.parse({
        url: "https://storage.example/obj",
        expiresInSeconds: 0,
      }),
    ).toThrow();
  });

  it("registers the audit action the reveal writes", () => {
    expect(AUDIT_ACTIONS).toContain("report.attachment_reveal");
  });
});

describe("reporting a Baú post or comment", () => {
  it("accepts the two new kinds with an id and a reason, and nothing about where it goes", () => {
    const post = createReportSchema.parse({
      subjectType: "bau_post",
      postId: ID,
      reason: "spam",
    });
    expect(post.subjectType).toBe("bau_post");
    const comment = createReportSchema.parse({
      subjectType: "bau_comment",
      commentId: ID,
      reason: "minor_sexual",
      details: "texto",
    });
    expect(comment.subjectType).toBe("bau_comment");
    // The client names the thing, never the destination: an unknown key is
    // dropped, not trusted.
    expect(
      createReportSchema.parse({
        subjectType: "bau_post",
        postId: ID,
        serverId: ID,
        reason: "spam",
      }),
    ).not.toHaveProperty("serverId");
  });

  it("rejects a Baú report without its id, or with the wrong one", () => {
    expect(() =>
      createReportSchema.parse({ subjectType: "bau_post", reason: "spam" }),
    ).toThrow();
    expect(() =>
      createReportSchema.parse({
        subjectType: "bau_comment",
        postId: ID,
        reason: "spam",
      }),
    ).toThrow();
    expect(() =>
      createReportSchema.parse({
        subjectType: "bau_post",
        postId: "nope",
        reason: "spam",
      }),
    ).toThrow();
  });

  it("keeps every older kind parsing exactly as before", () => {
    expect(
      createReportSchema.parse({
        subjectType: "message",
        messageId: ID,
        reason: "spam",
      }).subjectType,
    ).toBe("message");
    // An old stored row has neither Baú field: both default to null.
    const parsed = reportSchema.parse(baseReport);
    expect(parsed.bauPostId).toBeNull();
    expect(parsed.bauCommentId).toBeNull();
    expect(
      reportSchema.parse({ ...baseReport, subjectType: "bau_comment", bauPostId: ID })
        .subjectType,
    ).toBe("bau_comment");
  });

  it("registers the audit action the moderator's read writes", () => {
    expect(AUDIT_ACTIONS).toContain("report.bau_view");
  });
});
