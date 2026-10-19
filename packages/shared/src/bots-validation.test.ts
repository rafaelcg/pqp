import { describe, expect, it } from "vitest";
import { createServerBotSchema, updateServerBotSchema } from "./bots.js";

describe("bot input", () => {
  const base = { name: "Tico" };

  it("wants a one-line name with two real letters", () => {
    expect(createServerBotSchema.safeParse(base).success).toBe(true);
    expect(createServerBotSchema.safeParse({ name: "😀😀" }).success).toBe(false);
    expect(createServerBotSchema.safeParse({ name: "​​" }).success).toBe(false);
    expect(createServerBotSchema.safeParse({ name: "Ti\nco" }).success).toBe(false);
    expect(createServerBotSchema.safeParse({ name: "Ti‮co" }).success).toBe(false);
  });

  it("refuses NUL and broken characters in prompts instead of failing later", () => {
    expect(updateServerBotSchema.safeParse({ persona: "a\u0000b" }).success).toBe(false);
    expect(updateServerBotSchema.safeParse({ knowledge: "\ud800" }).success).toBe(false);
    expect(updateServerBotSchema.safeParse({ knowledge: "linha 1\nlinha 2\tok" }).success).toBe(true);
  });

  it("stores a blank status line and an empty model as nothing, and tools once each", () => {
    const parsed = updateServerBotSchema.parse({
      tagline: "   ",
      model: "",
      tools: ["post_message", "post_message"],
    });
    expect(parsed.tagline).toBeNull();
    expect(parsed.model).toBeNull();
    expect(parsed.tools).toEqual(["post_message"]);
    expect(updateServerBotSchema.parse({}).tagline).toBeUndefined();
  });
});
