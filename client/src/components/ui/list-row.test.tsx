import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ListRow } from "@/components/ui/list-row";

const classes = (html: string) => html.match(/class="([^"]*)"/)?.[1] ?? "";

describe("ListRow", () => {
  it("is a button with the label and no pip by default", () => {
    const html = renderToStaticMarkup(<ListRow>geral</ListRow>);
    expect(html).toMatch(/^<button type="button"/);
    expect(html).toContain(">geral<");
    expect(html).not.toContain("data-list-row-pip");
  });

  it("marks the selected row for assistive tech and draws it on the row tokens", () => {
    const html = renderToStaticMarkup(<ListRow selected>papo</ListRow>);
    expect(html).toContain('aria-current="true"');
    expect(classes(html)).toContain("bg-[color:var(--list-row-selected,var(--color-surface-3))]");
  });

  it("tells unread by weight and a pip, not by colour alone", () => {
    const html = renderToStaticMarkup(<ListRow unread>avisos</ListRow>);
    expect(classes(html)).toContain("font-semibold");
    expect(html).toContain("data-list-row-pip");
    // A trailing count replaces the pip.
    expect(renderToStaticMarkup(<ListRow unread trailing="3">avisos</ListRow>)).not.toContain(
      "data-list-row-pip",
    );
  });

  it("fades a muted row, never a selected one", () => {
    expect(classes(renderToStaticMarkup(<ListRow muted>clipes</ListRow>))).toContain(
      "opacity-[var(--list-row-muted-opacity,0.5)]",
    );
    expect(classes(renderToStaticMarkup(<ListRow muted selected>clipes</ListRow>))).not.toContain(
      "opacity-[var(--list-row-muted-opacity",
    );
  });

  it("keeps a caller's colours through className", () => {
    const html = renderToStaticMarkup(<ListRow className="text-paper-muted">geral</ListRow>);
    expect(classes(html)).toContain("text-paper-muted");
    expect(classes(html)).not.toContain("text-[color:var(--list-row-text");
  });

  it("draws a second line under the label", () => {
    const html = renderToStaticMarkup(<ListRow size="lg" detail="Na call">Rafa</ListRow>);
    expect(html).toContain(">Na call<");
    expect(classes(html)).toContain("min-h-[var(--list-row-h-lg,3rem)]");
  });
});
