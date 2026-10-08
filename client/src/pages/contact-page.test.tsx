import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { ContactPage } from "./contact-page";

// The marketing nav renders Clerk's sign-in CTAs, which need a ClerkProvider.
vi.mock("@/components/marketing/marketing-auth-ctas", () => ({
  MarketingAuthCtas: () => null,
}));

function render(): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <ContactPage />
    </MemoryRouter>,
  );
}

describe("ContactPage", () => {
  it("says what pqp is, who makes it and that it is independent", () => {
    const html = render();
    expect(html).toContain(
      "pqp is a free, open source app for voice, screen sharing and text chat.",
    );
    expect(html).toContain("pqp is made by two brothers.");
    expect(html).toContain(
      "pqp is an independent project and is not affiliated with Discord or any other company.",
    );
  });

  it("gives the address as a mailto link and links the policies and the source", () => {
    const html = render();
    expect(html).toContain('href="mailto:contato@pqp.gg"');
    expect(html).toContain('href="/privacy"');
    expect(html).toContain('href="/terms"');
    expect(html).toContain('href="https://github.com/rafaelcg/pqp"');
  });

  it("has one h1, a labelled section per topic and the footer's one-line independence note", () => {
    const html = render();
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html.match(/<section[^>]*aria-labelledby/g)).toHaveLength(4);
    expect(html).toContain(
      "pqp is independent and not affiliated with Discord or any other company.",
    );
    // The footer's Contact link points at this page.
    expect(html).toContain('href="/contact"');
  });

  it("carries no dash punctuation and no personal name or country in its English copy", () => {
    const text = render().replace(/<[^>]+>/g, " ");
    expect(text).not.toMatch(/[—–]/);
    expect(text).not.toMatch(/rafael\b(?!\.ltd)|andr[eé]\b|brazil|united kingdom/i);
  });
});
