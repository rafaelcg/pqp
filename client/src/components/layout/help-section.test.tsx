import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { formatBuildLine } from "@/components/settings/kit";
import { gmailComposeUrl, HelpSection } from "./help-section";

// Sign out needs Clerk; this suite only checks where it sits.
vi.mock("@/components/layout/sign-out-button", () => ({
  SignOutButton: ({ className }: { className?: string }) => (
    <button type="button" className={className} data-sign-out>
      Sign out
    </button>
  ),
}));

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

  it("shows the copy action as visible text beside the address, not an icon alone", () => {
    const out = html();
    expect(out).toMatch(/contato@pqp\.gg[\s\S]*<span[^>]*>Copy address<\/span>/);
  });

  it("says the prefilled details can be read and removed before sending", () => {
    expect(html()).toContain("You can read and delete all of it before sending.");
  });

  it("offers Gmail as a way out when the mailto does nothing", () => {
    const out = html();
    expect(out).toMatch(/href="https:\/\/mail\.google\.com\/mail\/\?view=cm&amp;fs=1&amp;to=contato%40pqp\.gg/);
    expect(out).toContain("Open in Gmail");
    expect(out).toContain("Copy the address and write it your own way");
  });

  it("builds the Gmail link from the same subject and body as the mailto", () => {
    const mailto =
      "mailto:contato@pqp.gg?subject=Help%20with%20pqp&body=Line%201%0A%0AVersion%3A%20pqp%20web";
    const url = new URL(gmailComposeUrl(mailto));
    expect(url.origin + url.pathname).toBe("https://mail.google.com/mail/");
    expect(url.searchParams.get("to")).toBe("contato@pqp.gg");
    expect(url.searchParams.get("su")).toBe("Help with pqp");
    expect(url.searchParams.get("body")).toBe("Line 1\n\nVersion: pqp web");
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
    // The mail carries the row's whole line, not just the hash.
    expect(out).toContain(encodeURIComponent(`Version: ${formatBuildLine()}\n`));
  });

  it("tells the version row apart from the mail: it already goes in the email", () => {
    expect(html()).toContain("It already goes in the email. Copy it for GitHub or feedback.");
  });

  it("says what the mail carries and keeps abuse reports out of it", () => {
    const out = html();
    expect(out).toContain("Nothing from your account");
    expect(out).toContain("This email does not take reports.");
  });

  it("puts the report notice right under the address, before the version row", () => {
    const out = html();
    const address = out.indexOf("contato@pqp.gg");
    const notice = out.indexOf("This email does not take reports.");
    const version = out.indexOf("App version");
    expect(address).toBeLessThan(notice);
    expect(notice).toBeLessThan(version);
    expect(out.indexOf("Found a bug?")).toBeGreaterThan(version);
  });

  it("explains what each way of reporting a bug means", () => {
    const out = html();
    expect(out).toContain("Includes your username and the screen you were on.");
    expect(out).toContain("Needs a GitHub account.");
    expect(out).toContain("Is it down? Check if the problem is on our side.");
  });

  it("promises no reply window it cannot keep", () => {
    expect(html()).toContain("as soon as we can");
    expect(html()).not.toMatch(/business days/);
  });

  it("ends with sign out on a phone only", () => {
    const out = html();
    expect(out).toMatch(/<div class="sm:hidden"[^>]*><button[^>]*data-sign-out/);
    expect(out.lastIndexOf("data-sign-out")).toBeGreaterThan(out.indexOf("Cookie"));
  });

  it("does not put an em dash on the page", () => {
    expect(html()).not.toContain("—");
  });
});
