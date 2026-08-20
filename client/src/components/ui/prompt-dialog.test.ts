import { describe, expect, it } from "vitest";
import { sanitizeChannelName } from "./prompt-dialog";

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
});
