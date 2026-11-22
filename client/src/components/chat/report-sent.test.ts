import { REPORT_REASONS } from "@pqp/shared";
import { describe, expect, it } from "vitest";
import { reportReasonKey } from "@/lib/report-reasons";
import { sentToPqp } from "./report-dialog";

describe("sentToPqp", () => {
  it("names the server staff for an ordinary report filed in a server", () => {
    expect(sentToPqp({ reason: "spam", subjectType: "message", contextKind: "server" })).toBe(false);
  });

  it("names the pqp team for a minor, a conversation, no place or a community", () => {
    expect(sentToPqp({ reason: "minor_sexual", subjectType: "message", contextKind: "server" })).toBe(true);
    expect(sentToPqp({ reason: "spam", subjectType: "message", contextKind: "dm" })).toBe(true);
    expect(sentToPqp({ reason: "spam", subjectType: "user", contextKind: "none" })).toBe(true);
    expect(sentToPqp({ reason: "spam", subjectType: "server", contextKind: "server" })).toBe(true);
  });
});

describe("reportReasonKey", () => {
  it("has a translated name for every stored reason", () => {
    for (const reason of REPORT_REASONS) {
      expect(reportReasonKey(reason)).toBe(`report.reason.${reason}`);
    }
  });
});
