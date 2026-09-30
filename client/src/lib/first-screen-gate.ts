/**
 * "After the first screen is on the page", as a snippet for inline scripts.
 *
 * The landing page's first screen is plain HTML (`prerender-hero.ts`), and the
 * things that are not part of it (the app bundle, the analytics and advertising
 * tags) should not start downloading until it has been drawn: they share one
 * narrow connection with the stylesheet, the fonts and the pictures, and a
 * request that starts first finishes first. Lighthouse's model of the load makes
 * the same point from the other side, because it counts every request that
 * started before the largest contentful paint as something that paint waited
 * for.
 *
 * The snippet defines `afterFirstScreen(fn)`. `fn` runs once, 300 ms after the
 * last of these signals: the page's `load` event, and every
 * largest-contentful-paint candidate the browser reports (the text, then the
 * pictures as they arrive). Because each new signal restarts the 300 ms, `fn`
 * lands after the first screen has settled, not in the middle of it. A three
 * second ceiling covers a browser without the observer (Safari before 16.4, for
 * one), a picture that never arrives, and a tab that is not being shown.
 *
 * It is a string, not a function, because it is embedded verbatim into inline
 * scripts in `index.html` that cannot import anything. Keep it dependency-free
 * and ES5, and keep it in one place.
 */
export const AFTER_FIRST_SCREEN_JS =
  "function afterFirstScreen(fn){var t,d=false;function run(){if(d)return;d=true;clearTimeout(t);fn()}function arm(){if(d)return;clearTimeout(t);t=setTimeout(run,300)}try{new PerformanceObserver(arm).observe({type:\"largest-contentful-paint\",buffered:true})}catch(e){}if(document.readyState===\"complete\"){arm()}else{addEventListener(\"load\",arm)}setTimeout(run,3000)}";
