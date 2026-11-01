import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EmptyState } from "@/components/ui/empty-state";
import { Breu } from "./breu";

describe("Breu", () => {
  it("draws the lime character with the face for the mood", () => {
    const html = renderToStaticMarkup(<Breu mood="sad" />);
    expect(html).toContain('data-variant="full"');
    expect(html).toContain('data-face="triste"');
    expect(html).toContain("<svg");
  });

  it("takes the icon's place in an empty state, decorative", () => {
    const html = renderToStaticMarkup(
      <EmptyState mascot="hello" icon={<i data-glyph="" />} title="Nada aqui" />,
    );
    expect(html).toContain('data-empty-mascot="hello"');
    expect(html).toContain('data-face="oi"');
    expect(html).not.toContain("data-glyph");
    expect(html).toMatch(/data-empty-mascot="hello"[^>]*aria-hidden="true"|aria-hidden="true"[^>]*data-empty-mascot="hello"/);
  });
});
