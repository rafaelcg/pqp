import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

/**
 * One polite live region for the whole dialog. A region inserted already
 * holding its text ("Salvo" appearing under a row) is often not announced, so
 * the rows' status lines are plain text inside Settings and say what happened
 * through this region, which is mounted before any of them speaks.
 */
const SettingsAnnounceContext = createContext<((text: string) => void) | null>(null);

export function SettingsAnnouncer({ children }: { children: ReactNode }) {
  const [text, setText] = useState("");
  const timer = useRef<number | null>(null);
  const announce = useCallback((next: string) => {
    // Cleared first, so the same sentence twice in a row ("Salvo" from two
    // rows) is read twice.
    setText("");
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setText(next);
    }, 0);
  }, []);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  return (
    <SettingsAnnounceContext.Provider value={announce}>
      {children}
      <p role="status" aria-live="polite" className="sr-only" data-settings-announcer="">
        {text}
      </p>
    </SettingsAnnounceContext.Provider>
  );
}

/** The dialog's announcer, or null outside Settings (onboarding, tests). */
export function useSettingsAnnounce(): ((text: string) => void) | null {
  return useContext(SettingsAnnounceContext);
}
