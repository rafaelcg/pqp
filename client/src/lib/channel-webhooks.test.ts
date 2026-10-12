import { describe, expect, it } from "vitest";
import { channelTakesWebhooks } from "./channel-webhooks";

describe("channelTakesWebhooks", () => {
  it("is text and forum, the two types the API accepts a webhook on", () => {
    expect(channelTakesWebhooks("text")).toBe(true);
    expect(channelTakesWebhooks("forum")).toBe(true);
    for (const type of ["voice", "watch_party", "category", "thread", null, undefined]) {
      expect(channelTakesWebhooks(type)).toBe(false);
    }
  });
});
