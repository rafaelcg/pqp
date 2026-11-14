import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PaneHeader, SectionLabel } from "@/components/ui/section-header";

const classes = (html: string) => (html.match(/class="([^"]*)"/g) ?? []).join(" ");

describe("PaneHeader", () => {
  it("keeps the caller's toggle-off classes and puts the redesign last", () => {
    const html = renderToStaticMarkup(
      <PaneHeader
        title="Visão geral"
        description="Como esse servidor se chama."
        className="mb-5"
        titleClassName="font-display text-lg font-bold text-paper"
        descriptionClassName="mt-1 text-xs text-paper-muted"
      />,
    );
    expect(html).toMatch(/^<header/);
    expect(html).toContain("<h3");
    const title = html.match(/<h3 class="([^"]*)"/)![1];
    expect(title).toContain("text-lg font-bold text-paper");
    expect(title.indexOf("text-paper")).toBeLessThan(title.indexOf("redesign:"));
    expect(title).toContain("redesign:font-[family-name:var(--type-title-font)]");
    expect(classes(html)).toContain("text-xs text-paper-muted");
    expect(classes(html)).toContain("redesign:text-text-secondary");
  });

  it("draws no actions slot unless it has actions or a ref", () => {
    expect(renderToStaticMarkup(<PaneHeader title="Voz" />)).not.toContain("empty:hidden");
    expect(
      renderToStaticMarkup(<PaneHeader title="Voz" actions={<button type="button">x</button>} />),
    ).toContain("empty:hidden");
  });
});

describe("SectionLabel", () => {
  it("drops the capitals and tracking under the redesign only", () => {
    const html = renderToStaticMarkup(
      <SectionLabel className="text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">
        Recentes
      </SectionLabel>,
    );
    expect(html).toMatch(/^<h3 data-section-label="list"/);
    const cls = classes(html);
    expect(cls).toContain("uppercase tracking-wider text-text-tertiary");
    expect(cls).toContain("redesign:normal-case redesign:tracking-normal! redesign:text-text-secondary");
  });

  it("keeps the danger colour on a group title, as server settings' danger zone uses it", () => {
    const html = renderToStaticMarkup(
      <SectionLabel variant="group" tone="danger" className="text-danger">
        Zona de perigo
      </SectionLabel>,
    );
    expect(classes(html)).toContain("redesign:text-danger");
    expect(classes(html)).not.toContain("redesign:text-text ");
    expect(classes(html).endsWith("redesign:text-text")).toBe(false);
  });

  it("keeps a danger zone's tone and the tag it is given", () => {
    const html = renderToStaticMarkup(
      <SectionLabel as="h4" tone="danger" className="text-danger">
        Apagar o servidor
      </SectionLabel>,
    );
    expect(html).toMatch(/^<h4/);
    expect(classes(html)).toContain("redesign:text-danger");
    expect(classes(html)).not.toContain("redesign:text-text-secondary");
  });

  it("heads a settings group at the body size in the text colour", () => {
    const html = renderToStaticMarkup(
      <SectionLabel as="h4" variant="group" className="text-sm font-semibold text-text">
        Nome e foto
      </SectionLabel>,
    );
    expect(html).toContain('data-section-label="group"');
    expect(classes(html)).toContain("redesign:text-[length:var(--section-group-size)]");
    expect(classes(html)).toContain("redesign:text-text");
    expect(classes(html)).not.toContain("redesign:text-text-secondary");
    expect(classes(html)).not.toContain("--section-label-gap");
  });
});
