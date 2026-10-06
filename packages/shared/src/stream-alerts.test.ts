import { describe, expect, it } from "vitest";
import {
  STREAM_ALERT_DEFAULT_MAX_MEMBERS,
  STREAM_START_CHANNEL_COOLDOWN_MS,
  STREAM_START_STABLE_MS,
  streamAlertDefault,
  streamAlertEnabled,
  streamStartedSchema,
} from "./stream-alerts.js";
import { chatServerMessageSchema, CHAT_SERVER_MESSAGE_TYPES } from "./chat.js";

describe("the default a server gets", () => {
  it("is on for a small server and off for a large one or a community", () => {
    expect(streamAlertDefault({ memberCount: 86, isCommunity: false })).toBe(true);
    expect(
      streamAlertDefault({
        memberCount: STREAM_ALERT_DEFAULT_MAX_MEMBERS,
        isCommunity: false,
      }),
    ).toBe(true);
    expect(
      streamAlertDefault({
        memberCount: STREAM_ALERT_DEFAULT_MAX_MEMBERS + 1,
        isCommunity: false,
      }),
    ).toBe(false);
    // QG do pqp: about 4,000 members and a community.
    expect(streamAlertDefault({ memberCount: 4000, isCommunity: true })).toBe(false);
    expect(streamAlertDefault({ memberCount: 12, isCommunity: true })).toBe(false);
  });

  it("is overruled by the person's own choice either way", () => {
    const big = { memberCount: 4000, isCommunity: true };
    const small = { memberCount: 10, isCommunity: false };
    expect(streamAlertEnabled(true, big)).toBe(true);
    expect(streamAlertEnabled(false, small)).toBe(false);
    expect(streamAlertEnabled(undefined, small)).toBe(true);
    expect(streamAlertEnabled(undefined, big)).toBe(false);
  });

  it("keeps the limits the plan promises", () => {
    expect(STREAM_START_STABLE_MS).toBe(20_000);
    expect(STREAM_START_CHANNEL_COOLDOWN_MS).toBe(30 * 60_000);
  });
});

describe("the stream-started frame", () => {
  const frame = {
    type: "stream-started" as const,
    serverId: "11111111-1111-4111-8111-111111111111",
    channelId: "22222222-2222-4222-8222-222222222222",
    channelName: "filminho",
    serverName: "Filminho",
    sharerName: "Alberto",
    kind: "voice" as const,
    startedAt: 1_700_000_000_000,
  };

  it("parses on the chat socket", () => {
    expect(chatServerMessageSchema.safeParse(frame).success).toBe(true);
    expect(streamStartedSchema.safeParse({ ...frame, kind: "other" }).success).toBe(false);
  });

  it("is addressed per person, so it is never in the per-channel relay list", () => {
    expect(CHAT_SERVER_MESSAGE_TYPES).not.toContain("stream-started");
  });
});
