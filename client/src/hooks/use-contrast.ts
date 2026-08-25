import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
  getContrastState,
  prefersMoreContrastQuery,
  setContrastPreference,
  subscribeContrast,
  syncSystemContrast,
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

  useEffect(() => {
    if (state.preference !== "system") {
      return;
    }
    const query = prefersMoreContrastQuery();
    if (!query) {
      return;
    }
    const onChange = () => {
      syncSystemContrast();
    };
    query.addEventListener("change", onChange);
    return () => {
      query.removeEventListener("change", onChange);
    };
  }, [state.preference]);

  const setPreference = useCallback((preference: ContrastPreference) => {
    setContrastPreference(preference);
  }, []);

  return {
    preference: state.preference,
    resolved: state.resolved,
    setPreference,
  };
}
