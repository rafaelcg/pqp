/**
 * Moves the read cursor of the channel you are looking at while messages
 * arrive in it.
 *
 * Opening a channel marks it read, and before this nothing else did: a message
 * that arrived while the channel was on screen stayed "unread" on the server,
 * so leaving and coming back (or a reload) put the NEW rule above messages the
 * reader had already watched arrive. The thread panel solves the same problem
 * by acking on close; a channel acks here instead, because a reload never
 * passes through a "leave".
 *
 * Rules, each one a bug when missed:
 *   - Trailing debounce: a busy channel costs one POST per quiet second, not
 *     one per message.
 *   - A message counts as seen only while the page is visible AND the list is
 *     at its live end (pinned to the bottom of the newest page). One that
 *     lands in a hidden tab, or below a reader scrolled up in history, waits
 *     until both hold again, and is dropped if the reader leaves first.
 *     Checked when a message arrives, when the timer fires, and when the ack
 *     leaves the queue.
 *   - The ack sends an explicit cursor: just past the newest message seen, not
 *     the server's NOW(). An ack that runs late (queued behind a slow write,
 *     retried, or sent on leave after the reader has gone) can then never
 *     cover a message that arrived after the reader stopped looking.
 *   - Every write to a channel's cursor (this ack, the read on open, Mark
 *     unread) goes through one queue per channel, which waits for each
 *     response before sending the next request. The server keeps whichever
 *     write commits last; ordering the writes is what makes "last" mean "last
 *     clicked", and what keeps an older cursor from landing after the next
 *     open's read.
 *   - The hold (Mark unread) is checked when the ack LEAVES that queue, not
 *     when it is scheduled. A pending or queued ack must never overwrite the
 *     cursor the reader just rewound on purpose.
 *   - At most one ack per channel waits in the queue. A slow request does not
 *     pile up acks behind it; the one waiting reads the newest seen message
 *     when it runs, so it covers every arrival before it.
 *   - A failed ack is retried with backoff while the reader stays on the
 *     channel, through the same checks. The leave ack is not retried: a retry
 *     would be queued after the next open's read and take its cursor back.
 */

export type ChannelWriteQueue = {
  /**
   * Runs `task` after every earlier task for this channel has settled, and
   * resolves or rejects with its result. A failed task does not stall the rest.
   */
  run: <T>(channelId: string, task: () => Promise<T>) => Promise<T>;
  /** A write for this channel is running or waiting. */
  busy: (channelId: string) => boolean;
};

export function createChannelWriteQueue(): ChannelWriteQueue {
  const tails = new Map<string, Promise<unknown>>();
  return {
    run(channelId, task) {
      const previous = tails.get(channelId) ?? Promise.resolve();
      const result = previous.then(task);
      const tail = result.then(
        () => undefined,
        () => undefined,
      );
      tails.set(channelId, tail);
      void tail.then(() => {
        if (tails.get(channelId) === tail) {
          tails.delete(channelId);
        }
      });
      return result;
    },
    busy(channelId) {
      return tails.has(channelId);
    },
  };
}

export type LiveReadAckOptions = {
  /** The same queue every other cursor write for these channels uses. */
  queue: ChannelWriteQueue;
  /** Sets the channel's cursor to exactly `lastReadAt`. */
  send: (channelId: string, lastReadAt: string) => Promise<unknown>;
  isVisible: () => boolean;
  /**
   * The list is at its live end: pinned to the bottom, with no newer page
   * left to load. Defaults to always.
   */
  isAtLiveEnd?: () => boolean;
  /** The channel is still the one on screen. */
  isSelected: (channelId: string) => boolean;
  isHeld: (channelId: string) => boolean;
  delayMs?: number;
};

export type LiveReadAck = {
  /**
   * A message from somebody else arrived in the channel on screen.
   * `createdAt` is the server's timestamp for it.
   */
  note: (channelId: string, createdAt: string) => void;
  /** Leaving the channel: ack now what was seen, drop what was not. */
  flush: (channelId: string) => void;
  /**
   * The page became visible again, or the list reached its live end: start
   * the clock on what waited.
   */
  resume: () => void;
  dispose: () => void;
};

export const LIVE_READ_ACK_DELAY_MS = 1000;
/** Retries of one failed ack before it waits for the next arrival. */
export const LIVE_READ_ACK_MAX_RETRIES = 5;

/**
 * Just past the message: `created_at` keeps microseconds and the timestamp on
 * the wire keeps milliseconds, so the message itself would still be "after"
 * a cursor set to its own rounded time.
 */
const cursorAfter = (createdAtMs: number) =>
  new Date(createdAtMs + 1).toISOString();

export function createLiveReadAck({
  queue,
  send,
  isVisible,
  isAtLiveEnd = () => true,
  isSelected,
  isHeld,
  delayMs = LIVE_READ_ACK_DELAY_MS,
}: LiveReadAckOptions): LiveReadAck {
  /** Channels with an unacked arrival. `null` = waiting for the reader. */
  const pending = new Map<string, ReturnType<typeof setTimeout> | null>();
  /** Channels with an ack waiting in the queue that has not started yet. */
  const queued = new Set<string>();
  /** Newest unacked message the reader has seen, per channel (ms). */
  const seenUpTo = new Map<string, number>();
  /** Newest message that arrived while the reader could not see it (ms). */
  const unseenUpTo = new Map<string, number>();
  /** Failed attempts of the current ack, per channel. */
  const failures = new Map<string, number>();
  /** Bumped on every leave, so an ack from an earlier visit is not retried. */
  let departures = 0;

  const seeing = () => isVisible() && isAtLiveEnd();

  const raise = (map: Map<string, number>, channelId: string, at: number) => {
    const current = map.get(channelId);
    if (current === undefined || at > current) {
      map.set(channelId, at);
    }
  };

  /** Everything that waited is on screen now: the reader is at the end. */
  const promote = (channelId: string) => {
    const unseen = unseenUpTo.get(channelId);
    if (unseen !== undefined) {
      raise(seenUpTo, channelId, unseen);
      unseenUpTo.delete(channelId);
    }
  };

  const forget = (channelId: string) => {
    clear(channelId);
    seenUpTo.delete(channelId);
    unseenUpTo.delete(channelId);
    failures.delete(channelId);
  };

  const retry = (channelId: string, covered: number, visit: number) => {
    if (visit !== departures || !isSelected(channelId)) {
      // Left while it was on the wire, even if back since: the next open's
      // read is queued behind it, and a retry would land after that read.
      failures.delete(channelId);
      return;
    }
    raise(seenUpTo, channelId, covered);
    const attempt = (failures.get(channelId) ?? 0) + 1;
    if (attempt > LIVE_READ_ACK_MAX_RETRIES) {
      // Kept in `seenUpTo`: the next arrival or the leave ack carries it.
      failures.delete(channelId);
      return;
    }
    failures.set(channelId, attempt);
    if (!pending.has(channelId)) {
      // A newer arrival's timer, if any, already covers this one.
      schedule(channelId, delayMs * 2 ** attempt);
    }
  };

  const dispatch = (channelId: string) => {
    if (queued.has(channelId)) {
      // The waiting ack reads `seenUpTo` when it runs, so it covers this too.
      return;
    }
    queued.add(channelId);
    void queue
      .run(channelId, () => {
        queued.delete(channelId);
        // Read when the ack leaves the queue: a Mark unread made while it
        // waited still wins, and owns the cursor until it is released.
        if (isHeld(channelId)) {
          seenUpTo.delete(channelId);
          unseenUpTo.delete(channelId);
          return Promise.resolve();
        }
        if (!isSelected(channelId) || !seeing()) {
          // The reader left, hid the tab or scrolled up while this waited.
          // Wait for them if they are still here.
          if (isSelected(channelId) && !pending.has(channelId)) {
            pending.set(channelId, null);
          }
          return Promise.resolve();
        }
        promote(channelId);
        const covered = seenUpTo.get(channelId);
        if (covered === undefined) {
          return Promise.resolve();
        }
        seenUpTo.delete(channelId);
        const visit = departures;
        return send(channelId, cursorAfter(covered)).then(
          () => {
            failures.delete(channelId);
          },
          () => retry(channelId, covered, visit),
        );
      })
      .catch(() => undefined);
  };

  const clear = (channelId: string) => {
    const timer = pending.get(channelId);
    if (timer) {
      clearTimeout(timer);
    }
    pending.delete(channelId);
  };

  const onTimer = (channelId: string) => {
    clear(channelId);
    if (!seeing()) {
      // The tab hid, or the reader scrolled up, during the quiet second.
      if (isSelected(channelId)) {
        pending.set(channelId, null);
      }
      return;
    }
    dispatch(channelId);
  };

  const schedule = (channelId: string, delay = delayMs) => {
    clear(channelId);
    pending.set(
      channelId,
      setTimeout(() => onTimer(channelId), delay),
    );
  };

  return {
    note(channelId, createdAt) {
      const at = Date.parse(createdAt);
      if (!Number.isFinite(at)) {
        return;
      }
      if (!seeing()) {
        raise(unseenUpTo, channelId, at);
        // Leave a running timer alone: it rechecks when it fires.
        if (!pending.has(channelId)) {
          pending.set(channelId, null);
        }
        return;
      }
      raise(seenUpTo, channelId, at);
      failures.delete(channelId);
      schedule(channelId);
    },
    flush(channelId) {
      departures += 1;
      if (seeing()) {
        promote(channelId);
      }
      const covered = seenUpTo.get(channelId);
      forget(channelId);
      if (covered === undefined || isHeld(channelId)) {
        return;
      }
      // Queued behind whatever is in flight, and ahead of the next open's
      // read. Its cursor is fixed now, so running late cannot cover a
      // message that arrives after the reader has gone.
      void queue
        .run(channelId, () =>
          isHeld(channelId)
            ? Promise.resolve()
            : send(channelId, cursorAfter(covered)),
        )
        .catch(() => undefined);
    },
    resume() {
      if (!seeing()) {
        return;
      }
      for (const [channelId, timer] of [...pending]) {
        if (timer !== null) {
          continue;
        }
        if (isSelected(channelId)) {
          schedule(channelId);
        } else {
          forget(channelId);
        }
      }
    },
    dispose() {
      for (const timer of pending.values()) {
        if (timer) {
          clearTimeout(timer);
        }
      }
      pending.clear();
      seenUpTo.clear();
      unseenUpTo.clear();
      failures.clear();
    },
  };
}
