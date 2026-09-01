import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApoiePage, ApoieRoute } from "./apoie-page";

// The marketing nav renders Clerk's sign-in CTAs, which need a ClerkProvider.
// Locally the dev-auth bypass hides them; CI has no bypass and no provider, so
// stub the CTAs: this test is about the donation copy, not the auth buttons.
vi.mock("@/components/marketing/marketing-auth-ctas", () => ({
  MarketingAuthCtas: () => null,
}));

const SPONSOR = "https://github.com/sponsors/rafaelcg";
const PIX_KEY = "9c1b6f8e-1111-4222-8333-444455556666";
const BRCODE = "00020126580014br.gov.bcb.pix0136" + PIX_KEY + "5204000053039865802BR";

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);
}

describe("ApoiePage", () => {
  it("shows the Sponsors button and the Pix key with a Copy button", () => {
    const html = render(
      <ApoiePage links={{ sponsorUrl: SPONSOR, pixKey: PIX_KEY, pixBrCode: BRCODE }} />,
    );
    expect(html).toContain(`href="${SPONSOR}"`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain(PIX_KEY);
    expect(html).toContain(BRCODE);
    expect(html).toContain("Sponsor on GitHub");
    expect(html).toContain("Pix copy and paste");
    expect((html.match(/>Copy</g) ?? []).length).toBe(2);
    // The closing line points at the repo.
    expect(html).toContain("https://github.com/rafaelcg/pqp");
  });

  it("hides the Pix block when only Sponsors is set", () => {
    const html = render(
      <ApoiePage links={{ sponsorUrl: SPONSOR, pixKey: null, pixBrCode: null }} />,
    );
    expect(html).toContain(SPONSOR);
    expect(html).not.toContain("Random key");
    expect(html).not.toContain(">Copy<");
  });

  it("hides the Sponsors block when only Pix is set, and shows one Copy without a BR code", () => {
    const html = render(
      <ApoiePage links={{ sponsorUrl: null, pixKey: PIX_KEY, pixBrCode: null }} />,
    );
    expect(html).not.toContain("github.com/sponsors");
    expect(html).toContain(PIX_KEY);
    expect(html).not.toContain("Pix copy and paste");
    expect((html.match(/>Copy</g) ?? []).length).toBe(1);
  });

  it("carries no dash punctuation in its English copy", () => {
    const html = render(
      <ApoiePage links={{ sponsorUrl: SPONSOR, pixKey: PIX_KEY, pixBrCode: BRCODE }} />,
    );
    for (const banned of ["—", "–", "―"]) {
      expect(html).not.toContain(banned);
    }
  });
});

describe("ApoieRoute", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("redirects home when the build carries no donation links", () => {
    vi.stubEnv("VITE_SPONSOR_URL", "");
    vi.stubEnv("VITE_PIX_KEY", "");
    vi.stubEnv("VITE_PIX_BRCODE", "");
    // `<Navigate>` renders nothing; the page would have rendered a heading.
    expect(render(<ApoieRoute />)).toBe("");
  });

  it("renders the page from the build env when a link is set", () => {
    vi.stubEnv("VITE_SPONSOR_URL", ` ${SPONSOR} `);
    vi.stubEnv("VITE_PIX_KEY", "");
    const html = render(<ApoieRoute />);
    expect(html).toContain(`href="${SPONSOR}"`);
    expect(html).not.toContain("Random key");
  });
});
