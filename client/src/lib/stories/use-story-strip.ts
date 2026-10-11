import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { StoryNotice, StoryStrip } from "@pqp/shared";
import {
  STORY_STRIP_OFF,
  ackStoryNotice,
  fetchFriendsStoryStrip,
  fetchServerStoryStrip,
  fetchStoryNotices,
} from "./api";
import { onStoriesSignal, signalTouchesStrip } from "./events";
import { canApplyStripNow, msUntilNextExpiry } from "./strip-state";

/**
 * One strip, kept fresh.
 *
 * Refetches on the `stories-update` frame that names it (coalesced, since a
 * busy server sends one every 5 s at most and a reconnect sends a refresh to
 * every strip at once), when the window comes back into focus, and never on a
 * poll. Expiry is local: a timer armed at the next `expiresAt` repaints the
 * strip, and `stripView` drops what has expired.
 *
 * A fetched strip whose ORDER differs waits while the pointer is on the strip
 * (design §3.1: "the client never reorders while a finger or pointer is on
 * the strip") and lands when it leaves.
 */

export type StripAudience =
  | { kind: "server"; serverId: string }
  | { kind: "friends" };

const cache = new Map<string, StoryStrip>();

/**
 * Whether each audience's strip answered `enabled`, for the entry points that
 * live outside the strip (the server menu's "Postar story"): with the flag
 * off for a server, no entry point may offer a feature that will 404.
 */
const enabledByKey = new Map<string, boolean>();
const enabledListeners = new Set<() => void>();

function noteEnabled(key: string, enabled: boolean): void {
  if (enabledByKey.get(key) === enabled) {
    return;
  }
  enabledByKey.set(key, enabled);
  for (const listener of [...enabledListeners]) {
    listener();
  }
}

export function useStoriesEnabledFor(audience: StripAudience | null): boolean {
  const key = audience ? cacheKey(audience) : null;
  return useSyncExternalStore(
    (listener) => {
      enabledListeners.add(listener);
      return () => {
        enabledListeners.delete(listener);
      };
    },
    () => (key ? (enabledByKey.get(key) ?? false) : false),
    () => false,
  );
}

function cacheKey(audience: StripAudience): string {
  return audience.kind === "server" ? `server:${audience.serverId}` : "friends";
}

const COALESCE_MS = 300;
const FOCUS_REFETCH_MIN_MS = 30_000;

export function useStoryStrip(audience: StripAudience | null): {
  strip: StoryStrip | null;
  now: number;
  refetch: () => void;
  setPointerOnStrip: (on: boolean) => void;
} {
  const key = audience ? cacheKey(audience) : null;
  const [strip, setStrip] = useState<StoryStrip | null>(() =>
    key ? (cache.get(key) ?? null) : null,
  );
  const [now, setNow] = useState(() => Date.now());
  const stripRef = useRef(strip);
  stripRef.current = strip;
  const pointerOn = useRef(false);
  const held = useRef<StoryStrip | null>(null);
  const lastFetch = useRef(0);
  const audienceRef = useRef(audience);
  audienceRef.current = audience;

  const apply = useCallback((next: StoryStrip, forKey: string) => {
    cache.set(forKey, next);
    noteEnabled(forKey, next.enabled);
    if (!canApplyStripNow(stripRef.current, next, pointerOn.current)) {
      held.current = next;
      return;
    }
    held.current = null;
    setStrip(next);
    setNow(Date.now());
  }, []);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      const current = audienceRef.current;
      if (!current) {
        return;
      }
      const forKey = cacheKey(current);
      lastFetch.current = Date.now();
      try {
        const next =
          current.kind === "server"
            ? await fetchServerStoryStrip(current.serverId, signal)
            : await fetchFriendsStoryStrip(signal);
        if (signal?.aborted || cacheKey(audienceRef.current ?? current) !== forKey) {
          return;
        }
        apply(next, forKey);
      } catch {
        if (signal?.aborted) {
          return;
        }
        // A failed strip draws nothing rather than an error: stories are an
        // extra, and a red banner above the channel list would not be.
        if (!stripRef.current) {
          setStrip(STORY_STRIP_OFF);
        }
      }
    },
    [apply],
  );

  // Fetch on mount and whenever the audience changes, showing the cached copy
  // in the meantime so switching back to a server does not flash.
  useEffect(() => {
    if (!key) {
      setStrip(null);
      return;
    }
    setStrip(cache.get(key) ?? null);
    held.current = null;
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [key, load]);

  // The frame, coalesced.
  useEffect(() => {
    if (!audience) {
      return;
    }
    let timer: number | null = null;
    const off = onStoriesSignal((signal) => {
      const current = audienceRef.current;
      if (!current || !signalTouchesStrip(signal, current)) {
        return;
      }
      if (timer !== null) {
        return;
      }
      timer = window.setTimeout(() => {
        timer = null;
        void load();
      }, COALESCE_MS);
    });
    return () => {
      off();
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
    // `audience` identity changes every render; the key is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, load]);

  // Coming back to the tab: frames may have been missed while asleep.
  useEffect(() => {
    if (!key) {
      return;
    }
    function onFocus() {
      setNow(Date.now());
      if (Date.now() - lastFetch.current > FOCUS_REFETCH_MIN_MS) {
        void load();
      }
    }
    function onVisibility() {
      if (document.visibilityState === "visible") {
        onFocus();
      }
    }
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [key, load]);

  // Local expiry: repaint when the next ring is due to go.
  useEffect(() => {
    if (!strip) {
      return;
    }
    const delay = msUntilNextExpiry(strip, Date.now());
    if (delay === null) {
      return;
    }
    const timer = window.setTimeout(() => setNow(Date.now()), delay);
    return () => window.clearTimeout(timer);
  }, [strip, now]);

  const setPointerOnStrip = useCallback((on: boolean) => {
    pointerOn.current = on;
    if (!on && held.current) {
      const next = held.current;
      held.current = null;
      setStrip(next);
      setNow(Date.now());
    }
  }, []);

  const refetch = useCallback(() => {
    void load();
  }, [load]);

  return { strip, now, refetch, setPointerOnStrip };
}

/**
 * One-time notices for the author ("A staff tirou teu story do X"), shared by
 * every strip: fetched once, again on every `own` frame, and dropped locally
 * when acknowledged.
 */
let noticesCache: StoryNotice[] = [];
let noticesLoaded = false;
const noticeListeners = new Set<(notices: StoryNotice[]) => void>();

function publishNotices(next: StoryNotice[]): void {
  noticesCache = next;
  for (const listener of [...noticeListeners]) {
    listener(next);
  }
}

async function reloadNotices(): Promise<void> {
  try {
    const { notices } = await fetchStoryNotices();
    noticesLoaded = true;
    publishNotices(notices);
  } catch {
    // Not loaded: the next `own` frame or mount asks again.
  }
}

export function useStoryNotices(active: boolean): {
  notices: StoryNotice[];
  dismiss: (noticeId: string) => void;
} {
  const [notices, setNotices] = useState(noticesCache);
  useEffect(() => {
    if (!active) {
      return;
    }
    noticeListeners.add(setNotices);
    if (!noticesLoaded) {
      void reloadNotices();
    }
    const off = onStoriesSignal((signal) => {
      if (signal.kind === "refresh" || signal.frame.scope === "own") {
        void reloadNotices();
      }
    });
    return () => {
      noticeListeners.delete(setNotices);
      off();
    };
  }, [active]);
  const dismiss = useCallback((noticeId: string) => {
    publishNotices(noticesCache.filter((notice) => notice.id !== noticeId));
    void ackStoryNotice(noticeId).catch(() => undefined);
  }, []);
  return { notices, dismiss };
}

/** Tests only: what a strip draws before its first fetch lands. */
export function primeStoryStripCache(audience: StripAudience, strip: StoryStrip): void {
  cache.set(cacheKey(audience), strip);
}

/** Tests only. */
export function resetStoryStripCache(): void {
  cache.clear();
  enabledByKey.clear();
  noticesCache = [];
  noticesLoaded = false;
}
