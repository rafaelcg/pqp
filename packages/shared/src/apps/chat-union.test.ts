import { describe, expect, it } from "vitest";
import { CHAT_SERVER_MESSAGE_TYPES, chatServerMessageSchema } from "../chat.js";
import { messageSystemKindSchema } from "../nudge.js";

const uuid = "11111111-1111-4111-8111-111111111111";

describe("the apps frames in the chat server union", () => {
  it("channel-app parses, with a session and with none", () => {
    expect(
      chatServerMessageSchema.safeParse({ type: "channel-app", channelId: uuid, session: null })
        .success,
    ).toBe(true);
    const parsed = chatServerMessageSchema.safeParse({
      type: "channel-app",
      channelId: uuid,
      session: {
        id: uuid,
        appId: "pqp-eco",
        appVersion: "1.0.0",
        startedBy: uuid,
        hostUserId: uuid,
        startedAt: "2026-10-19T12:00:00.000Z",
        participants: [],
        players: 0,
        spectators: 0,
        handoff: null,
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("app-ended parses", () => {
    expect(
      chatServerMessageSchema.safeParse({
        type: "app-ended",
        sessionId: uuid,
        channelId: uuid,
        reason: "host",
        summary: { participants: 2, durationSeconds: 90 },
      }).success,
    ).toBe(true);
  });

  it("neither rides the channel relay: their audience is not the channel's viewers", () => {
    expect(CHAT_SERVER_MESSAGE_TYPES).not.toContain("channel-app");
    expect(CHAT_SERVER_MESSAGE_TYPES).not.toContain("app-ended");
  });

  it("app_session is a message kind an older client reads as an ordinary message", () => {
    expect(messageSystemKindSchema.parse("app_session")).toBe("app_session");
    expect(messageSystemKindSchema.parse("nudge")).toBe("nudge");
    expect(messageSystemKindSchema.parse("a-future-kind")).toBeNull();
  });
});
