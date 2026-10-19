import { useEffect, useRef, useState } from "react";
import { fetchEmulatorConfig } from "@/lib/api";
import { onConfigRefresh } from "@/lib/config-refresh";

/**
 * Whether the emulator room is on for this server (the runtime flag
 * `emulator_room`, per server, default off). Anything but an explicit `true`
 * is off, and so is no server, an older API (404) and a failed read.
 *
 * Asked when the server changes and again on every config refresh (focus, or
 * ten minutes), so the operator's switch reaches an open tab. Off, the room's
 * menu entry is not drawn and no emulator code is loaded: this is the only
 * thing the flag-off path ever does.
 */
export function useEmulatorEnabledFor(serverId: string | null): boolean {
  const [answer, setAnswer] = useState<{ serverId: string; enabled: boolean } | null>(
    null,
  );

  // Asks can overlap (the first read and a focus refresh): only the newest
  // one's answer counts, so a slow stale `true` cannot undo a flip to off.
  const asked = useRef(0);

  useEffect(() => {
    if (!serverId) {
      return;
    }
    let cancelled = false;
    const ask = () => {
      asked.current += 1;
      const mine = asked.current;
      void fetchEmulatorConfig(serverId)
        .then((config) => {
          if (!cancelled && mine === asked.current) {
            setAnswer({ serverId, enabled: config.enabled === true });
          }
        })
        .catch(() => {
          // A failed read is OFF, as documented above. This flag is gated on a
          // legal review and its off switch is a kill switch, so when the
          // newest ask cannot be answered the room does not stay on on the
          // strength of an old answer. (Only the newest ask: a stale failure
          // must not undo a newer success.)
          if (!cancelled && mine === asked.current) {
            setAnswer({ serverId, enabled: false });
          }
        });
    };
    ask();
    const stop = onConfigRefresh(ask);
    return () => {
      cancelled = true;
      stop();
    };
  }, [serverId]);

  return serverId !== null && answer?.serverId === serverId && answer.enabled;
}
