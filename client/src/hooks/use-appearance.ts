import { useCallback, useSyncExternalStore } from "react";
import {
  appearanceForcesDark,
  getAppearance,
  setAppearancePreference,
  subscribeAppearance,
  type AppearancePreference,
} from "@/lib/appearance";
import { setThemePreference } from "@/lib/theme";

interface UseAppearance {
  appearance: AppearancePreference;
  setAppearance: (appearance: AppearancePreference) => void;
}

export function useAppearance(): UseAppearance {
  const appearance = useSyncExternalStore(
    subscribeAppearance,
    getAppearance,
    getAppearance,
  );

  const setAppearance = useCallback((next: AppearancePreference) => {
    setAppearancePreference(next);
    // Night is a near-black look. Persist dark so leaving it later does not
    // snap back to a stale light preference.
    if (appearanceForcesDark(next)) {
      setThemePreference("dark");
    }
  }, []);

  return { appearance, setAppearance };
}
