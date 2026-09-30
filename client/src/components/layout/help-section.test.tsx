import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HelpSection } from "./help-section";

function html() {
  return renderToStaticMarkup(<HelpSection onOpenFeedback={() => {}} />);
}

describe("HelpSection", () => {
  it("offers the address, a prefilled mailto and a copy button", () => {
    const out = html();
    expect(out).toContain("contato@pqp.gg");
    expect(out).toMatch(/href="mailto:contato@pqp\.gg\?subject=/);
    expect(out).toContain("Copy address");
  });

  it("links status, legal pages and GitHub issues, opening in a new tab", () => {
    const out = html();
    for (const href of ["/status", "/terms", "/privacy", "/cookies", "https://github.com/rafaelcg/pqp/issues"]) {
      expect(out).toContain(`href="${href}"`);
    }
    expect(out).toContain('rel="noreferrer"');
  });

  it("says what the mail carries and keeps abuse reports out of it", () => {
    const out = html();
    expect(out).toContain("read and delete all of it");
    expect(out).toContain("does not go through this email");
  });

  it("does not put an em dash on the page", () => {
    expect(html()).not.toContain("—");
  });
});
