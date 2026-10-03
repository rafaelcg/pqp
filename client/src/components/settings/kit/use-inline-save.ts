import { useCallback, useEffect, useRef, useState } from "react";
import { messageOf } from "@/components/settings/ui";

export type InlineSaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string };

/** How long "Salvo" stays before the row goes quiet again. */
export const INLINE_SAVED_MS = 2000;

const IDLE: InlineSaveState = { kind: "idle" };

/**
 * Runs an async write for one row and tracks what happened to it: saving,
 * saved (cleared after `INLINE_SAVED_MS`), or the error to show under the row.
 *
 * Only the latest `run` reports. A slow first request that lands after a second
 * one started must not paint "Salvo" over the second one's spinner, or flip an
 * error back to saved. Nothing is reported after unmount.
 */
export function useInlineSave(): {
  state: InlineSaveState;
  run: (fn: () => Promise<unknown>, fallbackError: string) => Promise<void>;
} {
  const [state, setState] = useState<InlineSaveState>(IDLE);
  const latest = useRef(0);
  const mounted = useRef(true);
  const timer = useRef<number | null>(null);

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
      setState({ kind: "saving" });
      try {
        await fn();
        if (!mounted.current || ticket !== latest.current) return;
        setState({ kind: "saved" });
        timer.current = window.setTimeout(() => {
          timer.current = null;
          if (mounted.current && ticket === latest.current) setState(IDLE);
        }, INLINE_SAVED_MS);
      } catch (error) {
        if (!mounted.current || ticket !== latest.current) return;
        setState({ kind: "error", message: messageOf(error, fallbackError) });
      }
    },
    [],
  );

  return { state, run };
}
