import { useEffect } from "react";
import { registerServiceWorker } from "@/lib/register-sw";
import { setUpdateWaiting } from "@/lib/update-prompt-state";

/**
 * The service worker's half of "a new version is ready". Renders nothing.
 *
 * It used to be a card in the corner of the screen. A card is an interruption,
 * and on 2026-10-13 a person was shown one every few seconds all evening
 * (nineteen web deploys in a day, every one announced to every open window). Now
 * it only listens: when the browser says a new worker is waiting
 * (`registerType: "prompt"` is still how the worker is registered), it records
 * that, and `UpdateIndicator` (a small round button with a dot, in the rail and
 * on the phone's "tu" tab) is what a person sees. Nothing here, or there, ever
 * opens by itself or reloads by itself in a call.
 *
 * WHEN a new build is told to an open page, and when a page reloads on its own,
 * are `lib/version-watch.ts` and `BuildWatcher`; see `docs/PWA.md` ("Nobody
 * stays on an old bundle").
 *
 * Mounted in `main.tsx`, outside `App`, because a waiting worker matters on
 * every route.
 */
export function UpdatePrompt({
  /**
   * Test seam. `virtual:pwa-register` only exists after vite-plugin-pwa has
   * run, so nothing outside a real build can make a build "arrive".
   */
  register = registerServiceWorker,
}: {
  register?: typeof registerServiceWorker;
} = {}) {
  useEffect(() => {
    const controls = register(() => setUpdateWaiting(true));
    return () => controls.dispose();
  }, [register]);

  return null;
}
