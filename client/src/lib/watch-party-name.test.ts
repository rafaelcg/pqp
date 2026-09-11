import { describe, expect, it } from "vitest";
import { suggestedWatchPartyName } from "./watch-party-name";

describe("suggestedWatchPartyName", () => {
  const saturday = new Date(2026, 8, 12, 20, 0); // 12 Sep 2026 is a Saturday
  it("names the weekday, in the locale", () => {
    expect(suggestedWatchPartyName(saturday, "pt-BR")).toBe("Sessão de sábado");
    expect(suggestedWatchPartyName(saturday, "en")).toBe("Saturday session");
  });
});
