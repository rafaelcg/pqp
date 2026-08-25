import { useCallback, useSyncExternalStore } from "react";
import {
  getContrastState,
  setContrastPreference,
  subscribeContrast,
  type ContrastPreference,
  type ResolvedContrast,
} from "@/lib/contrast";

interface UseContrast {
  preference: ContrastPreference;
  resolved: ResolvedContrast;
  setPreference: (preference: ContrastPreference) => void;
}

export function useContrast(): UseContrast {
  const state = useSyncExternalStore(
    subscribeContrast,
    getContrastState,
    getContrastState,
  );

  const setPreference = useCallback((preference: ContrastPreference) => {
    setContrastPreference(preference);
  }, []);

  return {
    preference: state.preference,
    resolved: state.resolved,
    setPreference,
  };
}
