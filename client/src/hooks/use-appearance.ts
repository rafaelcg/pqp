import { useCallback, useSyncExternalStore } from "react";
import {
  getAppearance,
  setAppearancePreference,
  subscribeAppearance,
  type AppearancePreference,
} from "@/lib/appearance";

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
  }, []);

  return { appearance, setAppearance };
}
