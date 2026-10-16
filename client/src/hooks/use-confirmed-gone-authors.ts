import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** What a message list needs to tell "left" from "just joined". */
export interface AuthorGoneCheck {
  /** Authors a fresh roster read still did not contain. */
  confirmed: ReadonlySet<string>;
  /** Authors found missing from the roster the list was drawn with. */
  report: (authorIds: readonly string[]) => void;
}

/**
 * The server sends no frame when a membership is created, so somebody who
 * joined and posted first is missing from a roster that is up to 15 seconds
 * old. Their message must not read "left" for those seconds.
 *
 * An author is only confirmed gone once a roster read that STARTED after they
 * were noticed still lacks them. A read already in flight may predate the
 * join, so it never confirms anyone: ids reported during a read wait for the
 * next one. Each author costs at most one read per server; a failed read
 * confirms nobody and lets the author be reported again.
 */
export function useConfirmedGoneAuthors(
  serverId: string | null,
  refresh: () => Promise<boolean>,
): AuthorGoneCheck {
  const [confirmed, setConfirmed] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const state = useRef({
    serverId,
    requested: new Set<string>(),
    waiting: new Set<string>(),
    running: false,
  });

  useEffect(() => {
    state.current = {
      serverId,
      requested: new Set(),
      waiting: new Set(),
      running: false,
    };
    setConfirmed(new Set());
  }, [serverId]);

  const drain = useCallback(async () => {
    const mine = state.current;
    if (mine.running) {
      return;
    }
    mine.running = true;
    try {
      while (mine.waiting.size > 0 && state.current === mine) {
        const batch = [...mine.waiting];
        mine.waiting.clear();
        const ok = await refreshRef.current();
        if (state.current !== mine) {
          return;
        }
        if (ok) {
          setConfirmed((prev) => new Set([...prev, ...batch]));
        } else {
          for (const id of batch) {
            mine.requested.delete(id);
          }
        }
      }
    } finally {
      mine.running = false;
    }
  }, []);

  const report = useCallback(
    (authorIds: readonly string[]) => {
      const mine = state.current;
      let added = false;
      for (const id of authorIds) {
        if (!mine.requested.has(id)) {
          mine.requested.add(id);
          mine.waiting.add(id);
          added = true;
        }
      }
      if (added) {
        void drain();
      }
    },
    [drain],
  );

  return useMemo(() => ({ confirmed, report }), [confirmed, report]);
}
