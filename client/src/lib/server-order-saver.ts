/**
 * Saving the server rail's order, one request at a time.
 *
 * WHY NOT JUST FIRE A PUT PER MOVE. Two requests in the air can commit in
 * either order, so the order stored could end up older than the one on screen
 * (a reload then moves the rail). A held Alt+Arrow sends thirty saves a second,
 * and each one locks and rewrites every membership row the account has. So:
 *
 *  - at most ONE save in flight; while it is, only the NEWEST wanted order is
 *    kept, and it is sent when the first answers. A burst of moves is one or
 *    two requests, and the last move always wins.
 *  - a failure goes back to the last order the SERVER confirmed (or the one the
 *    burst started from), never to an intermediate order that was never saved,
 *    and drops whatever was queued behind it.
 *  - a frame from another tab that arrives while a save is in the air cannot be
 *    ordered against it, so it is only noted; when the queue drains the owner
 *    reads the list again and the server's answer wins.
 *
 * Pure of React and of the network: the caller passes the pieces.
 */
export interface ServerOrderSaverDeps {
  /** Send the order; resolve with the order the server stored. */
  save: (ids: string[]) => Promise<string[]>;
  /** The order on screen right now, read when a burst begins. */
  current: () => string[];
  /** The server stored this order. `latest` is false while a newer one is queued. */
  onConfirmed: (stored: string[], latest: boolean) => void;
  /** A save was refused: put the rail back to `confirmed`. */
  onFailed: (confirmed: string[]) => void;
  /** The queue drained after another tab's frame was noted: read the list again. */
  onResync: () => void;
}

export interface ServerOrderSaver {
  /** The person moved something: `ids` is the order they now want. */
  request: (ids: string[]) => void;
  /** A `server-order-update` from another tab arrived. Returns true if it was held back. */
  noteRemote: () => boolean;
}

export function createServerOrderSaver(deps: ServerOrderSaverDeps): ServerOrderSaver {
  let inFlight = false;
  let queued: string[] | null = null;
  let confirmed: string[] | null = null;
  let remoteSeen = false;

  async function drain(): Promise<void> {
    inFlight = true;
    try {
      while (queued) {
        const ids = queued;
        queued = null;
        try {
          const stored = await deps.save(ids);
          confirmed = stored;
          deps.onConfirmed(stored, queued === null);
        } catch {
          queued = null;
          deps.onFailed(confirmed ?? []);
        }
      }
    } finally {
      inFlight = false;
      confirmed = null;
      if (remoteSeen) {
        remoteSeen = false;
        deps.onResync();
      }
    }
  }

  return {
    request(ids) {
      if (confirmed === null) {
        confirmed = deps.current();
      }
      queued = ids;
      if (!inFlight) {
        void drain();
      }
    },
    noteRemote() {
      if (!inFlight) {
        return false;
      }
      remoteSeen = true;
      return true;
    },
  };
}
