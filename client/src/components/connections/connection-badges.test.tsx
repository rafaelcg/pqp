import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConnectionGlyph } from "./connection-badges";

describe("ConnectionGlyph", () => {
  it("renders an SVG mark for each provider, not a letter square", () => {
    for (const provider of ["steam", "battlenet", "twitch"] as const) {
      const html = renderToStaticMarkup(<ConnectionGlyph provider={provider} />);
      expect(html).toContain("<svg");
      expect(html).toContain("<path d=");
      expect(html).not.toMatch(/>[SBT]</);
    }
  });
});
