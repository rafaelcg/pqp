import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { formatBuildLine } from "@/components/settings/kit";
import { HelpSection } from "./help-section";

// A stamped production build, so the row and the mail have a real id to agree on.
vi.mock("@/lib/build-info", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/build-info")>()),
  BUILD_ID: "aae19703f00dbabe",
  BUILD_TIME: Date.UTC(2026, 9, 3, 12),
}));

function html() {
  return renderToStaticMarkup(
    <TooltipProvider>
      <HelpSection onOpenFeedback={() => {}} />
    </TooltipProvider>,
  );
}

describe("HelpSection", () => {
  it("offers the address, a prefilled mailto and a copy button", () => {
    const out = html();
    expect(out).toContain("contato@pqp.gg");
    expect(out).toMatch(/href="mailto:contato@pqp\.gg\?subject=/);
    expect(out).toContain('aria-label="Copy address"');
  });

  it("shows the build line with its own copy button", () => {
    const out = html();
    expect(out).toContain(formatBuildLine());
    expect(out).toContain(`aria-label="Copy version: ${formatBuildLine()}"`);
  });

  it("links status, legal pages and GitHub issues, opening in a new tab", () => {
    const out = html();
    for (const href of ["/status", "/terms", "/privacy", "/cookies", "https://github.com/rafaelcg/pqp/issues"]) {
      expect(out).toContain(`href="${href}"`);
    }
    expect(out).toContain('rel="noreferrer"');
  });

  it("names the same build in the mail as on the version row", () => {
    const out = html();
    expect(out).toContain("2026.10.03 · aae1970");
    expect(out).toContain(encodeURIComponent("Version: aae1970\n"));
  });

  it("says what the mail carries and keeps abuse reports out of it", () => {
    const out = html();
    expect(out).toContain("Nothing from your account");
    expect(out).toContain("does not go through this email");
  });

  it("does not put an em dash on the page", () => {
    expect(html()).not.toContain("—");
  });
});
