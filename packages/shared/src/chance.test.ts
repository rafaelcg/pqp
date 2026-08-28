import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROLL_NOTATION,
  MAX_DICE_COUNT,
  MAX_DRAW_COUNT,
  STANDARD_DECK,
  executeChoose,
  executeDraw,
  executeFlip,
  executeRoll,
  formatChanceBody,
  parseChooseOptions,
  parseDrawCount,
  parseRollNotation,
  resolveChanceRequest,
} from "./chance.js";
import { messageSchema } from "./api.js";
import { chatClientMessageSchema, messageCreateMessageSchema } from "./chat.js";
import { parsePollSlashArgs, pollRequestSchema } from "./polls.js";

function sequence(values: number[]): (min: number, max: number) => number {
  let i = 0;
  return (min, max) => {
    const next = values[i] ?? min;
    i += 1;
    return Math.min(max, Math.max(min, next));
  };
}

describe("parseRollNotation", () => {
  it("defaults an empty string to 1d20", () => {
    const parsed = parseRollNotation("");
    expect(parsed).toEqual({
      ok: true,
      value: { count: 1, sides: 20, modifier: 0, notation: DEFAULT_ROLL_NOTATION },
    });
  });

  it("accepts d20, 2d6+3, and 2d6-1", () => {
    expect(parseRollNotation("d20")).toMatchObject({
      ok: true,
      value: { count: 1, sides: 20, modifier: 0, notation: "1d20" },
    });
    expect(parseRollNotation("2d6+3")).toMatchObject({
      ok: true,
      value: { count: 2, sides: 6, modifier: 3, notation: "2d6+3" },
    });
    expect(parseRollNotation("2d6-1")).toMatchObject({
      ok: true,
      value: { count: 2, sides: 6, modifier: -1, notation: "2d6-1" },
    });
  });

  it("refuses faces that are not polyhedral", () => {
    expect(parseRollNotation("1d7")).toEqual({ ok: false, error: "bad-face" });
    expect(parseRollNotation("1d3")).toEqual({ ok: false, error: "bad-face" });
  });

  it("caps the dice count so 9999d20 never posts", () => {
    expect(parseRollNotation(`${MAX_DICE_COUNT + 1}d20`)).toEqual({
      ok: false,
      error: "too-many-dice",
    });
    expect(parseRollNotation("0d20")).toEqual({
      ok: false,
      error: "too-many-dice",
    });
  });

  it("refuses junk", () => {
    expect(parseRollNotation("fireball")).toEqual({
      ok: false,
      error: "invalid-notation",
    });
  });
});

describe("executeRoll", () => {
  it("sums faces and the modifier", () => {
    const parsed = parseRollNotation("2d6+3");
    if (!parsed.ok) {
      throw new Error("expected parse");
    }
    const result = executeRoll(parsed.value, sequence([4, 2]));
    expect(result).toEqual({
      type: "roll",
      notation: "2d6+3",
      faces: [4, 2],
      modifier: 3,
      total: 9,
    });
    expect(formatChanceBody(result)).toBe("2d6+3 → 4, 2 + 3 = 9");
  });
});

describe("parseChooseOptions", () => {
  it("splits on spaces or commas", () => {
    expect(parseChooseOptions("pizza burguer sushi")).toEqual({
      ok: true,
      value: ["pizza", "burguer", "sushi"],
    });
    expect(parseChooseOptions("pizza, burguer, sushi")).toEqual({
      ok: true,
      value: ["pizza", "burguer", "sushi"],
    });
  });

  it("needs at least two options", () => {
    expect(parseChooseOptions("only")).toEqual({
      ok: false,
      error: "too-few-options",
    });
  });
});

describe("parseDrawCount", () => {
  it("defaults to one card and caps at 13", () => {
    expect(parseDrawCount("")).toEqual({ ok: true, value: 1 });
    expect(parseDrawCount("5")).toEqual({ ok: true, value: 5 });
    expect(parseDrawCount(String(MAX_DRAW_COUNT + 1))).toEqual({
      ok: false,
      error: "bad-draw-count",
    });
  });
});

describe("executeDraw", () => {
  it("draws from a 52-card deck without repeats", () => {
    const result = executeDraw(5, sequence([0, 0, 0, 0, 0]));
    expect(result.type).toBe("draw");
    if (result.type !== "draw") {
      return;
    }
    expect(result.cards).toHaveLength(5);
    expect(new Set(result.cards).size).toBe(5);
    for (const card of result.cards) {
      expect(STANDARD_DECK).toContain(card);
    }
  });
});

describe("executeFlip", () => {
  it("maps 0 to heads and 1 to tails", () => {
    expect(executeFlip(() => 0)).toEqual({ type: "flip", result: "heads" });
    expect(executeFlip(() => 1)).toEqual({ type: "flip", result: "tails" });
  });
});

describe("executeChoose", () => {
  it("picks by index", () => {
    expect(executeChoose(["a", "b", "c"], () => 1)).toEqual({
      type: "choose",
      options: ["a", "b", "c"],
      picked: "b",
    });
  });
});

describe("resolveChanceRequest", () => {
  it("turns a request into a result without accepting a pre-rolled total", () => {
    const resolved = resolveChanceRequest(
      { type: "roll", notation: "1d20" },
      () => 17,
    );
    expect(resolved).toEqual({
      ok: true,
      value: {
        type: "roll",
        notation: "1d20",
        faces: [17],
        modifier: 0,
        total: 17,
      },
    });
  });
});

describe("message protocol", () => {
  const ids = {
    id: "00000000-0000-4000-8000-000000000001",
    channelId: "00000000-0000-4000-8000-000000000002",
    authorId: "00000000-0000-4000-8000-000000000003",
  };

  it("defaults chance and poll so an older API still parses", () => {
    const parsed = messageSchema.parse({
      ...ids,
      authorName: "A",
      authorTag: null,
      authorAvatarUrl: null,
      body: "hi",
      createdAt: new Date(0).toISOString(),
    });
    expect(parsed.chance).toBeNull();
    expect(parsed.poll).toBeNull();
  });

  it("lets message-create carry a chance request with an empty body", () => {
    expect(
      messageCreateMessageSchema.safeParse({
        type: "message-create",
        channelId: ids.channelId,
        body: "",
        chance: { type: "flip" },
      }).success,
    ).toBe(true);
  });

  it("refuses an empty message-create with neither body, attachment, chance, nor poll", () => {
    expect(
      messageCreateMessageSchema.safeParse({
        type: "message-create",
        channelId: ids.channelId,
        body: "",
      }).success,
    ).toBe(false);
  });

  it("accepts poll-vote on the client union", () => {
    expect(
      chatClientMessageSchema.safeParse({
        type: "poll-vote",
        channelId: ids.channelId,
        messageId: ids.id,
        optionId: "00000000-0000-4000-8000-000000000004",
      }).success,
    ).toBe(true);
  });
});

describe("pollRequestSchema", () => {
  it("accepts a Discord-shaped poll", () => {
    const parsed = pollRequestSchema.parse({
      question: "Who is playing Saturday?",
      options: ["Yes", "No", "Maybe"],
      durationSeconds: 86_400,
      allowMultiselect: false,
    });
    expect(parsed.options).toHaveLength(3);
  });

  it("parses /poll question | a | b", () => {
    expect(parsePollSlashArgs("qual mapa | bind | haven | split")).toMatchObject({
      question: "qual mapa",
      options: ["bind", "haven", "split"],
    });
    expect(parsePollSlashArgs("only one")).toBeNull();
  });
});
