import { CONNECTION_PROVIDERS } from "@pqp/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ConnectionGlyph,
  UPCOMING_CONNECTION_PROVIDERS,
} from "./connection-badges";

describe("ConnectionGlyph", () => {
  it("renders an SVG mark for each provider, not a letter square", () => {
    for (const provider of [
      ...CONNECTION_PROVIDERS,
      ...UPCOMING_CONNECTION_PROVIDERS,
    ]) {
      const html = renderToStaticMarkup(<ConnectionGlyph provider={provider} />);
      expect(html).toContain("<svg");
      expect(html).toContain("<path d=");
      expect(html).not.toMatch(/>[SBT]</);
    }
  });
});
