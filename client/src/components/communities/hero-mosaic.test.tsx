import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HeroMosaic } from "./hero-mosaic";

describe("HeroMosaic", () => {
  it("tiles the pqp.gg wordmark and does not name a colour", () => {
    const html = renderToStaticMarkup(<HeroMosaic hue={125} />);
    expect(html).toContain("data-hero-mosaic");
    expect(html).toContain("pqp.gg");
    expect(html).toContain("aria-hidden");
    expect(html).toContain("var(--hero-tint-near)");
    expect(html).not.toMatch(/oklch|rgba?\(|hsla?\(|#[0-9a-f]{3,8}/i);
  });
});
