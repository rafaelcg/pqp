import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EmptyState } from "@/components/ui/empty-state";

const tag = (html: string, name: string) => html.match(new RegExp(`<${name} class="([^"]*)"`))![1];

describe("EmptyState", () => {
  it("keeps the caller's toggle-off classes and puts the redesign last", () => {
    const html = renderToStaticMarkup(
      <EmptyState
        title="Comece a conversa"
        body="Manda a primeira."
        className="flex-1 justify-center gap-2 px-6 py-16"
        titleClassName="font-display text-xl font-bold text-paper"
        bodyClassName="max-w-xs text-sm text-paper-muted"
      />,
    );
    expect(html).toContain('data-empty-state="page"');
    const title = tag(html, "p");
    expect(title).toContain("font-display text-xl font-bold text-paper");
    expect(title.indexOf("text-paper")).toBeLessThan(title.indexOf("redesign:"));
    expect(title).toContain("redesign:font-[family-name:var(--type-title-font)]");
  });

  it("hides the icon from assistive tech and draws its disc under the redesign only", () => {
    const html = renderToStaticMarkup(
      <EmptyState icon={<svg />} iconClassName="text-text-secondary" title="Nada aqui" />,
    );
    const icon = html.match(/<div aria-hidden="true" class="([^"]*)"/)![1];
    expect(icon).toContain("text-text-secondary");
    expect(icon).toContain("redesign:rounded-full");
    expect(icon).not.toMatch(/(^| )rounded-full/);
  });

  it("is a quiet label and line when inline", () => {
    const html = renderToStaticMarkup(<EmptyState size="inline" title="Nenhum bot" body="Cria um." />);
    expect(html).toContain('data-empty-state="inline"');
    expect(html).toContain("redesign:text-text-secondary");
    expect(html).not.toContain("var(--empty-icon-disc)");
  });

  it("passes data attributes and a role through", () => {
    const html = renderToStaticMarkup(
      <EmptyState role="status" data-empty-owner="" title="Ninguém ainda" actions={<button type="button">x</button>} />,
    );
    expect(html).toMatch(/^<div role="status" data-empty-state="page" data-empty-owner=""/);
    expect(html).toContain("<button");
  });
});
