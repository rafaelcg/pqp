import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "@/lib/api";
import { useTranslation } from "@/lib/i18n";

export type InlineSaveState =
  | { kind: "idle" }
  /** `label` replaces "Salvando…" ("Preparando…", "Enviando…"). */
  | { kind: "saving"; label?: string }
  | { kind: "saved" }
  | { kind: "error"; message: string };

/** How long "Salvo" stays before the row goes quiet again. */
export const INLINE_SAVED_MS = 2000;

const IDLE: InlineSaveState = { kind: "idle" };

/**
 * What to say under a row when a write failed.
 *
 * The server answers in English (its messages are written for logs and other
 * clients, not for a reader in Settings), and a network failure carries a
 * client-built English line, so no `ApiError` text is ever shown: a refused
 * request gets the tab's own localized `fallback`, and a 429 gets the
 * `rateLimited` sentence when one is given (trying again at once would only
 * fail again). Any other `Error` keeps its message, so a tab can throw its own
 * localized sentence.
 */
export function inlineErrorMessage(
  error: unknown,
  fallback: string,
  rateLimited?: string,
): string {
  if (error instanceof ApiError) {
    return error.status === 429 && rateLimited ? rateLimited : fallback;
  }
  if (error instanceof Error && error.name === "AbortError") {
    return fallback;
  }
  // A dropped network outside `apiFetch` is the browser's own TypeError.
  if (error instanceof TypeError) {
    return fallback;
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
 *
 * Writes also run one at a time, in order. Two requests in flight for the same
 * setting can reach the server in either order (production runs two API
 * machines), so the older one could win there while the screen shows the newer
 * one. A run waits for the one before it, and a run that a newer one overtook
 * while it waited is skipped: only the last choice is ever sent after the
 * current write.
 */
export function useInlineSave({
  savingLabel,
  showSaved = true,
}: UseInlineSaveOptions = {}): {
  state: InlineSaveState;
  run: (fn: () => Promise<unknown>, fallbackError: string) => Promise<void>;
} {
  const { t } = useTranslation();
  const rateLimited = useRef("");
  rateLimited.current = t("settings.status.rateLimited");
  const [state, setState] = useState<InlineSaveState>(IDLE);
  const latest = useRef(0);
  const mounted = useRef(true);
  const timer = useRef<number | null>(null);
  // The last write sent or queued, so the next run can wait for it, and how
  // many have not settled yet (none: a run goes out at once).
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const unsettled = useRef(0);
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
      const write =
        unsettled.current === 0
          ? fn()
          : chain.current.then(() =>
              // Overtaken while waiting: the newer run sends the value that
              // matters.
              ticket === latest.current ? fn() : undefined,
            );
      unsettled.current += 1;
      // The next run waits on this one whatever its outcome.
      chain.current = write.then(
        () => {
          unsettled.current -= 1;
        },
        () => {
          unsettled.current -= 1;
        },
      );
      try {
        await write;
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
        setState({
          kind: "error",
          message: inlineErrorMessage(error, fallbackError, rateLimited.current),
        });
      }
    },
    [],
  );

  return { state, run };
}
