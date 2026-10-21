/**
 * The screen menu (mock 4, SPEC 4.6 and 14): scale, aspect, and three switches.
 * Plain DOM with the roles of a menu: `menuitemradio` for the two choices,
 * `menuitemcheckbox` for the switches, arrows to move, Space or Enter to pick,
 * `1` and `2` for the scale, Escape to close and give the focus back.
 *
 * It only holds the state it is shown; whoever mounts it (the HUD) passes the
 * stage's settings in and takes `onChange` back out.
 */
import { formatFactor, type AspectMode, type ScaleMode } from "../stage";
import type { Strings } from "../i18n";
import { h } from "./dom";

export type ScreenMenuStrings = Pick<
  Strings,
  | "hud.screen"
  | "screen.pixel"
  | "screen.fit"
  | "screen.tv"
  | "screen.square"
  | "screen.crt"
  | "screen.ambient"
  | "screen.bezel"
  | "screen.scaleTitle"
  | "screen.aspectTitle"
  | "screen.pixelHint"
  | "screen.fitHint"
>;

export interface ScreenMenuState {
  scale: ScaleMode;
  aspect: AspectMode;
  crt: boolean;
  ambient: boolean;
  bezel: boolean;
  /** The whole number of device pixels per game pixel Pixel perfeito would use in this room; null when it would fall back. */
  intScale: number | null;
  /** False for handhelds: no "Como na TV". */
  tvAvailable?: boolean;
  /** The language's tag, for the decimal mark. */
  locale?: string | undefined;
}

export type ScreenMenuChange = Partial<Pick<ScreenMenuState, "scale" | "aspect" | "crt" | "ambient" | "bezel">>;

export interface ScreenMenuOptions extends ScreenMenuState {
  t: ScreenMenuStrings;
  onChange: (change: ScreenMenuChange) => void;
  /** Called after the menu closes itself (Escape, a click outside). */
  onClose?: () => void;
}

export interface ScreenMenu {
  readonly element: HTMLElement;
  readonly isOpen: boolean;
  open(): void;
  close(): void;
  toggle(): void;
  /** Redraws from new state (the room changed, the setting was changed from elsewhere). */
  update(state: Partial<ScreenMenuState>): void;
  destroy(): void;
}

export function createScreenMenu(options: ScreenMenuOptions): ScreenMenu {
  const { t } = options;
  let state: ScreenMenuState = { tvAvailable: true, ...options };
  let open = false;
  let opener: Element | null = null;

  const root = h("div", { class: "loc-menu", role: "menu", "aria-label": t["hud.screen"], hidden: true });

  const items: HTMLButtonElement[] = [];

  function radio(label: string, hint: () => string, key: string, kbd: string | undefined, pick: () => void) {
    const hintNode = h("small", {}, hint());
    const button = h(
      "button",
      { type: "button", class: "loc-menu-item", role: "menuitemradio", "aria-checked": "false", "data-key": key, tabindex: -1 },
      h("span", { class: "loc-menu-radio", "aria-hidden": "true" }),
      h("span", { class: "loc-menu-label" }, label, hintNode.textContent ? h("br") : null, hintNode.textContent ? hintNode : null),
      kbd ? h("kbd", {}, kbd) : h("span"),
    );
    button.addEventListener("click", pick);
    items.push(button);
    return { button, hintNode, hint };
  }

  function toggle(label: string, key: "crt" | "ambient" | "bezel") {
    const button = h(
      "button",
      { type: "button", class: "loc-menu-item loc-menu-toggle", role: "menuitemcheckbox", "aria-checked": "false", "data-key": key, tabindex: -1 },
      h("span", { class: "loc-menu-label" }, label),
      h("span", { class: "loc-menu-switch", "aria-hidden": "true" }),
    );
    button.addEventListener("click", () => options.onChange({ [key]: !state[key] }));
    items.push(button);
    return button;
  }

  const pixelHint = () => (state.intScale === null ? t["screen.fitHint"] : t["screen.pixelHint"].split("{k}").join(formatFactor(state.intScale, state.locale, 2)));

  const pixel = radio(t["screen.pixel"], pixelHint, "pixel", "1", () => options.onChange({ scale: "pixel" }));
  const fit = radio(t["screen.fit"], () => t["screen.fitHint"], "fit", "2", () => options.onChange({ scale: "fit" }));
  const square = radio(t["screen.square"], () => "", "square", undefined, () => options.onChange({ aspect: "square" }));
  const tv = radio(t["screen.tv"], () => "", "tv", undefined, () => options.onChange({ aspect: "tv" }));
  const crt = toggle(t["screen.crt"], "crt");
  const ambient = toggle(t["screen.ambient"], "ambient");
  const bezel = toggle(t["screen.bezel"], "bezel");

  const aspectGroup = h("div", { role: "group", "aria-label": t["screen.aspectTitle"] }, square.button, tv.button);
  root.append(
    h("h3", {}, t["screen.scaleTitle"]),
    h("div", { role: "group", "aria-label": t["screen.scaleTitle"] }, pixel.button, fit.button),
    h("div", { class: "loc-menu-rule", role: "separator" }),
    h("h3", {}, t["screen.aspectTitle"]),
    aspectGroup,
    h("div", { class: "loc-menu-rule", role: "separator" }),
    crt,
    ambient,
    bezel,
  );

  function paint() {
    const check = (button: HTMLElement, on: boolean) => button.setAttribute("aria-checked", String(on));
    check(pixel.button, state.scale === "pixel");
    check(fit.button, state.scale === "fit");
    check(square.button, state.aspect === "square");
    check(tv.button, state.aspect === "tv");
    check(crt, state.crt);
    check(ambient, state.ambient);
    check(bezel, state.bezel);
    const hintNode = pixel.hintNode;
    hintNode.textContent = pixel.hint();
    aspectGroup.hidden = state.tvAvailable === false;
    // the aspect heading and its rule go with the group
    const heading = aspectGroup.previousElementSibling;
    if (heading) (heading as HTMLElement).hidden = state.tvAvailable === false;
  }

  /** The items a person can reach, in order. */
  const reachable = () => items.filter((item) => !item.closest("[hidden]"));

  function focusItem(index: number) {
    const list = reachable();
    if (list.length === 0) return;
    const next = list[(index + list.length) % list.length]!;
    for (const item of items) item.tabIndex = item === next ? 0 : -1;
    next.focus();
  }

  root.addEventListener("keydown", (event) => {
    const list = reachable();
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusItem(at + 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        focusItem(at < 0 ? -1 : at - 1);
        break;
      case "Home":
        event.preventDefault();
        focusItem(0);
        break;
      case "End":
        event.preventDefault();
        focusItem(-1);
        break;
      case "1":
        options.onChange({ scale: "pixel" });
        break;
      case "2":
        options.onChange({ scale: "fit" });
        break;
      case "Escape":
        // the page's own Escape (leave full screen) must not also run
        event.preventDefault();
        event.stopPropagation();
        close();
        options.onClose?.();
        break;
      case "Tab":
        // a menu is one tab stop: leaving it closes it
        close();
        options.onClose?.();
        break;
      default:
    }
  });

  const outside = (event: Event) => {
    if (!open) return;
    if (event.target instanceof Node && !root.contains(event.target) && !opener?.contains(event.target)) {
      close();
      options.onClose?.();
    }
  };

  function openMenu() {
    if (open) return;
    open = true;
    opener = document.activeElement;
    root.hidden = false;
    paint();
    document.addEventListener("pointerdown", outside, true);
    const checked = reachable().find((item) => item.getAttribute("aria-checked") === "true") ?? reachable()[0];
    focusItem(checked ? reachable().indexOf(checked) : 0);
  }

  function close() {
    if (!open) return;
    open = false;
    root.hidden = true;
    document.removeEventListener("pointerdown", outside, true);
    if (opener instanceof HTMLElement) opener.focus();
    opener = null;
  }

  paint();

  return {
    element: root,
    get isOpen() {
      return open;
    },
    open: openMenu,
    close,
    toggle() {
      if (open) close();
      else openMenu();
    },
    update(next) {
      state = { ...state, ...next };
      paint();
    },
    destroy() {
      document.removeEventListener("pointerdown", outside, true);
      root.remove();
    },
  };
}
