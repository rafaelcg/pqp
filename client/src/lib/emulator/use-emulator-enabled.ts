import { useEffect, useState } from "react";
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

  useEffect(() => {
    if (!serverId) {
      return;
    }
    let cancelled = false;
    const ask = () => {
      void fetchEmulatorConfig(serverId)
        .then((config) => {
          if (!cancelled) {
            setAnswer({ serverId, enabled: config.enabled === true });
          }
        })
        .catch(() => {
          // Keep the last answer: a blip must not flip the room off and on.
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
