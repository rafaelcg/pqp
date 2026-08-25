import { useCallback, useSyncExternalStore } from "react";
import {
  getAccentHue,
  setAccentHuePreference,
  subscribeAccentHue,
  type AccentHuePreference,
} from "@/lib/accent";

interface UseAccentHue {
  preference: AccentHuePreference;
  setPreference: (preference: AccentHuePreference) => void;
}

export function useAccentHue(): UseAccentHue {
  const preference = useSyncExternalStore(
    subscribeAccentHue,
    getAccentHue,
    getAccentHue,
  );

  const setPreference = useCallback((next: AccentHuePreference) => {
    setAccentHuePreference(next);
  }, []);

  return { preference, setPreference };
}
