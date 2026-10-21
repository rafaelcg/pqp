/**
 * The sign over the door (mock 1, SPEC 7): the house name in neon, a line under it.
 *
 * It powers on once per session, the first time the Balcão is drawn: 1.2 s, two
 * dips (to 25% and to 50%) and then steady, never more than three changes a second
 * (WCAG 2.3.1). With reduced motion the CSS simply has no animation, so the sign
 * is steady from the first frame whatever `powerOn` says.
 */
import { h } from "./dom";

export interface NeonSignOptions {
  size: "sm" | "lg";
  powerOn: boolean;
  /** The line under (or beside) the name, "a prateleira é tua". */
  sub?: string;
  /** The house name. A brand, not translated. */
  name?: string;
}

export interface NeonSign {
  readonly element: HTMLElement;
  setSub(text: string): void;
}

let poweredOnThisSession = false;

/** True the first time it is asked in a session and false after: hand it to `powerOn`. */
export function consumePowerOn(): boolean {
  const first = !poweredOnThisSession;
  poweredOnThisSession = true;
  return first;
}

/** Tests only. */
export function resetPowerOn(): void {
  poweredOnThisSession = false;
}

export function createNeonSign(opts: NeonSignOptions): NeonSign {
  const name = opts.name ?? "Locadora";
  const sub = h("span", { class: "loc-sign-sub" }, opts.sub ?? "");
  sub.hidden = !opts.sub;
  const element = h(
    "div",
    { class: "loc-sign", "data-size": opts.size, "data-power-on": opts.powerOn },
    h("h1", { class: "loc-sign-neon" }, name),
    sub,
  );
  return {
    element,
    setSub(text) {
      sub.textContent = text;
      sub.hidden = text === "";
    },
  };
}
