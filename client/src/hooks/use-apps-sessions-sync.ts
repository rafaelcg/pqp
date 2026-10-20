import { useEffect, useRef } from "react";
import { useAppsConfig } from "@/hooks/use-apps-config";
import { fetchServerAppSessions } from "@/lib/apps/api";
import {
  appFrameClock,
  applyCatchUp,
  dropAppSessionsOfServer,
  useAppSessions,
} from "@/lib/apps/app-sessions-store";
import { uniformJitterMs } from "@/lib/reconnect-jitter";

/** The longest a reconnect waits before re-reading, so a herd does not arrive as one. */
export const APPS_RECONNECT_JITTER_MAX_MS = 2_000;

/**
 * Keeps the live-apps store honest for the server that is open: one read when
 * it opens (and when its `apps` flag comes on), one after every reconnect, and
 * nothing at all while the flag is off or has not answered. In between, the
 * `channel-app` frames the socket already carries do the work.
 *
 * `channels` is the open server's channel list; it is what lets a catch-up drop
 * a session whose end was missed while the socket was down.
 */
export function useAppsSessionsSync(
  serverId: string | null,
  channels: ReadonlyArray<{ id: string; serverId: string | null }>,
): void {
  const config = useAppsConfig(serverId);
  const epoch = useAppSessions((state) => state.epoch);
  const channelsRef = useRef(channels);
  channelsRef.current = channels;
  const last = useRef<{ serverId: string | null; epoch: number }>({ serverId: null, epoch });

  useEffect(() => {
    if (!serverId || !config.loaded) {
      return;
    }
    if (!config.enabled) {
      dropAppSessionsOfServer(serverId);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const run = () => {
      timer = null;
      const clock = appFrameClock();
      fetchServerAppSessions(serverId)
        .then((sessions) => {
          if (cancelled) {
            return;
          }
          const ids = channelsRef.current
            .filter((channel) => channel.serverId === serverId)
            .map((channel) => channel.id);
          applyCatchUp(serverId, ids, sessions, clock);
        })
        .catch(() => {
          // Stale beats blank: what the frames have said stays on screen, and
          // the next reconnect or server open asks again.
        });
    };
    // A reconnect on the same server is the herd case and waits its turn; a
    // server just opened (or a flag just on) reads at once.
    const reconnected = last.current.serverId === serverId && last.current.epoch !== epoch;
    last.current = { serverId, epoch };
    if (reconnected) {
      timer = setTimeout(run, uniformJitterMs(0, APPS_RECONNECT_JITTER_MAX_MS));
    } else {
      run();
    }
    return () => {
      cancelled = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
    };
  }, [serverId, config.loaded, config.enabled, epoch]);
}
