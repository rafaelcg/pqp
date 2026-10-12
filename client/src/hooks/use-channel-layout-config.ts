import { useCallback, useEffect, useRef, useState } from "react";
import type { Channel } from "@pqp/shared";
import { fetchChannelLayoutConfig } from "@/lib/api";

/**
 * Which channel list the open server draws, and the version a full-order PUT
 * is based on (`GET /api/servers/:id/channel-layout`).
 *
 * Asked when the server opens and again whenever its channel list changes
 * (a `channels-update` refetch, a create, a delete, our own reorder): every
 * one of those can move the version, and a drag sent with an old one is a
 * 409. Debounced, so a burst of list changes is one request.
 *
 * The last answer per server is remembered in localStorage so reopening a
 * server draws the right list on the first frame instead of flashing the old
 * one. A failed or 404 answer (an older API) means the old list.
 */

const STORAGE_PREFIX = "pqp:channel-layout-mixed:";
const REFRESH_DEBOUNCE_MS = 150;

function rememberedMixed(serverId: string | null): boolean {
  if (!serverId) {
    return false;
  }
  try {
    return localStorage.getItem(STORAGE_PREFIX + serverId) === "1";
  } catch {
    return false;
  }
}

function remember(serverId: string, mixed: boolean): void {
  try {
    if (mixed) {
      localStorage.setItem(STORAGE_PREFIX + serverId, "1");
    } else {
      localStorage.removeItem(STORAGE_PREFIX + serverId);
    }
  } catch {
    // Private mode or blocked storage: the first frame may draw the old list.
  }
}

export interface ChannelLayoutState {
  serverId: string | null;
  mixed: boolean;
  /** Null until the server answered for this server. */
  version: number | null;
}

/** At most one catch-up read per this long, on focus or when the tab shows. */
const DRIFT_CHECK_MS = 30_000;

export function useChannelLayoutConfig(
  serverId: string | null,
  channels: readonly Channel[],
  options: {
    /**
     * The layout moved without this tab hearing about it (a lost
     * `channels-update`, a migration done while the tab slept). The caller
     * refetches the list, and the version follows it.
     */
    onDrift?: (serverId: string) => void;
  } = {},
): {
  layout: ChannelLayoutState;
  /** Take the version (and mixed) a PUT or a 409 answered with. */
  adopt: (serverId: string, next: { version: number; mixed?: boolean }) => void;
} {
  const [layout, setLayout] = useState<ChannelLayoutState>(() => ({
    serverId,
    mixed: rememberedMixed(serverId),
    version: null,
  }));
  const requestRef = useRef(0);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const onDriftRef = useRef(options.onDrift);
  onDriftRef.current = options.onDrift;

  // A different server: start from what we remember of it, version unknown.
  if (layout.serverId !== serverId) {
    setLayout({ serverId, mixed: rememberedMixed(serverId), version: null });
  }

  // Catch-up: on focus (or the tab showing again), ask once whether the
  // layout moved since the list on screen was read. A nudge is best effort;
  // this is what makes a lost one cost a refocus, not a reload.
  useEffect(() => {
    if (!serverId) {
      return;
    }
    let lastCheck = Date.now();
    const check = () => {
      if (document.visibilityState === "hidden" || Date.now() - lastCheck < DRIFT_CHECK_MS) {
        return;
      }
      lastCheck = Date.now();
      fetchChannelLayoutConfig(serverId).then(
        (config) => {
          const known = layoutRef.current;
          if (known.serverId !== serverId || known.version === null) {
            return;
          }
          if (config.version !== known.version || config.mixed !== known.mixed) {
            onDriftRef.current?.(serverId);
          }
        },
        () => undefined,
      );
    };
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [serverId]);

  useEffect(() => {
    if (!serverId) {
      return;
    }
    const request = ++requestRef.current;
    const timer = window.setTimeout(() => {
      fetchChannelLayoutConfig(serverId).then(
        (config) => {
          if (request !== requestRef.current) {
            return;
          }
          remember(serverId, config.mixed);
          setLayout({ serverId, mixed: config.mixed, version: config.version });
        },
        () => {
          if (request !== requestRef.current) {
            return;
          }
          remember(serverId, false);
          setLayout({ serverId, mixed: false, version: null });
        },
      );
    }, REFRESH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [serverId, channels]);

  const adopt = useCallback(
    (forServer: string, next: { version: number; mixed?: boolean }) => {
      // The write's answer is newer than any read still in flight: those
      // reads must not land on top of it with the version from before.
      requestRef.current += 1;
      setLayout((current) =>
        current.serverId === forServer
          ? {
              serverId: forServer,
              mixed: next.mixed ?? current.mixed,
              version: next.version,
            }
          : current,
      );
      if (next.mixed !== undefined) {
        remember(forServer, next.mixed);
      }
    },
    [],
  );

  return { layout, adopt };
}
