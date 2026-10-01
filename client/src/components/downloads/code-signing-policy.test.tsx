import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DownloadPage } from "@/pages/download-page";
import { MarketingFooter } from "@/components/marketing/marketing-footer";
import { loadLocale } from "@/lib/i18n";
import { CodeSigningPolicy } from "./code-signing-policy";

// The nav renders Clerk's sign-in CTAs, which need a ClerkProvider this test
// does not set up. Same stub as android-page.test.tsx.
vi.mock("@/components/marketing/marketing-auth-ctas", () => ({
  MarketingAuthCtas: () => null,
}));

// The SignPath Foundation requires this exact English sentence on the site.
const CREDIT =
  "Free code signing provided by SignPath.io, certificate by SignPath Foundation";

function renderPolicy(): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <CodeSigningPolicy />
    </MemoryRouter>,
  );
}

describe("CodeSigningPolicy", () => {
  afterEach(async () => {
    await loadLocale("en");
  });

  it("carries the anchor the footer and the SignPath application link to", () => {
    const html = renderPolicy();
    expect(html).toContain('id="code-signing"');
    expect(html).toContain('aria-labelledby="code-signing-heading"');
    expect(html).toContain('id="code-signing-heading"');
  });

  it("says the credit sentence verbatim, in English, marked lang=en", () => {
    const html = renderPolicy();
    expect(html).toContain(CREDIT);
    expect(html).toContain('lang="en"');
  });

  it("does not claim signed builds exist today", () => {
    const html = renderPolicy();
    expect(html).toContain("not code-signed yet");
    expect(html).toContain("Once it approves us");
    // The SmartScreen guidance for the unsigned builds stays.
    expect(html).toContain("More info, then Run anyway");
  });

  it("names the roles and the people in them", () => {
    const html = renderPolicy();
    expect(html).toContain("Committers and reviewers");
    expect(html).toContain("Approvers");
    expect(html).toContain("Rafael Cammarano Guglielmi");
    expect(html).toContain('href="https://github.com/rafaelcg"');
    expect(html).toContain("André");
    expect(html).toContain('href="https://github.com/AndreCamm"');
  });

  it("links SignPath, its terms, the repository, the workflow and the privacy page", () => {
    const html = renderPolicy();
    expect(html).toContain('href="https://signpath.org"');
    expect(html).toContain('href="https://signpath.org/terms"');
    expect(html).toContain('href="https://github.com/rafaelcg/pqp"');
    expect(html).toContain(
      'href="https://github.com/rafaelcg/pqp/blob/main/.github/workflows/electron.yml"',
    );
    expect(html).toContain('href="/privacy"');
    // Every external link opens safely.
    expect(html).not.toMatch(/target="_blank"(?![^>]*rel="noopener")[^>]*>/);
  });

  it("does not borrow SignPath's own privacy sentence, which would be false here", () => {
    const html = renderPolicy();
    expect(html).not.toContain("will not transfer any information");
    expect(html).toContain("checks GitHub Releases");
  });

  it("renders in Portuguese with the credit sentence still in English", async () => {
    await loadLocale("pt-BR");
    const html = renderPolicy();
    expect(html).toContain("Política de assinatura de código");
    expect(html).toContain("ainda não são assinados");
    expect(html).toContain("Executar assim mesmo");
    expect(html).toContain("Aprovadores");
    expect(html).toContain(CREDIT);
    expect(html).not.toContain("Code signing policy");
  });

  it("renders in Spanish with the credit sentence still in English", async () => {
    await loadLocale("es");
    const html = renderPolicy();
    expect(html).toContain("Política de firma de código");
    expect(html).toContain("todavía no están firmados");
    expect(html).toContain("Ejecutar de todas formas");
    expect(html).toContain("Aprobadores");
    expect(html).toContain(CREDIT);
    expect(html).not.toContain("Code signing policy");
  });
});

describe("the policy on /download", () => {
  afterEach(async () => {
    await loadLocale("en");
  });

  it("is part of the download page, under its own anchor", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <DownloadPage />
      </MemoryRouter>,
    );
    expect(html).toContain('id="code-signing"');
    expect(html).toContain(CREDIT);
  });

  it("is linked from the footer in every language", async () => {
    const expected: Record<string, string> = {
      en: "Code signing policy",
      "pt-BR": "Assinatura de código",
      es: "Firma de código",
    };
    for (const locale of ["en", "pt-BR", "es"] as const) {
      await loadLocale(locale);
      const html = renderToStaticMarkup(
        <MemoryRouter>
          <MarketingFooter />
        </MemoryRouter>,
      );
      expect(html).toContain('href="/download#code-signing"');
      expect(html).toContain(expected[locale]);
    }
  });
});
