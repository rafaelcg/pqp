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
 * three second ceiling), or for the visitor's first touch, click, key press or
 * wheel turn (the same list as `INTERACTIONS` in `boot-gate.ts`), then requests
 * the bundle.
 *
 * WHAT THIS COSTS. On a slow link the app becomes interactive a little later
 * than it would have (by however long the picture takes), and until then the
 * calls to action are plain links to `/app`. What it buys is that the
 * stylesheet, the fonts and the pictures have the pipe to themselves while the
 * first screen is being built.
 *
 * Nothing else changes: the same file, the same `type="module"` and CORS mode,
 * and the app still decides for itself when to render (`boot-gate.ts`).
 */

import { AFTER_FIRST_SCREEN_JS } from "./first-screen-gate";

/** The single module entry tag Vite emits, as it emits it. */
const ENTRY_TAG = /<script type="module" crossorigin src="([^"]+)"><\/script>/;

export function deferEntryLoader(
  src: string,
  appChunk?: string,
  appDeps: readonly string[] = [],
): string {
  const url = JSON.stringify(src).replace(/</g, "\\u003c");
  // On `/app` the shell is about to import the chat client (`App-*.js`, 2 MB with
  // everything it imports). The entry only discovers that when it has downloaded
  // and run, which on a first visit is one full round trip later than it could
  // be: the preload starts the same download beside the entry instead. Nothing
  // else changes (a returning visitor has it in the service worker's precache
  // and the preload is answered from there).
  const preload = appChunk
    ? `var app=${JSON.stringify(appChunk).replace(/</g, "\\u003c")};if(/^\\/app(\\/|$)/.test(location.pathname)){var link=document.createElement("link");link.rel="modulepreload";link.crossOrigin="";link.href=app;document.head.appendChild(link)}`
    : "";
  // The chunks the chat client imports (75 of them, about 500 kB compressed)
  // were requested only once the entry had downloaded and run (Vite preloads a
  // dynamic import's dependencies when the import starts), one hop later than
  // they could be. They are asked for here too, after the entry and at low
  // priority, so they fill the link behind the entry and the chat client
  // instead of competing with them. A preload only fetches: nothing runs until
  // the app imports it, exactly as before.
  const deps =
    appChunk && appDeps.length > 0
      ? `function deps(){if(!/^\\/app(\\/|$)/.test(location.pathname))return;${JSON.stringify(appDeps).replace(/</g, "\\u003c")}.forEach(function(h){var l=document.createElement("link");l.rel="modulepreload";l.crossOrigin="";l.fetchPriority="low";l.href=h;document.head.appendChild(l)})}`
      : "function deps(){}";
  return `<script>(function(){${AFTER_FIRST_SCREEN_JS}${preload}${deps}var src=${url};function load(){if(load.d)return;load.d=1;var s=document.createElement("script");s.type="module";s.crossOrigin="";s.src=src;document.head.appendChild(s)}if(document.documentElement.getAttribute("data-route")!=="home"){load();deps();return}afterFirstScreen(load);["pointerdown","keydown","touchstart","wheel"].forEach(function(e){addEventListener(e,load,{once:true,passive:true,capture:true})})})();</script>`;
}

/**
 * Swap the entry tag for the loader. Returns the html unchanged when there is
 * no such tag (or more than one shape of it), which keeps a custom build alive.
 *
 * `appChunkFile` is the file name of the chat client chunk (`assets/App-x.js`),
 * when the build has one: it is preloaded beside the entry on \`/app\` routes,
 * from the same directory the entry is served from. `appDepFiles` are the
 * chunks it imports, preloaded with it at low priority.
 */
export function deferEntryScript(
  html: string,
  appChunkFile?: string,
  appDepFiles: readonly string[] = [],
): string {
  const match = ENTRY_TAG.exec(html);
  if (!match) {
    return html;
  }
  const entry = match[1];
  const dir = entry.slice(0, entry.lastIndexOf("/") + 1);
  const served = (file: string) => dir + file.slice(file.lastIndexOf("/") + 1);
  const appChunk = appChunkFile ? served(appChunkFile) : undefined;
  // The entry is already on its way; preloading it again would only be noise.
  const appDeps = appDepFiles.map(served).filter((file) => file !== entry);
  return html.replace(match[0], () => deferEntryLoader(entry, appChunk, appDeps));
}
