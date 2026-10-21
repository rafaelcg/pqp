/**
 * A cartridge going into the console: the first visit's step 4 ("Bota a primeira fita") and the overlay that puts a
 * game in (load-flow). Both draw the same picture, so the second one is the first one come true.
 *
 * The console is `src/art/console.webp`, a top-loader with its slot open on the top face. The cartridge is the pixel
 * art sprite (`cart-blank.webp` for the NES and SNES, `cart-gb.webp` for the handhelds), never redrawn in code; its
 * blank label carries the game's title, so the cartridge on screen is the game being put in. It is skewed to the
 * slot's angle and lives in a layer clipped along the slot's front lip: whatever of it is below that line is inside
 * the console, and the console's front face shows where it went. Over the console, the power light (a glow on the
 * small pill right of the slot) comes on once the cartridge is in.
 *
 * The scene is a box of the console's width with headroom above it for the whole cartridge, so a cartridge waiting
 * over the slot is never cut, at any size: every position below is a percentage of that box (see onboarding.css,
 * where the numbers are measured on the picture).
 *
 * The pictures and the motion are CSS (`onboarding.css` lays the scene out and loops it, `flow.css` drops it once and
 * lights it per phase), because the frame's CSP allows no inline style and the art is referenced from the
 * stylesheet. The title is text, set with `textContent`, so nothing from outside is ever parsed as markup.
 *
 * The class names are `loc-ins-*` and never the shelf's `loc-cart-*`: the two cartridges are different drawings,
 * and a rule of one must not reach the other.
 */
import type { BoxPlatform } from "../boxart";
import { h } from "./dom";

export interface CartridgeSceneOptions {
  title: string;
  platform: BoxPlatform;
}

/** Which sprite a console's cartridge is: the tall handheld one, or the wide one of the home consoles. */
export function cartKind(platform: BoxPlatform): "gb" | "big" {
  return platform === "gb" || platform === "gbc" || platform === "gba" ? "gb" : "big";
}

/** The scene alone: the console, the cartridge (sprite and label) in its clipped layer, the power light. */
export function createCartridge({ title, platform }: CartridgeSceneOptions): HTMLElement {
  const kind = cartKind(platform);
  const label = h("span", { class: "loc-ins-label" }, h("span", { class: "loc-ins-title" }, title));
  const cart = h("span", { class: "loc-ins-cart" }, h("span", { class: "loc-ins-sprite" }), label);
  return h(
    "span",
    { class: "loc-cart-scene loc-ins", "data-kind": kind },
    h("span", { class: "loc-ins-floor" }),
    h("span", { class: "loc-ins-console" }),
    h("span", { class: "loc-ins-clip" }, cart),
    h("span", { class: "loc-ins-led" }),
  );
}

/** The scene in a holder element, hidden from assistive tech: the text around it says what is happening. */
export function createCartridgeScene(options: CartridgeSceneOptions, className = "loc-ins-holder"): HTMLElement {
  const holder = h("span", { class: className, "aria-hidden": "true" });
  holder.append(createCartridge(options));
  return holder;
}
