import { describe, expect, it } from "vitest";
import { outgoingMessageCreatedPayloadSchema } from "./outgoing-webhooks.js";

const base = {
  type: "message.created" as const,
  id: "00000000-0000-4000-8000-000000000010",
  createdAt: "2026-10-12T00:00:00.000Z",
  timestamp: "2026-10-12T00:00:00.000Z",
  serverId: "00000000-0000-4000-8000-000000000011",
  serverName: "Hooks",
  channelId: "00000000-0000-4000-8000-000000000012",
  channelName: "geral",
  messageId: "00000000-0000-4000-8000-000000000013",
  author: {
    id: "00000000-0000-4000-8000-000000000014",
    username: "ana",
    tag: "ana#0001",
    displayName: "Ana",
    isBot: false,
  },
  body: "oi",
  replyToId: null,
};

describe("outgoingMessageCreatedPayloadSchema", () => {
  it("parses a text event that has no forum fields", () => {
    const parsed = outgoingMessageCreatedPayloadSchema.parse(base);
    expect(parsed.forumId).toBeUndefined();
    expect(parsed.postTitle).toBeUndefined();
    expect(parsed.isPostStart).toBeUndefined();
  });

  it("parses the forum fields on a post", () => {
    const parsed = outgoingMessageCreatedPayloadSchema.parse({
      ...base,
      forumId: "00000000-0000-4000-8000-000000000015",
      postTitle: "Notebook não liga",
      isPostStart: true,
    });
    expect(parsed.forumId).toBe("00000000-0000-4000-8000-000000000015");
    expect(parsed.postTitle).toBe("Notebook não liga");
    expect(parsed.isPostStart).toBe(true);
  });
});
