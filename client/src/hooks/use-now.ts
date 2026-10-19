import { useEffect, useState } from "react";

/**
 * `Date.now()` that re-renders every `intervalMs`, for a line that counts
 * ("começou há 4 min", "assume em 1:48"). `null` stops the clock: a surface
 * with nothing counting pays for no timer.
 */
export function useNow(intervalMs: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (intervalMs === null) {
      return;
    }
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}
