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

  it("app-ended carries a small object result, and a bad one reads as none", () => {
    const frame = (result: unknown) =>
      chatServerMessageSchema.safeParse({
        type: "app-ended",
        sessionId: uuid,
        channelId: uuid,
        reason: "host",
        summary: { participants: 2, durationSeconds: 90, result },
      });
    const ok = frame({ winner: "a" });
    expect(ok.success && ok.data.type === "app-ended" && ok.data.summary.result).toEqual({ winner: "a" });
    for (const bad of [[1], "x", 3, { blob: "x".repeat(600) }]) {
      const parsed = frame(bad);
      expect(parsed.success).toBe(true);
      expect(parsed.success && parsed.data.type === "app-ended" && parsed.data.summary.result).toBeUndefined();
    }
  });
});
