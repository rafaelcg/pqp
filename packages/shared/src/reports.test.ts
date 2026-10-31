import { describe, expect, it } from "vitest";
import { AUDIT_ACTIONS } from "./audit.js";
import {
  allReportSchema,
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
