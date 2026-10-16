import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** Somebody the roster on screen lacks, with the newest message they wrote in the list. */
export interface MissingAuthor {
  authorId: string;
  /**
   * A message not reported for this author before means they wrote something
   * new. If they were thought gone, they may have rejoined since the last read.
   */
  messageId: string;
}

/** What a message list needs to tell "left" from "just joined". */
export interface AuthorGoneCheck {
  /** Authors a fresh roster read still did not contain. */
  confirmed: ReadonlySet<string>;
  /** Authors found missing from the roster the list was drawn with. */
  report: (missing: readonly MissingAuthor[]) => void;
}

/** Waits before a failed read is tried again. Three tries, then it stops. */
const RETRY_DELAYS_MS = [5_000, 15_000, 45_000];

const NO_AUTHORS: ReadonlySet<string> = new Set();

interface Tracker {
  report: (missing: readonly MissingAuthor[]) => void;
  /** Forget everyone the roster holds now. */
  seeInRoster: (roster: { has: (id: string) => boolean }) => void;
  dispose: () => void;
  readonly disposed: boolean;
}

/** The bookkeeping for one server. A new server gets a new tracker. */
function createTracker(
  refresh: () => Promise<ReadonlySet<string> | null>,
  onConfirmed: (ids: ReadonlySet<string>) => void,
): Tracker {
  /** Message ids reported per author. Only one not listed here is news. */
  const seen = new Map<string, Set<string>>();
  /** Waiting for the next read. */
  const waiting = new Set<string>();
  /** In the read that is running, but reported anew since it began. */
  const stale = new Set<string>();
  /** Their last read failed. They wait for the retry. */
  const failed = new Set<string>();
  const confirmed = new Set<string>();
  let inFlight: ReadonlySet<string> = new Set();
  let running = false;
  let disposed = false;
  let failures = 0;
  let retry: ReturnType<typeof setTimeout> | null = null;

  function publish() {
    onConfirmed(new Set(confirmed));
  }

  function forget(authorIds: Iterable<string>) {
    let changed = false;
    for (const id of authorIds) {
      seen.delete(id);
      waiting.delete(id);
      stale.delete(id);
      failed.delete(id);
      changed = confirmed.delete(id) || changed;
    }
    if (changed) {
      publish();
    }
  }

  function fail(batch: readonly string[]) {
    for (const id of batch) {
      if (seen.has(id) && !waiting.has(id)) {
        failed.add(id);
      }
    }
    const delay = RETRY_DELAYS_MS[failures];
    failures += 1;
    if (delay === undefined || failed.size === 0 || retry) {
      return;
    }
    retry = setTimeout(() => {
      retry = null;
      for (const id of failed) {
        waiting.add(id);
      }
      failed.clear();
      void drain();
    }, delay);
  }

  async function drain() {
    if (running) {
      return;
    }
    running = true;
    try {
      while (waiting.size > 0 && !disposed) {
        const batch = [...waiting];
        waiting.clear();
        stale.clear();
        inFlight = new Set(batch);
        let members: ReadonlySet<string> | null = null;
        try {
          members = await refresh();
        } catch {
          members = null;
        }
        inFlight = new Set();
        if (disposed) {
          return;
        }
        if (!members) {
          fail(batch);
          continue;
        }
        failures = 0;
        if (retry) {
          clearTimeout(retry);
          retry = null;
        }
        // The read began after every one of these was noticed, so it settles
        // the ones whose last read failed too.
        const checked = new Set([...batch, ...failed]);
        failed.clear();
        let added = false;
        for (const id of checked) {
          if (!seen.has(id)) {
            // Back in the roster while the read ran.
            continue;
          }
          if (members.has(id)) {
            forget([id]);
          } else if (!stale.has(id) && !confirmed.has(id)) {
            // A stale one waits for the read already queued for it.
            confirmed.add(id);
            added = true;
          }
        }
        if (added) {
          publish();
        }
      }
    } finally {
      running = false;
    }
  }

  return {
    report(missing) {
      if (disposed) {
        return;
      }
      let queued = false;
      let reopened = false;
      for (const { authorId, messageId } of missing) {
        const known = seen.get(authorId);
        if (known?.has(messageId)) {
          continue;
        }
        if (known) {
          known.add(messageId);
        } else {
          seen.set(authorId, new Set([messageId]));
        }
        // A first sighting, or a message from after the last read: either way
        // only a read that starts now can say whether they are gone.
        reopened = confirmed.delete(authorId) || reopened;
        failed.delete(authorId);
        waiting.add(authorId);
        if (inFlight.has(authorId)) {
          stale.add(authorId);
        }
        queued = true;
      }
      if (reopened) {
        publish();
      }
      if (queued) {
        void drain();
      }
    },
    seeInRoster(roster) {
      if (!disposed) {
        forget([...seen.keys()].filter((id) => roster.has(id)));
      }
    },
    dispose() {
      disposed = true;
      if (retry) {
        clearTimeout(retry);
        retry = null;
      }
    },
    get disposed() {
      return disposed;
    },
  };
}

/**
 * The server sends no frame when a membership is created, so somebody who
 * joined and posted first is missing from a roster that is up to 15 seconds
 * old. Their message must not read "left" for those seconds. When in doubt,
 * no tag.
 *
 * An author is only confirmed gone once a roster read that STARTED after they
 * were noticed still lacks them. `refresh` resolves with the ids that read
 * returned, or null when it failed. A read already in flight may predate the
 * join, so it never confirms anyone noticed after it began: those wait for the
 * next one.
 *
 * A confirmation does not outlive what it was about:
 * - Seen in `roster` again, an author loses it, so a later absence starts over.
 * - A message from them that was not reported before loses it too, because
 *   they may have rejoined and posted before the roster caught up.
 *
 * A failed read confirms nobody and is retried on a short schedule, then
 * dropped until something new is reported. Each new sighting costs one read.
 */
export function useConfirmedGoneAuthors(
  serverId: string | null,
  refresh: () => Promise<ReadonlySet<string> | null>,
  roster: ReadonlyMap<string, unknown>,
): AuthorGoneCheck {
  const [published, setPublished] = useState<{
    serverId: string | null;
    ids: ReadonlySet<string>;
  }>({ serverId, ids: NO_AUTHORS });
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const serverIdRef = useRef(serverId);
  serverIdRef.current = serverId;
  const held = useRef<{ serverId: string; tracker: Tracker } | null>(null);

  /**
   * The tracker for the server on screen. A new server gets a fresh one right
   * here, on first use, and not in an effect: a child's effect runs before
   * this hook's, so a report made while mounting would otherwise land on the
   * old state and be thrown away by the reset.
   */
  const trackerFor = useCallback((): Tracker | null => {
    const id = serverIdRef.current;
    if (id === null) {
      return null;
    }
    const current = held.current;
    if (current && current.serverId === id && !current.tracker.disposed) {
      return current.tracker;
    }
    current?.tracker.dispose();
    const tracker = createTracker(
      () => refreshRef.current(),
      (ids) => setPublished({ serverId: id, ids }),
    );
    held.current = { serverId: id, tracker };
    return tracker;
  }, []);

  const report = useCallback(
    (missing: readonly MissingAuthor[]) => {
      trackerFor()?.report(missing);
    },
    [trackerFor],
  );

  useEffect(() => {
    const current = held.current;
    if (current && current.serverId === serverIdRef.current) {
      current.tracker.seeInRoster(roster);
    }
  }, [roster]);

  useEffect(
    () => () => {
      held.current?.tracker.dispose();
    },
    [],
  );

  const confirmed =
    published.serverId === serverId ? published.ids : NO_AUTHORS;
  return useMemo(() => ({ confirmed, report }), [confirmed, report]);
}
