import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Check } from "lucide-react";
import { Badge, type BadgeVariant } from "@/components/ui/badge";

const VARIANTS: BadgeVariant[] = [
  "new",
  "accent",
  "success",
  "warning",
  "danger",
  "neutral",
];

describe("Badge", () => {
  it("draws every variant from a token pair, never a literal or an alpha wash", () => {
    for (const variant of VARIANTS) {
      const html = renderToStaticMarkup(<Badge variant={variant}>Novo</Badge>);
      expect(html).toContain(`data-badge="${variant}"`);
      expect(html).not.toMatch(/#[0-9a-f]{3,8}\b|oklch\(|rgb\(/i);
      // An opacity modifier has no measurable contrast (DESIGN.md, soft surfaces).
      expect(html).not.toMatch(/bg-[a-z-]+\/\d+/);
    }
  });

  it("carries the word, with the icon hidden from assistive tech", () => {
    const html = renderToStaticMarkup(
      <Badge variant="success" icon={Check}>
        Resolvido
      </Badge>,
    );
    expect(html).toContain("Resolvido");
    expect(html).toContain('aria-hidden="true"');
  });

  it("defaults to the neutral pair", () => {
    expect(renderToStaticMarkup(<Badge>OP</Badge>)).toContain('data-badge="neutral"');
  });
});
