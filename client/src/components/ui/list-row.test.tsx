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
    // A count replaces the pip; a time does not.
    expect(renderToStaticMarkup(<ListRow unread count="3">avisos</ListRow>)).not.toContain(
      "data-list-row-pip",
    );
    expect(renderToStaticMarkup(<ListRow unread trailing="17:42">Caio</ListRow>)).toContain(
      "data-list-row-pip",
    );
  });

  it("stacks a time over its count on a two-line row, as over a pip", () => {
    const html = renderToStaticMarkup(
      <ListRow size="lg" unread trailing="16:10" count="2">
        Duda
      </ListRow>,
    );
    const trailing = html.slice(html.indexOf("data-list-row-trailing"));
    expect(trailing).toContain("flex-col items-end");
    expect(trailing.indexOf("16:10")).toBeLessThan(trailing.indexOf("data-list-row-count"));
  });

  it("fades a muted row, never a selected one", () => {
    // 0.5 with the toggle off; the redesign sets the token to 0.6, where the
    // bell-off mark tells it apart from a disabled row at 0.4.
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

  it("puts an action beside the row's button, never inside it", () => {
    const html = renderToStaticMarkup(
      <ListRow selected action={<button type="button">gear</button>}>
        papo
      </ListRow>,
    );
    expect(html).toMatch(/^<div data-list-row=""/);
    // Two sibling buttons: the row and the action; no button inside a button.
    expect(html).not.toMatch(/<button[^>]*>(?:(?!<\/button>).)*<button/);
    expect(html).toContain('aria-current="true"');
    expect(classes(html)).toContain("bg-[color:var(--list-row-selected,var(--color-surface-3))]");
  });

  it("shows no unread weight or pip on the selected row, the one being read", () => {
    const html = renderToStaticMarkup(
      <ListRow selected unread>
        avisos
      </ListRow>,
    );
    expect(classes(html)).not.toContain("font-semibold");
    expect(html).not.toContain("data-list-row-pip");
    expect(html).toContain("data-unread");
  });

  it("takes a disabled row's action out of keyboard reach", () => {
    const html = renderToStaticMarkup(
      <ListRow disabled action={<button type="button">gear</button>}>
        arquivo
      </ListRow>,
    );
    expect(html).toMatch(/data-list-row-action=""[^>]*inert/);
  });
});

