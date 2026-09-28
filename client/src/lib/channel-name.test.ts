import { describe, expect, it } from "vitest";
import { createChannelSchema, updateChannelSchema } from "@pqp/shared";
import { CHANNEL_NAME_MAX_LENGTH, sanitizeChannelName } from "./channel-name";

describe("sanitizeChannelName", () => {
  it("folds accents instead of deleting them", () => {
    // The bug this pins: "caça-bugs" used to become "caa-bugs".
    expect(sanitizeChannelName("caça-bugs")).toBe("caca-bugs");
    expect(sanitizeChannelName("anúncios")).toBe("anuncios");
    expect(sanitizeChannelName("São Paulo")).toBe("sao-paulo");
  });

  it("turns spaces into hyphens rather than swallowing them", () => {
    expect(sanitizeChannelName("mesa de rpg")).toBe("mesa-de-rpg");
  });

  it("still drops what has no fold", () => {
    expect(sanitizeChannelName("geral! 🎉")).toBe("geral-");
    expect(sanitizeChannelName("ARQ_2026")).toBe("arq_2026");
  });

  it("cuts a pasted name at the limit", () => {
    expect(sanitizeChannelName("a".repeat(300))).toHaveLength(
      CHANNEL_NAME_MAX_LENGTH,
    );
  });
});

describe("a sanitised name is one the server accepts", () => {
  // The bugs this pins: renaming to "Renomeado Com Espaços" answered 400
  // because only the create dialog sanitised, and 300 characters answered
  // 400 from both because nothing on the client knew the limit.
  const typed = [
    "Renomeado Com Espaços",
    "a".repeat(300),
    "Meu Canal Legal 🎉 ÁÉ!",
    "  mesa   de  rpg ",
    "ARQ_2026",
  ];

  it.each(typed)("create and rename both accept %s", (raw) => {
    const name = sanitizeChannelName(raw);
    expect(
      createChannelSchema.safeParse({ name, type: "text" }).success,
    ).toBe(true);
    expect(updateChannelSchema.safeParse({ name }).success).toBe(true);
  });

  it("uses the same limit as the schemas", () => {
    const atLimit = "a".repeat(CHANNEL_NAME_MAX_LENGTH);
    const overLimit = `${atLimit}a`;
    expect(updateChannelSchema.safeParse({ name: atLimit }).success).toBe(true);
    expect(updateChannelSchema.safeParse({ name: overLimit }).success).toBe(
      false,
    );
    expect(
      createChannelSchema.safeParse({ name: overLimit, type: "text" }).success,
    ).toBe(false);
  });
});
