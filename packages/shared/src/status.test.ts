import { describe, expect, it } from "vitest";
import {
  CHAT_SERVER_MESSAGE_TYPES,
  chatServerMessageSchema,
  isChatServerMessage,
} from "./chat.js";
import {
  manualStatusSchema,
  ownStatusSchema,
  userStatusSchema,
} from "./status.js";

describe("manualStatusSchema", () => {
  it("accepts the four manual values, away included", () => {
    for (const value of ["online", "away", "dnd", "invisible"]) {
      expect(manualStatusSchema.parse(value)).toBe(value);
    }
  });

  it("still refuses anything else, idle included", () => {
    for (const value of ["idle", "offline", "busy", ""]) {
      expect(manualStatusSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe("userStatusSchema", () => {
  it("is unchanged: four values, and still no invisible", () => {
    for (const value of ["online", "idle", "dnd", "offline"]) {
      expect(userStatusSchema.parse(value)).toBe(value);
    }
    expect(userStatusSchema.safeParse("invisible").success).toBe(false);
    expect(userStatusSchema.safeParse("away").success).toBe(false);
  });
});

describe("ownStatusSchema", () => {
  it("carries a manual choice, invisible included, and nothing else", () => {
    for (const status of ["online", "away", "dnd", "invisible"]) {
      expect(ownStatusSchema.parse({ type: "own-status", status })).toEqual({
        type: "own-status",
        status,
      });
    }
    // Derived states are never stored or chosen, so they are never sent.
    expect(
      ownStatusSchema.safeParse({ type: "own-status", status: "idle" }).success,
    ).toBe(false);
  });

  it("is a chat server frame, so a client can route it by name", () => {
    expect(
      chatServerMessageSchema.safeParse({ type: "own-status", status: "away" })
        .success,
    ).toBe(true);
  });

  // It can carry `invisible`, so the channel relay must never be willing to
  // hand it to a channel.
  it("is NOT relayable to a channel", () => {
    expect(CHAT_SERVER_MESSAGE_TYPES).not.toContain("own-status");
    expect(isChatServerMessage({ type: "own-status" })).toBe(false);
  });
});
