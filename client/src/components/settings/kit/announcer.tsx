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
type Announce = (text: string, options?: { combine?: boolean }) => void;

const SettingsAnnounceContext = createContext<Announce | null>(null);

export function SettingsAnnouncer({ children }: { children: ReactNode }) {
  const [text, setText] = useState("");
  const timer = useRef<number | null>(null);
  // A status's newer message replaces its older one within a tick
  // ("Preparando…" then "Pronto" says only "Pronto"), while notices asked for
  // with `combine` are kept: two that mount in one commit are both said.
  const queued = useRef<{ text: string; combine: boolean }[]>([]);
  const announce = useCallback((next: string, options?: { combine?: boolean }) => {
    const combine = options?.combine ?? false;
    const kept = combine ? queued.current : queued.current.filter((entry) => entry.combine);
    queued.current = kept.some((entry) => entry.text === next)
      ? kept
      : [...kept, { text: next, combine }];
    // Cleared first, so the same sentence twice in a row ("Salvo" from two
    // rows) is read twice.
    setText("");
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setText(queued.current.map((entry) => entry.text).join(" "));
      queued.current = [];
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
export function useSettingsAnnounce(): Announce | null {
  return useContext(SettingsAnnounceContext);
}

/**
 * When the pane last changed tab. A notice that is already there when a tab
 * opens is content, not news; one that appears later (a refusal, a warning a
 * choice brought up) is said through the announcer.
 */
let paneShownAt = 0;
const PANE_SETTLE_MS = 400;

/** Called by the shell when it shows a tab. */
export function markSettingsPaneShown(): void {
  paneShownAt = Date.now();
}

export function settingsPaneSettled(): boolean {
  return Date.now() - paneShownAt > PANE_SETTLE_MS;
}
