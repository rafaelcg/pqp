/**
 * Third-party tags that load after the page, not with it.
 *
 * The analytics and advertising tags (see `vite.config.ts` and
 * `google-ads-tag.ts`) used to be plain `<script src>` elements in `<head>`.
 * Both are async, so neither blocks parsing, but they still start downloading
 * at the top of the page, run their own work while the first screen is being
 * built, and on a phone in a slow network they take a share of the bandwidth the
 * page's own stylesheet and picture are waiting for. Nothing about counting a
 * visit needs to happen before the page is drawn.
 *
 * WHAT THIS CHANGES, AND WHAT IT DOES NOT. The tag is requested once the
 * browser has finished loading the page and has a free moment
 * (`requestIdleCallback`, with a timeout so a busy main thread cannot hold it
 * back for long), or on the visitor's first touch, click or key press,
 * whichever comes first. On the home page it also waits for the first screen to
 * settle (`first-screen-gate.ts`), so it never starts before the picture the
 * page is judged on has been drawn. Whether a tag exists at all is decided at
 * build time
 * exactly as before: a build without its id or website id emits nothing, and
 * this module is only ever handed an id that is already set. It adds no consent
 * step and removes none. A visit that ends before the browser is idle is not
 * counted, which on a page that loads in a second or two is a small fraction of
 * visits and is the price of not competing with the first paint.
 *
 * The output is one inline script, built here so the escaping lives in one
 * place and `deferred-tag.test.ts` can pin it.
 */

import type { HtmlTagDescriptor } from "vite";
import { AFTER_FIRST_SCREEN_JS } from "./first-screen-gate";

export interface DeferredScriptOptions {
  /** Attributes copied onto the created `<script>`, e.g. `data-website-id`. */
  attrs?: Record<string, string>;
  /** Longest wait, in ms, for a quiet moment before loading anyway. */
  idleTimeoutMs?: number;
}

/** JSON for embedding in an inline script: `<` escaped so `</script>` cannot close it. */
function js(value: string): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/** The inline source that requests `src` once the page is done and idle. */
export function deferredScriptSource(
  src: string,
  { attrs = {}, idleTimeoutMs = 3000 }: DeferredScriptOptions = {},
): string {
  const setAttrs = Object.entries(attrs)
    .map(
      ([name, value]) =>
        `s.setAttribute(${js(name)},${js(value)});`,
    )
    .join("");
  return [
    "(function(){",
    "var done=false;",
    `function go(){if(done)return;done=true;var s=document.createElement("script");s.async=true;s.src=${js(src)};${setAttrs}document.head.appendChild(s)}`,
    AFTER_FIRST_SCREEN_JS,
    `function idle(){if("requestIdleCallback" in window){requestIdleCallback(go,{timeout:${idleTimeoutMs}})}else{setTimeout(go,1500)}}`,
    // On the home page the first screen is what matters: wait until it has
    // settled. Everywhere else, once the page has loaded and the browser is idle.
    'if(document.documentElement.getAttribute("data-route")==="home"){afterFirstScreen(idle)}else if(document.readyState==="complete"){idle()}else{addEventListener("load",idle,{once:true})}',
    '["pointerdown","keydown","touchstart"].forEach(function(e){addEventListener(e,go,{once:true,passive:true,capture:true})});',
    "})();",
  ].join("");
}

/** The same, as a Vite head tag. */
export function deferredScriptTag(
  src: string,
  options?: DeferredScriptOptions,
): HtmlTagDescriptor {
  return {
    tag: "script",
    injectTo: "head",
    children: deferredScriptSource(src, options),
  };
}
