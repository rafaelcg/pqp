/**
 * On the home page, start the app bundle after the first paint, not before it.
 *
 * Vite writes the entry as `<script type="module" src="/assets/index-….js">` in
 * the head. Its 300 kB is discovered and requested at the very top of the
 * response, at the same priority as the stylesheet, so on a slow link the
 * bundle and the things the first screen is drawn from (stylesheet, fonts,
 * pictures) share one narrow pipe, and the first screen waits for a script it
 * does not need in order to be drawn: the home page is already plain HTML
 * (`prerender-hero.ts`).
 *
 * This replaces that tag with a small inline loader. On every other route it
 * creates the same module script at once, in the same place in the document, so
 * `/app` and the rest boot exactly as before (a script inserted by an inline
 * script during parsing is fetched immediately). On the home route it waits
 * until the first screen has settled (`first-screen-gate.ts`: the `load` event
 * and every largest-contentful-paint candidate, then 300 ms of quiet, with a
 * three second ceiling), or for the visitor's first touch, click or key press,
 * then requests the bundle.
 *
 * WHAT THIS COSTS. On a slow link the app becomes interactive a little later
 * than it would have (by however long the picture takes), and until then the
 * two calls to action are plain links to `/app`. What it buys is that the
 * stylesheet, the fonts and the pictures have the pipe to themselves while the
 * first screen is being built.
 *
 * Nothing else changes: the same file, the same `type="module"` and CORS mode,
 * and the app still decides for itself when to render (`boot-gate.ts`).
 */

import { AFTER_FIRST_SCREEN_JS } from "./first-screen-gate";

/** The single module entry tag Vite emits, as it emits it. */
const ENTRY_TAG = /<script type="module" crossorigin src="([^"]+)"><\/script>/;

export function deferEntryLoader(src: string): string {
  const url = JSON.stringify(src).replace(/</g, "\\u003c");
  return `<script>(function(){${AFTER_FIRST_SCREEN_JS}var src=${url};function load(){if(load.d)return;load.d=1;var s=document.createElement("script");s.type="module";s.crossOrigin="";s.src=src;document.head.appendChild(s)}if(document.documentElement.getAttribute("data-route")!=="home"){load();return}afterFirstScreen(load);["pointerdown","keydown","touchstart"].forEach(function(e){addEventListener(e,load,{once:true,passive:true,capture:true})})})();</script>`;
}

/**
 * Swap the entry tag for the loader. Returns the html unchanged when there is
 * no such tag (or more than one shape of it), which keeps a custom build alive.
 */
export function deferEntryScript(html: string): string {
  const match = ENTRY_TAG.exec(html);
  if (!match) {
    return html;
  }
  return html.replace(match[0], () => deferEntryLoader(match[1]));
}
