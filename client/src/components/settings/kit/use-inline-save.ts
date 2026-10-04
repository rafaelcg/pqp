import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "@/lib/api";

export type InlineSaveState =
  | { kind: "idle" }
  /** `label` replaces "Salvando…" ("Preparando…", "Enviando…"). */
  | { kind: "saving"; label?: string }
  | { kind: "saved" }
  | { kind: "error"; message: string };

/** How long "Salvo" stays before the row goes quiet again. */
export const INLINE_SAVED_MS = 2000;

const IDLE: InlineSaveState = { kind: "idle" };

/** The sentence `apiFetch` uses when a failure body carried no `error`. */
const GENERIC_API_MESSAGE = "Request failed";

/**
 * What to say under a row when a write failed.
 *
 * A server's own refusal (a 4xx with a sentence in it) is shown as is: it
 * names what was wrong with this request. Everything else gets the tab's
 * localized fallback: a 5xx (the breaker's `database_unavailable` is a code,
 * not a sentence), a network failure (status 0, which carries a client-built
 * English line), and a 4xx with no sentence ("Request failed"). Any other
 * `Error` keeps its message, so a tab can throw its own localized one.
 */
export function inlineErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    const refused = error.status >= 400 && error.status < 500;
    return refused && error.message && error.message !== GENERIC_API_MESSAGE
      ? error.message
      : fallback;
  }
  return error instanceof Error && error.message ? error.message : fallback;
}

export interface UseInlineSaveOptions {
  /** Replaces "Salvando…" while the write runs ("Preparando…" for a download). */
  savingLabel?: string;
  /**
   * `false` goes straight from saving back to quiet, with no "Salvo" step.
   * For an action whose result is its own proof: a download starting, a file
   * appearing. Default `true`.
   */
  showSaved?: boolean;
}

/**
 * Runs an async write for one row and tracks what happened to it: saving,
 * saved (cleared after `INLINE_SAVED_MS`), or the error to show under the row.
 *
 * Only the latest `run` reports. A slow first request that lands after a second
 * one started must not paint "Salvo" over the second one's spinner, or flip an
 * error back to saved. Nothing is reported after unmount.
 */
export function useInlineSave({
  savingLabel,
  showSaved = true,
}: UseInlineSaveOptions = {}): {
  state: InlineSaveState;
  run: (fn: () => Promise<unknown>, fallbackError: string) => Promise<void>;
} {
  const [state, setState] = useState<InlineSaveState>(IDLE);
  const latest = useRef(0);
  const mounted = useRef(true);
  const timer = useRef<number | null>(null);
  // Read at run time, so a caller passing a fresh label each render does not
  // hand out a new `run`.
  const options = useRef({ savingLabel, showSaved });
  options.current = { savingLabel, showSaved };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);

  const run = useCallback(
    async (fn: () => Promise<unknown>, fallbackError: string) => {
      const ticket = ++latest.current;
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
      const { savingLabel: label, showSaved: saved } = options.current;
      setState(label ? { kind: "saving", label } : { kind: "saving" });
      try {
        await fn();
        if (!mounted.current || ticket !== latest.current) return;
        if (!saved) {
          setState(IDLE);
          return;
        }
        setState({ kind: "saved" });
        timer.current = window.setTimeout(() => {
          timer.current = null;
          if (mounted.current && ticket === latest.current) setState(IDLE);
        }, INLINE_SAVED_MS);
      } catch (error) {
        if (!mounted.current || ticket !== latest.current) return;
        setState({ kind: "error", message: inlineErrorMessage(error, fallbackError) });
      }
    },
    [],
  );

  return { state, run };
}
