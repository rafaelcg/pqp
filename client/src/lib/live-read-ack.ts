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
 *   - Only while the page is visible. A message that lands in a hidden tab has
 *     not been seen; it waits for the tab to come back.
 *   - The hold (Mark unread) is checked when the ack FIRES, not when it is
 *     scheduled. A pending ack must never overwrite the cursor the reader just
 *     rewound on purpose.
 *   - `settled` lets the next open of the same channel wait for an ack still in
 *     flight, so the open's own POST cannot land first and hand back the old
 *     cursor.
 */

export type LiveReadAckOptions = {
  send: (channelId: string) => Promise<unknown>;
  isVisible: () => boolean;
  isHeld: (channelId: string) => boolean;
  delayMs?: number;
};

export type LiveReadAck = {
  /** A message from somebody else arrived in the channel on screen. */
  note: (channelId: string) => void;
  /** Ack now if anything is waiting (leaving the channel). */
  flush: (channelId: string) => void;
  /** The page became visible again: start the clock on what waited. */
  resume: () => void;
  /** Resolves once any ack sent for this channel has finished. */
  settled: (channelId: string) => Promise<void>;
  dispose: () => void;
};

export const LIVE_READ_ACK_DELAY_MS = 1000;

export function createLiveReadAck({
  send,
  isVisible,
  isHeld,
  delayMs = LIVE_READ_ACK_DELAY_MS,
}: LiveReadAckOptions): LiveReadAck {
  /** Channels with an unacked arrival. `null` = waiting for the page to show. */
  const pending = new Map<string, ReturnType<typeof setTimeout> | null>();
  const inFlight = new Map<string, Promise<void>>();

  const fire = (channelId: string) => {
    const timer = pending.get(channelId);
    if (timer) {
      clearTimeout(timer);
    }
    pending.delete(channelId);
    if (isHeld(channelId)) {
      return;
    }
    const request = send(channelId).then(
      () => undefined,
      // A missed ack only means the rule shows once too often.
      () => undefined,
    );
    inFlight.set(channelId, request);
    void request.then(() => {
      if (inFlight.get(channelId) === request) {
        inFlight.delete(channelId);
      }
    });
  };

  const schedule = (channelId: string) => {
    const timer = pending.get(channelId);
    if (timer) {
      clearTimeout(timer);
    }
    pending.set(
      channelId,
      setTimeout(() => fire(channelId), delayMs),
    );
  };

  return {
    note(channelId) {
      if (!isVisible()) {
        if (!pending.has(channelId)) {
          pending.set(channelId, null);
        }
        return;
      }
      schedule(channelId);
    },
    flush(channelId) {
      if (pending.has(channelId)) {
        fire(channelId);
      }
    },
    resume() {
      if (!isVisible()) {
        return;
      }
      for (const [channelId, timer] of pending) {
        if (timer === null) {
          schedule(channelId);
        }
      }
    },
    settled(channelId) {
      return inFlight.get(channelId) ?? Promise.resolve();
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
