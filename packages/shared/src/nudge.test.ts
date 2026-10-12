import { describe, expect, it } from "vitest";
import { messageSchema } from "./api.js";
import {
  CHAT_CLIENT_MESSAGE_TYPES,
  CHAT_SERVER_MESSAGE_TYPES,
  chatClientMessageSchema,
  chatServerMessageSchema,
  isChatServerMessage,
} from "./chat.js";
import {
  NUDGE_BODY,
  NUDGE_FRESH_MS,
  isFreshNudge,
  nudgesAllowed,
} from "./nudge.js";

const CHANNEL = "11111111-1111-4111-8111-111111111111";
const ME = "22222222-2222-4222-8222-222222222222";
const LU = "33333333-3333-4333-8333-333333333333";

function message(extra: Record<string, unknown> = {}) {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    channelId: CHANNEL,
    authorId: LU,
    authorName: "Lu",
    authorTag: "lu#0001",
    authorAvatarUrl: null,
    body: NUDGE_BODY,
    createdAt: "2026-10-11T12:00:00.000Z",
    ...extra,
  };
}

describe("the nudge frame", () => {
  it("is a client frame the socket router dispatches", () => {
    expect(CHAT_CLIENT_MESSAGE_TYPES).toContain("nudge");
    expect(
      chatClientMessageSchema.safeParse({ type: "nudge", channelId: CHANNEL, nonce: "n1" })
        .success,
    ).toBe(true);
    expect(chatClientMessageSchema.safeParse({ type: "nudge", channelId: "x" }).success).toBe(
      false,
    );
  });
});

describe("nudge-refused", () => {
  it("is a chat server frame, so a client can route it by name", () => {
    const parsed = chatServerMessageSchema.parse({
      type: "nudge-refused",
      channelId: CHANNEL,
      reason: "cooldown",
      retryAfterMs: 7_000,
    });
    expect(parsed).toMatchObject({ reason: "cooldown", retryAfterMs: 7_000 });
  });

  it("is never relayable to a channel: it is one sender's answer", () => {
    expect(CHAT_SERVER_MESSAGE_TYPES).not.toContain("nudge-refused");
    expect(isChatServerMessage({ type: "nudge-refused" })).toBe(false);
  });

  it("knows exactly five reasons", () => {
    for (const reason of ["cooldown", "unanswered", "busy", "self-off", "unavailable"]) {
      expect(
        chatServerMessageSchema.safeParse({ type: "nudge-refused", channelId: CHANNEL, reason })
          .success,
      ).toBe(true);
    }
    expect(
      chatServerMessageSchema.safeParse({
        type: "nudge-refused",
        channelId: CHANNEL,
        reason: "blocked",
      }).success,
    ).toBe(false);
  });
});

describe("systemKind on a message", () => {
  it("is not a kind when absent, so history from an older API still parses", () => {
    expect(messageSchema.parse(message()).systemKind ?? null).toBeNull();
    expect(messageSchema.parse(message({ systemKind: null })).systemKind).toBeNull();
  });

  it("carries nudge", () => {
    expect(messageSchema.parse(message({ systemKind: "nudge" })).systemKind).toBe("nudge");
  });

  it("reads a kind this build does not know as an ordinary message", () => {
    expect(messageSchema.parse(message({ systemKind: "wink" })).systemKind).toBeNull();
  });

  it("rides the live broadcast too", () => {
    const parsed = chatServerMessageSchema.parse({
      type: "message-broadcast",
      message: message({ systemKind: "nudge" }),
    });
    expect(parsed.type === "message-broadcast" && parsed.message.systemKind).toBe("nudge");
  });

  it("rides channel-activity, and an unknown kind there is dropped, not fatal", () => {
    const base = {
      type: "channel-activity",
      serverId: null,
      kind: "dm",
      channelId: CHANNEL,
      mention: false,
    };
    const nudge = chatServerMessageSchema.parse({ ...base, systemKind: "nudge" });
    expect(nudge.type === "channel-activity" && nudge.systemKind).toBe("nudge");
    const later = chatServerMessageSchema.parse({ ...base, systemKind: "wink" });
    expect(later.type === "channel-activity" && later.systemKind).toBeUndefined();
  });
});

describe("isFreshNudge", () => {
  const now = Date.parse("2026-10-11T12:00:05.000Z");

  it("shakes for a nudge from somebody else that just arrived", () => {
    expect(isFreshNudge(message({ systemKind: "nudge" }), ME, now)).toBe(true);
  });

  it("never for my own", () => {
    expect(isFreshNudge(message({ systemKind: "nudge", authorId: ME }), ME, now)).toBe(false);
  });

  it("never for history", () => {
    const old = new Date(now - NUDGE_FRESH_MS - 1).toISOString();
    expect(isFreshNudge(message({ systemKind: "nudge", createdAt: old }), ME, now)).toBe(false);
  });

  it("never for an ordinary message, even one that says 📳", () => {
    expect(isFreshNudge(message({ systemKind: null }), ME, now)).toBe(false);
  });

  it("never for a timestamp it cannot read", () => {
    expect(isFreshNudge(message({ systemKind: "nudge", createdAt: "soon" }), ME, now)).toBe(
      false,
    );
  });
});

describe("nudgesAllowed", () => {
  it("is on unless turned off", () => {
    expect(nudgesAllowed(undefined)).toBe(true);
    expect(nudgesAllowed({})).toBe(true);
    expect(nudgesAllowed({ allowNudges: true })).toBe(true);
    expect(nudgesAllowed({ allowNudges: false })).toBe(false);
  });
});
