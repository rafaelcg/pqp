import type {
  JamPublicConsent,
  JamPublicConsentRequest,
  JamPublicInboxItem,
  JamPublicNotice,
} from "@pqp/shared";
import { useEffect, useSyncExternalStore } from "react";
import { onConfigRefresh } from "@/lib/config-refresh";
import {
  answerJamConsent,
  fetchJamPublicConsents,
  fetchJamPublicInbox,
  fetchJamPublicMe,
} from "@/lib/jam-public-api";

/**
 * What the signed-in account knows about public jams: the flag and what this
 * account may do (`GET /api/jam-public/config`), the songs where somebody is
 * waiting for its answer (`/consents`) and, for a starter, the outside takes
 * waiting to be put in the mix (`/inbox`).
 *
 * The live frame `jam-public-notice` is only a nudge ("ask again"); the
 * durable state is in those two reads, so a missed frame costs nothing the
 * next read does not fix. Everything here belongs to one account: the jam
 * store empties it when another one signs in (`resetJamPublic`).
 *
 * OFF MEANS INVISIBLE. While the flag is off (or this API predates it, a 404)
 * every surface built on this draws nothing and asks for nothing else.
 */

export interface JamPublicMeState {
  loaded: boolean;
  enabled: boolean;
  /** `open` publishes and records straight out; `review` waits for an operator; `blocked` may not publish. */
  publishing: "open" | "review" | "blocked";
  uploads: boolean;
}

const UNKNOWN: JamPublicMeState = { loaded: false, enabled: false, publishing: "open", uploads: false };

export interface JamPublicWaiting {
  consents: readonly JamPublicConsentRequest[];
  inbox: readonly JamPublicInboxItem[];
}

const NOTHING: JamPublicWaiting = { consents: [], inbox: [] };

let me: JamPublicMeState = UNKNOWN;
let waiting: JamPublicWaiting = NOTHING;
let epoch = 0;
let meLoad: Promise<void> | null = null;
let waitingLoad: Promise<void> | null = null;
const listeners = new Set<() => void>();
let refreshRegistered = false;

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

function status(error: unknown): number | undefined {
  const value = (error as { status?: unknown } | null)?.status;
  return typeof value === "number" ? value : undefined;
}

/** Empty everything held: another account is looking now. */
export function resetJamPublic(): void {
  epoch += 1;
  me = UNKNOWN;
  waiting = NOTHING;
  meLoad = null;
  waitingLoad = null;
  emit();
}

export function loadJamPublicMe(options: { force?: boolean } = {}): Promise<void> {
  if (me.loaded && !options.force) {
    return Promise.resolve();
  }
  if (meLoad) {
    return meLoad;
  }
  const mine = epoch;
  const run = fetchJamPublicMe()
    .then((answer) => {
      if (mine !== epoch) return;
      const next: JamPublicMeState = {
        loaded: true,
        enabled: answer.enabled === true,
        publishing: answer.publishing,
        uploads: answer.uploads === true,
      };
      const changed =
        !me.loaded ||
        me.enabled !== next.enabled ||
        me.publishing !== next.publishing ||
        me.uploads !== next.uploads;
      me = next;
      if (!next.enabled && waiting !== NOTHING) {
        waiting = NOTHING;
      }
      if (changed) emit();
      if (next.enabled) {
        void loadJamPublicWaiting();
      }
    })
    .catch((error: unknown) => {
      if (mine !== epoch) return;
      // An API that predates the routes, or one with the flag off, reads as off.
      // A network failure keeps what was there (nothing, the first time).
      const code = status(error);
      if (code === 404 || code === 401 || code === 403) {
        me = { ...UNKNOWN, loaded: true };
        waiting = NOTHING;
        emit();
      }
    })
    .finally(() => {
      if (meLoad === run) meLoad = null;
    });
  meLoad = run;
  if (!refreshRegistered) {
    refreshRegistered = true;
    onConfigRefresh(() => {
      if (me.loaded) void loadJamPublicMe({ force: true });
    });
  }
  return run;
}

/** The consent requests and the starter's inbox, asked together. */
export function loadJamPublicWaiting(): Promise<void> {
  if (!me.enabled) {
    return Promise.resolve();
  }
  if (waitingLoad) {
    return waitingLoad;
  }
  const mine = epoch;
  const run = Promise.all([
    fetchJamPublicConsents().catch(() => null),
    fetchJamPublicInbox().catch(() => null),
  ])
    .then(([consents, inbox]) => {
      if (mine !== epoch) return;
      waiting = {
        consents: consents ? consents.pending : waiting.consents,
        inbox: inbox ? inbox.takes : waiting.inbox,
      };
      emit();
    })
    .finally(() => {
      if (waitingLoad === run) waitingLoad = null;
    });
  waitingLoad = run;
  return run;
}

/** Answer for my parts in a song. The request leaves the list at once; a failure puts it back. */
export async function answerConsent(songId: string, choice: JamPublicConsent): Promise<void> {
  const mine = epoch;
  const taken = waiting.consents.find((one) => one.songId === songId);
  waiting = { ...waiting, consents: waiting.consents.filter((one) => one.songId !== songId) };
  emit();
  try {
    await answerJamConsent(songId, choice);
  } catch (error) {
    // Another account may have taken over while this was out (`resetJamPublic`): its lists are not ours to touch.
    if (mine === epoch && taken && !waiting.consents.some((one) => one.songId === songId)) {
      waiting = { ...waiting, consents: [taken, ...waiting.consents] };
      emit();
    }
    throw error;
  }
}

/** A take left the inbox (put in the mix, or removed): drop it without waiting for the read. */
export function dropInboxTake(trackId: string): void {
  waiting = { ...waiting, inbox: waiting.inbox.filter((one) => one.track.id !== trackId) };
  emit();
}

// ---- the frame ---------------------------------------------------------------

const noticeListeners = new Set<(notice: JamPublicNotice) => void>();

/** `jam-public-notice` is not in the chat frame union: this is how the one handler in App tells them apart. */
export function isJamPublicNotice(message: { type?: unknown }): message is JamPublicNotice {
  return message.type === "jam-public-notice";
}

export function dispatchJamPublicNotice(notice: JamPublicNotice): void {
  // A nudge: read again. The durable lists are the truth.
  if (me.enabled) {
    void loadJamPublicWaiting();
  }
  for (const listener of noticeListeners) {
    listener(notice);
  }
}

export function subscribeJamPublicNotices(listener: (notice: JamPublicNotice) => void): () => void {
  noticeListeners.add(listener);
  return () => {
    noticeListeners.delete(listener);
  };
}

/** The socket came back: frames sent while it was down are gone, so read again. */
export function jamPublicReconnected(): void {
  if (me.enabled) {
    void loadJamPublicWaiting();
  }
}

// ---- hooks -------------------------------------------------------------------

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The flag and this account's standing, asked once per identity. `active` false
 * asks nothing (a surface that cannot show anything yet, such as a signed-out
 * screen).
 */
export function useJamPublicMe(active = true): JamPublicMeState {
  useEffect(() => {
    if (active) {
      void loadJamPublicMe();
    }
  }, [active]);
  return useSyncExternalStore(subscribe, () => me, () => UNKNOWN);
}

/** Who is waiting for this account's answer, and the starter's inbox. Empty while the flag is off. */
export function useJamPublicWaiting(): JamPublicWaiting {
  return useSyncExternalStore(subscribe, () => waiting, () => NOTHING);
}
