// @vitest-environment jsdom
import type { BauMembership, BauOffer } from "@pqp/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  formatBauDay,
  formatBrl,
  formatCountdown,
} from "@/lib/bau-plus/format";
import { BauPlusPaywall } from "./bau-plus-paywall";

/**
 * The Baú+ locked card. Rendered with no I18nProvider, so the strings are the
 * English fallback. What matters: a real, labelled button with the price,
 * never a disabled one, and the right next step for a fan mid-payment or
 * whose VIP ran out.
 */

const offer: BauOffer = {
  enabled: true,
  plan: {
    id: "00000000-0000-4000-8000-000000000001",
    serverId: "00000000-0000-4000-8000-000000000002",
    name: "VIP",
    priceCents: 990,
    currency: "BRL",
    perks: [],
    active: true,
  },
  seller: { name: "Bia", providerLabel: "Sandbox" },
  methods: ["pix", "card"],
  sandbox: true,
  membership: null,
  graceDays: 3,
  reminderDays: 3,
  refundWindowDays: 7,
};

function membership(patch: Partial<BauMembership>): BauMembership {
  return {
    id: "00000000-0000-4000-8000-000000000003",
    serverId: offer.plan!.serverId,
    serverName: "Canal da Bia",
    serverIconUrl: null,
    plan: { id: offer.plan!.id, name: "VIP", priceCents: 990, currency: "BRL" },
    status: "pending",
    hasAccess: false,
    periodStart: null,
    periodEnd: null,
    graceEndsAt: null,
    renewalDue: false,
    refundableUntil: null,
    firstPaidAt: null,
    cancelledAt: null,
    refundedAt: null,
    seller: { name: "Bia", providerLabel: "Sandbox" },
    pendingAttempt: null,
    receipts: [],
    ...patch,
  };
}

describe("BauPlusPaywall", () => {
  it("is a live button with the monthly price, described by the sentence above it", () => {
    const html = renderToStaticMarkup(
      <BauPlusPaywall
        offer={offer}
        serverName="Canal da Bia"
        onStart={() => {}}
      />,
    );
    expect(html).toContain("data-bau-paywall-cta");
    expect(html).toContain("Support for R$9.90/month");
    expect(html).not.toMatch(/<button[^>]*\sdisabled=""/);
    expect(html).toContain('role="group"');
    const describedBy = /aria-describedby="([^"]+)"/.exec(html)?.[1];
    expect(describedBy).toBeTruthy();
    expect(html).toContain(`id="${describedBy}"`);
    // The blurred lines are decoration, never the post.
    expect(html).toMatch(/<p aria-hidden="true" class="bau-blur-text/);
  });

  it("says continue while a Pix is open, and come back after VIP ran out", () => {
    const pending = renderToStaticMarkup(
      <BauPlusPaywall
        offer={{
          ...offer,
          membership: membership({
            pendingAttempt: {
              id: "00000000-0000-4000-8000-000000000004",
              membershipId: "00000000-0000-4000-8000-000000000003",
              serverId: offer.plan!.serverId,
              method: "pix",
              kind: "first",
              status: "pending",
              amountCents: 990,
              currency: "BRL",
              pixCode: "000201",
              redirectUrl: null,
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              paidAt: null,
              failureReason: null,
              createdAt: new Date().toISOString(),
              sandbox: true,
            },
          }),
        }}
        serverName="Canal da Bia"
        onStart={() => {}}
      />,
    );
    expect(pending).toContain("Continue the payment");

    const lapsed = renderToStaticMarkup(
      <BauPlusPaywall
        offer={{ ...offer, membership: membership({ status: "expired" }) }}
        serverName="Canal da Bia"
        onStart={() => {}}
      />,
    );
    expect(lapsed).toContain("Back to VIP for R$9.90/month");
  });
});

describe("Baú+ formatting", () => {
  it("money follows the language, the currency is always the real", () => {
    expect(formatBrl(990, "pt-BR").replace(/\s/g, " ")).toBe("R$ 9,90");
    expect(formatBrl(990, "en")).toBe("R$9.90");
  });

  it("dates are long so a sentence never ends in a double period", () => {
    const now = new Date("2026-11-02T12:00:00Z");
    expect(formatBauDay("2026-12-02T12:00:00Z", "pt-BR", now)).toBe(
      "2 de dezembro",
    );
    expect(formatBauDay("2027-01-05T12:00:00Z", "en", now)).toBe(
      "January 5, 2027",
    );
  });

  it("the countdown is minutes and padded seconds, never negative", () => {
    expect(formatCountdown(14 * 60_000 + 5_000)).toBe("14:05");
    expect(formatCountdown(-10)).toBe("0:00");
  });
});
