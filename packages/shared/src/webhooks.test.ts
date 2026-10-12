import { describe, expect, it } from "vitest";
import { cleanWebhookPayload, executeWebhookSchema } from "./webhooks.js";

// Found by a soak of real RSS tools against a forum: each of these answered
// 500 (the insert) or 400 (the schema) for a payload a Discord webhook takes.
describe("execute payload from a tool built for Discord", () => {
  it("removes U+0000 everywhere a string lands in Postgres", () => {
    const parsed = executeWebhookSchema.parse({
      content: "a\u0000b",
      username: "bot\u0000",
      thread_name: "t\u0000itle",
      applied_tags: ["Ga\u0000mes"],
      embeds: [{ title: "x\u0000y", fields: [{ name: "n\u0000", value: "v\u0000" }], footer: { text: "f\u0000" } }],
    });
    expect(JSON.stringify(parsed)).not.toContain("\\u0000");
    expect(parsed.content).toBe("ab");
    expect(parsed.username).toBe("bot");
    expect(parsed.embeds?.[0]?.title).toBe("xy");
  });

  it("replaces a lone surrogate half, which jsonb refuses, and keeps a whole emoji", () => {
    // "title".slice(0, n) through the middle of an emoji leaves the high half.
    const cut = "🎮 game".slice(0, 1);
    expect(cut).toBe("\ud83c");
    const parsed = executeWebhookSchema.parse({
      content: "ok 🎮",
      embeds: [{ title: cut, description: "\udc00 tail" }],
    });
    expect(parsed.content).toBe("ok 🎮");
    expect(parsed.embeds?.[0]?.title).toBe("�");
    expect(parsed.embeds?.[0]?.description).toBe("� tail");
  });

  it("reads null as absent, the way Discord does", () => {
    for (const extra of [
      { content: null, embeds: [{ title: "t" }] },
      { username: null },
      { avatar_url: null },
      { embeds: null },
      { embeds: [{ title: "t", color: null }] },
      { embeds: [{ title: "t", fields: null }] },
      { embeds: [{ title: "t", footer: null, timestamp: null, url: null, description: null }] },
    ]) {
      const result = executeWebhookSchema.safeParse({ content: "oi", ...extra });
      expect(result.success, JSON.stringify(extra)).toBe(true);
    }
  });

  it("reads an empty username, avatar_url or embed url as absent", () => {
    const parsed = executeWebhookSchema.parse({
      content: "oi",
      username: "",
      avatar_url: "",
      embeds: [{ title: "t", url: "" }],
    });
    expect(parsed.username).toBeUndefined();
    expect(parsed.avatar_url).toBeUndefined();
    expect(parsed.embeds?.[0]?.url).toBeUndefined();
  });

  it("still refuses what Discord refuses", () => {
    for (const body of [
      {},
      { content: null },
      { content: "" },
      { content: "x".repeat(2001) },
      { content: "oi", username: "u".repeat(81) },
      { content: "oi", avatar_url: "not a url" },
      { embeds: [{ title: "t", url: "not a url" }] },
      { embeds: [{ title: "t", color: 0x1000000 }] },
      { embeds: [{ title: "x".repeat(257) }] },
      { embeds: Array.from({ length: 11 }, () => ({ title: "t" })) },
    ]) {
      expect(executeWebhookSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });

  it("leaves other values alone", () => {
    const body = { n: 0, f: false, s: "ünï ✓", a: [1, "2", { k: "v" }] };
    expect(cleanWebhookPayload(body)).toEqual(body);
  });
});
