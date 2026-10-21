import { describe, expect, it } from "vitest";
import en from "../locales/en/translation.json";
import es from "../locales/es/translation.json";
import ptBR from "../locales/pt-BR/translation.json";
import { ACCOUNT_LINE_CLAIMS, UPSELL_CLAIMS, claimView, type Claim, type ClaimGate } from "./locadora-claims";

/**
 * THE TRUTH TAGS, ENFORCED. The launch copy tags every claim with the gate
 * that makes it true. A claim whose words promise a gated feature must carry
 * that gate, or this fails: the words are read in all three languages, so
 * "saves na nuvem" filed as `live` cannot ship by accident.
 */

const catalogues = { en, "pt-BR": ptBR, es } as Record<string, Record<string, string>>;

/** Words that only a gated claim may say, per gate. */
const GATED_WORDS: Record<Exclude<ClaimGate, "live">, RegExp> = {
  cloudSaves: /nuvem|cloud|nube|na tua conta|on your account|en tu cuenta|outro aparelho|another device|otro dispositivo|continua no celular|carry on on your phone|sigue en el celular/i,
  share: /assist|watch|miran|mirar/i,
  shelf: /jogos livres|free games|juegos libres|homebrew shelf|prateleira de jogos/i,
};

function words(claim: Claim): string {
  return Object.values(catalogues)
    .map((catalogue) => `${catalogue[claim.titleKey] ?? ""} ${catalogue[claim.bodyKey] ?? ""}`)
    .join(" ");
}

describe("every claim the Locadora pages draw", () => {
  const all = [...ACCOUNT_LINE_CLAIMS, ...UPSELL_CLAIMS];

  it.each(all.map((claim) => [claim.titleKey, claim] as const))("%s carries the gate its words need", (_key, claim) => {
    const text = words(claim);
    for (const [gate, pattern] of Object.entries(GATED_WORDS)) {
      if (pattern.test(text)) expect(claim.requires, `${claim.titleKey} says ${pattern}`).toBe(gate);
    }
  });

  it("has its copy in all three languages", () => {
    for (const claim of all) {
      for (const [locale, catalogue] of Object.entries(catalogues)) {
        expect(catalogue[claim.titleKey], `${locale} ${claim.titleKey}`).toBeTruthy();
        expect(catalogue[claim.bodyKey], `${locale} ${claim.bodyKey}`).toBeTruthy();
      }
    }
  });

  it("files cloud saves under its flag and watching under the share", () => {
    expect(ACCOUNT_LINE_CLAIMS.find((claim) => claim.id === "saves")?.requires).toBe("cloudSaves");
    expect(ACCOUNT_LINE_CLAIMS.find((claim) => claim.id === "watch")?.requires).toBe("share");
    expect(UPSELL_CLAIMS.find((claim) => claim.id === "saves")?.requires).toBe("cloudSaves");
  });
});

describe("claimView", () => {
  it("draws a live claim, mutes cloud saves until announced, and hides what no page can know", () => {
    expect(claimView({ requires: "live" }, { cloudSaves: false })).toBe("shown");
    expect(claimView({ requires: "cloudSaves" }, { cloudSaves: false })).toBe("soon");
    expect(claimView({ requires: "cloudSaves" }, { cloudSaves: true })).toBe("shown");
    expect(claimView({ requires: "share" }, { cloudSaves: true })).toBe("hidden");
    expect(claimView({ requires: "shelf" }, { cloudSaves: true })).toBe("hidden");
  });
});
