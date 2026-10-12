import { useCallback, useSyncExternalStore } from "react";
import {
  getAppearance,
  getLook,
  setAppearancePreference,
  subscribeAppearance,
  type AppearancePreference,
  type Look,
} from "@/lib/appearance";

interface UseAppearance {
  /** The synced preference: the look under Modo 2005 when that is on. */
  appearance: AppearancePreference;
  /** What is painted, `retro` included. */
  look: Look;
  setAppearance: (appearance: AppearancePreference) => void;
}

export function useAppearance(): UseAppearance {
  const appearance = useSyncExternalStore(
    subscribeAppearance,
    getAppearance,
    getAppearance,
  );
  const look = useSyncExternalStore(subscribeAppearance, getLook, getLook);

  const setAppearance = useCallback((next: AppearancePreference) => {
    setAppearancePreference(next);
  }, []);

  return { appearance, look, setAppearance };
}

/** Whether Modo 2005 is painted right now. The cheap check for a component. */
export function useRetroLook(): boolean {
  const look = useSyncExternalStore(subscribeAppearance, getLook, getLook);
  return look === "retro";
}
