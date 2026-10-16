import { describe, expect, it } from "vitest";
import es from "./es/translation.json";

describe("es copy for stories", () => {
  // Spanish says "historia" everywhere; the English word crept into a few keys ("el story").
  it("never uses the English word for a story", () => {
    const leaks = Object.entries(es as Record<string, string>).filter(
      ([key, value]) => key.startsWith("stories.") && /\bstor(y|ies)\b/i.test(value),
    );
    expect(leaks).toEqual([]);
  });
});
