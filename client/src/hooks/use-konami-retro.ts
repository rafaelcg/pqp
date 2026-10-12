import { useEffect } from "react";
import { createKonamiMatcher, isEditableTarget, konamiKey } from "@/lib/konami";
import { toggleRetroLook } from "@/lib/retro-look";

/**
 * One keydown listener for the app shell: the Konami code flips Modo 2005,
 * the same toggle `/2005` runs. Nothing is sent anywhere.
 */
export function useKonamiRetro(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) {
      return;
    }
    const matcher = createKonamiMatcher();
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.repeat ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        isEditableTarget(event.target)
      ) {
        return;
      }
      if (matcher.push(konamiKey(event.key, event.code), Date.now())) {
        void toggleRetroLook();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [enabled]);
}
