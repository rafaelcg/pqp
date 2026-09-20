import { afterEach, describe, expect, it } from "vitest";
import {
  notePush,
  pushDeliverySnapshot,
  resetPushMetrics,
} from "./push-metrics.js";

afterEach(() => {
  resetPushMetrics();
});

describe("push-metrics", () => {
  it("starts at zero for every platform and outcome", () => {
    expect(pushDeliverySnapshot()).toEqual({
      web: { sent: 0, failed: 0, pruned: 0 },
      apns: { sent: 0, failed: 0, pruned: 0 },
      fcm: { sent: 0, failed: 0, pruned: 0 },
    });
  });

  it("counts each outcome against the right platform, cumulatively", () => {
    notePush("web", "sent");
    notePush("web", "sent");
    notePush("web", "failed");
    notePush("apns", "pruned");
    notePush("fcm", "sent");
    notePush("fcm", "failed");

    expect(pushDeliverySnapshot()).toEqual({
      web: { sent: 2, failed: 1, pruned: 0 },
      apns: { sent: 0, failed: 0, pruned: 1 },
      fcm: { sent: 1, failed: 1, pruned: 0 },
    });
  });

  it("reset clears every count", () => {
    notePush("web", "sent");
    resetPushMetrics();
    expect(pushDeliverySnapshot().web.sent).toBe(0);
  });
});
