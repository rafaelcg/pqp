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
 *   - Only while the page is visible, checked when the timer FIRES as well as
 *     when a message arrives. A message that lands in a hidden tab has not been
 *     seen; the ack waits for the tab to come back, and is dropped if the
 *     reader leaves the channel first.
 *   - Every write to a channel's cursor (this ack, the read on open, Mark
 *     unread) goes through one queue per channel, which waits for each
 *     response before sending the next request. The server's plain mark-read
 *     sets NOW() and a rewind sets an exact value, so the last write to commit
 *     wins; ordering the writes is what makes "last" mean "last clicked".
 *   - The hold (Mark unread) is checked when the ack LEAVES that queue, not
 *     when it is scheduled. A pending or queued ack must never overwrite the
 *     cursor the reader just rewound on purpose.
 *   - The ack sets the cursor to the server's NOW() when it runs, so it may
 *     only run while the reader still has the channel on screen. An ack that
 *     waited in the queue re-checks that; one that finds the reader gone is
 *     dropped, which costs at most one extra NEW rule and never hides a
 *     message nobody saw. The leave ack runs only if the queue is idle, for
 *     the same reason.
 *   - At most one ack per channel waits in the queue. A slow request does not
 *     pile up acks behind it; the one waiting covers every arrival before it.
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
  send: (channelId: string) => Promise<unknown>;
  isVisible: () => boolean;
  /** The channel is still the one on screen. */
  isSelected: (channelId: string) => boolean;
  isHeld: (channelId: string) => boolean;
  delayMs?: number;
};

export type LiveReadAck = {
  /** A message from somebody else arrived in the channel on screen. */
  note: (channelId: string) => void;
  /** Leaving the channel: ack now what was seen, drop what was not. */
  flush: (channelId: string) => void;
  /** The page became visible again: start the clock on what waited. */
  resume: () => void;
  dispose: () => void;
};

export const LIVE_READ_ACK_DELAY_MS = 1000;

export function createLiveReadAck({
  queue,
  send,
  isVisible,
  isSelected,
  isHeld,
  delayMs = LIVE_READ_ACK_DELAY_MS,
}: LiveReadAckOptions): LiveReadAck {
  /** Channels with an unacked arrival. `null` = waiting for the page to show. */
  const pending = new Map<string, ReturnType<typeof setTimeout> | null>();
  /** Channels with an ack waiting in the queue that has not started yet. */
  const queued = new Set<string>();

  const dispatch = (channelId: string) => {
    if (queued.has(channelId)) {
      // The waiting ack reads NOW() when it runs, so it covers this too.
      return;
    }
    queued.add(channelId);
    void queue
      .run(channelId, () => {
        queued.delete(channelId);
        // Read when the ack leaves the queue: a Mark unread made while it
        // waited still wins.
        if (isHeld(channelId)) {
          return Promise.resolve();
        }
        if (!isSelected(channelId) || !isVisible()) {
          // The reader left or hid the tab while this waited; NOW() would
          // cover messages they did not see. Wait for the tab if still here.
          if (isSelected(channelId) && !pending.has(channelId)) {
            pending.set(channelId, null);
          }
          return Promise.resolve();
        }
        return send(channelId);
      })
      // A missed ack only means the rule shows once too often.
      .catch(() => undefined);
  };

  /** The leave ack: sent at once, before the reader is gone, or not at all. */
  const dispatchNow = (channelId: string) => {
    if (queue.busy(channelId) || isHeld(channelId)) {
      return;
    }
    void queue.run(channelId, () => send(channelId)).catch(() => undefined);
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
    if (!isVisible()) {
      // The tab hid during the quiet second. Nothing since then was seen.
      if (isSelected(channelId)) {
        pending.set(channelId, null);
      }
      return;
    }
    dispatch(channelId);
  };

  const schedule = (channelId: string) => {
    clear(channelId);
    pending.set(
      channelId,
      setTimeout(() => onTimer(channelId), delayMs),
    );
  };

  return {
    note(channelId) {
      if (!isVisible()) {
        // Leave a running timer alone: it rechecks visibility when it fires.
        if (!pending.has(channelId)) {
          pending.set(channelId, null);
        }
        return;
      }
      schedule(channelId);
    },
    flush(channelId) {
      if (!pending.has(channelId)) {
        return;
      }
      const seen = pending.get(channelId) !== null && isVisible();
      clear(channelId);
      if (seen) {
        dispatchNow(channelId);
      }
    },
    resume() {
      if (!isVisible()) {
        return;
      }
      for (const [channelId, timer] of [...pending]) {
        if (timer !== null) {
          continue;
        }
        if (isSelected(channelId)) {
          schedule(channelId);
        } else {
          pending.delete(channelId);
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
    },
  };
}
