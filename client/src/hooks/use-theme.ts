import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
  getThemeState,
  prefersDarkQuery,
  setThemePreference,
  subscribeTheme,
  syncSystemTheme,
  type ResolvedTheme,
  type ThemePreference,
} from "@/lib/theme";

interface UseTheme {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
}

export function useTheme(): UseTheme {
  const state = useSyncExternalStore(subscribeTheme, getThemeState, getThemeState);

  useEffect(() => {
    // Nothing to follow unless the user asked to follow the OS.
    if (state.preference !== "system") {
      return;
    }
    const query = prefersDarkQuery();
    if (!query) {
      return;
    }
    const onChange = () => {
      syncSystemTheme();
    };
    query.addEventListener("change", onChange);
    return () => {
      query.removeEventListener("change", onChange);
    };
  }, [state.preference]);

  const setPreference = useCallback((preference: ThemePreference) => {
    setThemePreference(preference);
  }, []);

  return {
    preference: state.preference,
    resolved: state.resolved,
    setPreference,
  };
}
