/**
 * Regras da casa (mock 1, SPEC 4.1): the three rules on a receipt with a stamp.
 * Always on the Balcão; `compact` is the smaller one beside the Continuar card,
 * the full one is the empty shelf's. Rule 2 is the test-pinned `privacy` line.
 * The house never rents or provides a game, and the file never leaves the
 * device: those lines are legal posture, so there is no way to collapse them.
 */
import type { Strings } from "../i18n";
import { h } from "./dom";
import { icon, type IconName } from "./top-bar";

export type HouseRulesStrings = Pick<Strings, "rules.title" | "rules.stamp" | "rules.1" | "privacy" | "rules.3" | "rules.sync" | "rules.guest">;

export interface HouseRulesOptions {
  t: HouseRulesStrings;
  compact: boolean;
  /**
   * Saves na conta answers for this session: one more line says the saves (never the game) also go to the account.
   * The `privacy` line stays as it is, because it is about the game file and that is still true.
   */
  synced?: boolean;
  /**
   * The signed-out guest player (`hello.guest`): one more line says the shelf lives in this browser only, apart
   * from any account. Never together with `synced`, which a guest cannot have.
   */
  guest?: boolean;
}

export interface HouseRules {
  readonly element: HTMLElement;
  update(patch: { compact: boolean }): void;
}

export function createHouseRules(opts: HouseRulesOptions): HouseRules {
  const { t } = opts;
  const rules: Array<[IconName, string]> = [
    ["shield", t["rules.1"]],
    ["screen", t.privacy],
    ["check", t["rules.3"]],
    ...(opts.synced && !opts.guest ? ([["cloud", t["rules.sync"]]] as Array<[IconName, string]>) : []),
    ...(opts.guest ? ([["device", t["rules.guest"]]] as Array<[IconName, string]>) : []),
  ];
  const headingId = "loc-rules-heading";
  const element = h(
    "aside",
    { class: "loc-rules", "aria-labelledby": headingId, "data-compact": opts.compact },
    h("span", { class: "loc-rules-stamp", "aria-hidden": "true" }, t["rules.stamp"]),
    h("h3", { class: "loc-rules-title", id: headingId }, t["rules.title"]),
    h("ul", { class: "loc-rules-list" }, ...rules.map(([name, text]) => h("li", {}, icon(name, 18), h("span", {}, text)))),
  );
  return {
    element,
    update(patch) {
      if (patch.compact) element.setAttribute("data-compact", "");
      else element.removeAttribute("data-compact");
    },
  };
}
