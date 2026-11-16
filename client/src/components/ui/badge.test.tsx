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
  "muted",
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

  it("keeps the old geometry with the toggle off, and a pill under the redesign", () => {
    const off = (html: string) =>
      (html.match(/class="([^"]*)"/)?.[1] ?? "")
        .split(" ")
        .filter((c) => c && !c.startsWith("redesign:"))
        .sort();
    const md = renderToStaticMarkup(<Badge variant="new">Novo</Badge>);
    expect(off(md)).toEqual(
      "inline-flex h-[18px] shrink-0 items-center gap-1 whitespace-nowrap rounded-[var(--radius-tick)] px-1.5 text-[10px] font-bold uppercase leading-none tracking-[0.06em] bg-accent text-on-accent"
        .split(" ")
        .sort(),
    );
    expect(md).toContain("redesign:rounded-[var(--badge-radius)]");
    expect(md).toContain("redesign:normal-case");
  });

  it("draws a name tag at the tag's old size, its call-site colours only with the toggle off", () => {
    const html = renderToStaticMarkup(
      <Badge size="tag" className="rounded bg-ink-4 text-paper-muted">
        Webhook
      </Badge>,
    );
    expect(html).toContain("px-1 py-px");
    expect(html).toContain("bg-ink-4");
    expect(html).not.toContain(" bg-surface-3");
    // Under the redesign the variant wins, so every tag is the same pill.
    expect(html).toContain("redesign:bg-surface-3");
    expect(html).toContain("redesign:h-[var(--badge-tag-h)]");
  });
});

