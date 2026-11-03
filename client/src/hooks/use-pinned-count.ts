import { useEffect, useState } from "react";
import { fetchPinnedMessages } from "@/lib/api";

/**
 * How many messages are pinned in a channel, for the header's "Fixadas N"
 * under the redesign. One fetch per channel, and one more when a pin or an
 * unpin lands on a message in the loaded window (`pinSignature` changes).
 * A pin on a message outside the window is picked up on the next visit.
 * `null` while unknown or when `channelId` is null, so the header keeps
 * its plain tile instead of guessing a number.
 */
export function usePinnedCount(
  channelId: string | null,
  pinSignature: string,
): number | null {
  const [count, setCount] = useState<{ channelId: string; count: number } | null>(null);

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
            setCount({ channelId, count: res.messages.length });
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

  return channelId && count?.channelId === channelId ? count.count : null;
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
