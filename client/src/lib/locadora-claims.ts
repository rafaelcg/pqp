import type { MessageKey } from "./i18n";

/**
 * WHAT THE LOCADORA PAGES MAY CLAIM, AS DATA.
 *
 * The launch copy (`locadora-launch-copy-2026-10-21/COPY.md`) tags each claim
 * with the gate that makes it true: `live` today, or one that is still closed
 * (Saves na conta, watching a friend play, the free-games shelf). A tagged
 * claim must be hidden or written "em breve" until its gate opens. So every
 * claim the pages draw is a row here with its `requires`, and the pages call
 * `claimView` instead of deciding for themselves; `locadora-claims.test.ts`
 * fails when a claim whose words promise a gated feature is filed as `live`.
 *
 * What each gate is today:
 * - `cloudSaves`: the public apps config's `cloudSaves` (runtime flag
 *   `locadora_saves_announced`). Closed, the claim is drawn muted with "em
 *   breve": it is planned and the copy says so.
 * - `share` and `shelf`: nothing tells a signed-out page; closed always, and
 *   hidden (not "em breve"), because the lawyer's answer and the shelf are not
 *   dated.
 */

export type ClaimGate = "live" | "cloudSaves" | "share" | "shelf";

export interface Claim {
  id: string;
  titleKey: MessageKey;
  bodyKey: MessageKey;
  requires: ClaimGate;
}

export interface ClaimGates {
  cloudSaves: boolean;
}

export type ClaimView = "shown" | "soon" | "hidden";

/** How one claim is drawn under the gates as they are now. */
export function claimView(claim: Pick<Claim, "requires">, gates: ClaimGates): ClaimView {
  switch (claim.requires) {
    case "live":
      return "shown";
    case "cloudSaves":
      return gates.cloudSaves ? "shown" : "soon";
    case "share":
    case "shelf":
      return "hidden";
  }
}

/** "O que tu ganha com uma conta", in order. */
export const ACCOUNT_CLAIMS: readonly Claim[] = [
  {
    id: "saves",
    titleKey: "locadoraPage.account.saves.title",
    bodyKey: "locadoraPage.account.saves.body",
    requires: "cloudSaves",
  },
  {
    id: "call",
    titleKey: "locadoraPage.account.call.title",
    bodyKey: "locadoraPage.account.call.body",
    requires: "live",
  },
  {
    id: "watch",
    titleKey: "locadoraPage.account.watch.title",
    bodyKey: "locadoraPage.account.watch.body",
    requires: "share",
  },
  {
    id: "chat",
    titleKey: "locadoraPage.account.chat.title",
    bodyKey: "locadoraPage.account.chat.body",
    requires: "live",
  },
];

/** The lines of the guest player's sign-up card, in order. */
export const UPSELL_CLAIMS: readonly Claim[] = [
  {
    id: "saves",
    titleKey: "locadoraGuest.upsell.saves",
    bodyKey: "locadoraGuest.upsell.saves",
    requires: "cloudSaves",
  },
  {
    id: "call",
    titleKey: "locadoraGuest.upsell.call",
    bodyKey: "locadoraGuest.upsell.call",
    requires: "live",
  },
  {
    id: "rest",
    titleKey: "locadoraGuest.upsell.rest",
    bodyKey: "locadoraGuest.upsell.rest",
    requires: "live",
  },
];
