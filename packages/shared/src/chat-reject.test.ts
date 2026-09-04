import { describe, expect, it } from "vitest";
import {
  CHAT_SERVER_MESSAGE_TYPES,
  chatServerMessageSchema,
  isChatServerMessage,
  messageRejectedSchema,
} from "./chat.js";

const CHANNEL = "11111111-1111-4111-8111-111111111111";

describe("message-rejected", () => {
  it("is a chat server frame, so a client can route it by name", () => {
    expect(
      chatServerMessageSchema.safeParse({
        type: "message-rejected",
        channelId: CHANNEL,
        nonce: "n1",
        reason: "undeliverable",
      }).success,
    ).toBe(true);
  });

  it("is NOT relayable to a channel", () => {
    expect(CHAT_SERVER_MESSAGE_TYPES).not.toContain("message-rejected");
    expect(isChatServerMessage({ type: "message-rejected" })).toBe(false);
  });

  it("refuses a reason nobody defined", () => {
    expect(
      messageRejectedSchema.safeParse({
        type: "message-rejected",
        channelId: CHANNEL,
        reason: "not-a-reason",
      }).success,
    ).toBe(false);
  });

  it("accepts a slow-mode refusal with a wait", () => {
    const parsed = messageRejectedSchema.parse({
      type: "message-rejected",
      channelId: CHANNEL,
      nonce: "n1",
      reason: "slow-mode",
      retryAfterMs: 5000,
    });
    expect(parsed.reason).toBe("slow-mode");
    expect(parsed.retryAfterMs).toBe(5000);
  });

  it("accepts a rate-limit wait in milliseconds", () => {
    const parsed = messageRejectedSchema.parse({
      type: "message-rejected",
      channelId: CHANNEL,
      nonce: "n1",
      reason: "rate-limited",
      retryAfterMs: 1000,
    });
    expect(parsed.retryAfterMs).toBe(1000);
  });
});
