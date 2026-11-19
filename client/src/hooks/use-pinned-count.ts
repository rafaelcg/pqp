import { useEffect, useSyncExternalStore } from "react";
import { fetchPinnedMessages } from "@/lib/api";

/*
 * The count lives outside the hook, per channel, so the pins panel can say
 * what it just read or removed. The header's own fetch only runs again for a
 * pin change on a message in the loaded window, and a pinned message is
 * usually older than that: unpinning one from the panel left "Fixadas 3" in
 * the header over a list of two.
 */
const counts = new Map<string, number>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The last known count for a channel, or null while unknown. */
export function pinnedCountOf(channelId: string | null): number | null {
  return channelId ? (counts.get(channelId) ?? null) : null;
}

/** A read of the channel's whole pinned list: this is how many it holds. */
export function setPinnedCount(channelId: string, count: number): void {
  if (counts.get(channelId) === count) {
    return;
  }
  counts.set(channelId, count);
  for (const listener of [...listeners]) {
    listener();
  }
}

/** One pin was removed. A count nobody has read yet stays unknown. */
export function pinnedCountDropped(channelId: string): void {
  const known = counts.get(channelId);
  if (known !== undefined && known > 0) {
    setPinnedCount(channelId, known - 1);
  }
}

export function resetPinnedCountsForTests(): void {
  counts.clear();
  listeners.clear();
}

/**
 * How many messages are pinned in a channel, for the header's "Fixadas N"
 * under the redesign. One fetch per visit, and one more when a pin or an
 * unpin lands on a message in the loaded window (`pinSignature` changes).
 * The pins panel reports what it reads and removes (`setPinnedCount`,
 * `pinnedCountDropped`), which covers a message outside the window.
 * `null` while unknown or when `channelId` is null, so the header keeps
 * its plain tile instead of guessing a number.
 */
export function usePinnedCount(
  channelId: string | null,
  pinSignature: string,
): number | null {
  useEffect(() => {
    if (!channelId) {
      return;
    }
    let cancelled = false;
    // A pin is drawn optimistically before the server has it: wait a beat
    // so the count reads the committed list.
    const timer = window.setTimeout(() => {
      fetchPinnedMessages(channelId)
        .then((res) => {
          if (!cancelled) {
            setPinnedCount(channelId, res.messages.length);
          }
        })
        .catch(() => {
          // The tile still opens the panel, which shows its own error.
        });
    }, pinSignature ? 400 : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [channelId, pinSignature]);

  return useSyncExternalStore(
    subscribe,
    () => pinnedCountOf(channelId),
    () => null,
  );
}

/** The pinned ids among `messages`, as one string that changes when a pin does. */
export function pinSignatureOf(
  messages: readonly { id: string; pinnedAt?: string | null; pinnedBy?: unknown }[],
): string {
  let out = "";
  for (const message of messages) {
    if (message.pinnedAt) {
      // `pinnedBy` arrives with the server's answer, so a confirmed pin
      // changes the string once more than the optimistic one did.
      out += `${message.id}${message.pinnedBy ? "+" : ""},`;
    }
  }
  return out;
}
