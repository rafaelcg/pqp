import { useCallback, useRef, useState } from "react";
import { fetchStreamAlertSetting } from "@/lib/api";

/**
 * What the server menu needs to offer "avisar quando alguém transmitir":
 * whether `stream_start_notifications` is on for that server, and what a
 * person who never chose gets there. Asked lazily, when a server's menu opens
 * (and for the open server), never for every server at boot: the switch exists
 * only where an operator turned the flag on, which is nowhere by default, and a
 * request per server per load would be the whole cost of a feature that is off.
 *
 * Re-asked after `STALE_MS`, so a flag flipped while the tab is open shows up
 * the next time a menu opens.
 */
export interface StreamAlertInfo {
  flag: boolean;
  default: boolean;
}

const STALE_MS = 10 * 60_000;

export function useStreamAlertSettings(): {
  byServer: Record<string, StreamAlertInfo>;
  ensure: (serverId: string) => void;
} {
  const [byServer, setByServer] = useState<Record<string, StreamAlertInfo>>({});
  const askedAt = useRef(new Map<string, number>());

  const ensure = useCallback((serverId: string) => {
    const now = Date.now();
    const last = askedAt.current.get(serverId);
    if (last !== undefined && now - last < STALE_MS) {
      return;
    }
    askedAt.current.set(serverId, now);
    void fetchStreamAlertSetting(serverId)
      .then((answer) => {
        setByServer((prev) => ({
          ...prev,
          [serverId]: { flag: answer.flag, default: answer.default },
        }));
      })
      .catch(() => {
        // An older API has no such route: the switch stays away.
        setByServer((prev) =>
          prev[serverId] ? prev : { ...prev, [serverId]: { flag: false, default: false } },
        );
      });
  }, []);

  return { byServer, ensure };
}
