import { useSyncExternalStore } from "react";

/**
 * When the person last looked at a jam, per channel, for the sidebar row's
 * "new song" dot. Per viewer and per device on purpose (`localStorage`): it is a
 * convenience, losing it costs one dot, and every access is wrapped because
 * storage can throw in a private window or with site data blocked.
 */

const PREFIX = "pqp:jam-seen:";
const listeners = new Set<() => void>();
let version = 0;
const memory = new Map<string, string>();

function read(channelId: string): string | null {
  try {
    return window.localStorage.getItem(PREFIX + channelId) ?? memory.get(channelId) ?? null;
  } catch {
    return memory.get(channelId) ?? null;
  }
}

/** Remember that the jam was looked at up to `activityAt` (never moves backwards). */
export function rememberJamSeen(channelId: string, activityAt: string | null): void {
  if (!activityAt) {
    return;
  }
  const held = read(channelId);
  if (held !== null && held >= activityAt) {
    return;
  }
  memory.set(channelId, activityAt);
  try {
    window.localStorage.setItem(PREFIX + channelId, activityAt);
  } catch {
    // Kept in memory for this page load.
  }
  version += 1;
  for (const listener of listeners) {
    listener();
  }
}

/** Changes whenever any channel's "seen" moves. */
export function useJamSeenVersion(): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => version,
    () => 0,
  );
}

export function jamSeenAt(channelId: string): string | null {
  return read(channelId);
}

export function useJamSeenAt(channelId: string): string | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => read(channelId),
    () => null,
  );
}
