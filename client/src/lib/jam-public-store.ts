import type {
  JamPublicConsent,
  JamPublicConsentRequest,
  JamPublicInboxItem,
  JamPublicNotice,
} from "@pqp/shared";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { onConfigRefresh } from "@/lib/config-refresh";
import {
  answerJamConsent,
  fetchJamPublicConsents,
  fetchJamPublicInbox,
  fetchJamPublicMe,
  fetchPublicJams,
} from "@/lib/jam-public-api";
import { FEATURED_WINDOW, pickFeatured, takesParts } from "@/lib/jam-featured";
import { listenToPublicJam, startPublicJam } from "@/lib/jam-public-nav";

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
  /**
   * `jam_announcement`: the "A Jam abriu" corner card may be offered
   * (`lib/jam-announcement.ts`). The server only says yes beside `enabled`, and
   * this keeps that promise on its own side too.
   */
  announce: boolean;
}

const UNKNOWN: JamPublicMeState = {
  loaded: false,
  enabled: false,
  publishing: "open",
  uploads: false,
  announce: false,
};

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

/** Test seam: what the store holds right now. */
export function readJamPublicMeForTests(): JamPublicMeState {
  return me;
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
        announce: answer.enabled === true && answer.announce === true,
      };
      const changed =
        !me.loaded ||
        me.enabled !== next.enabled ||
        me.publishing !== next.publishing ||
        me.uploads !== next.uploads ||
        me.announce !== next.announce;
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

// ---- the song to open --------------------------------------------------------

/** What a door into public jams opens: the featured song, and whether it takes a part from the person. */
export interface FeaturedPublicJam {
  id: string;
  /** Not `closed`: only then does a door offer "Gravar minha parte" (a closed song has no record button). */
  takesParts: boolean;
}

/**
 * The song a door into public jams opens, picked by the public site's own hero
 * rule (`pickFeatured` in `lib/jam-featured.ts`, over the same twelve of Em
 * alta): an original that still takes a part, else any original, else any song
 * that takes one, else the first. `null` when there is no public song with a
 * part to hear at all.
 *
 * It used to be "the most heard original", which at launch is a finished
 * song: the card promised "grava a tua parte" and opened one that took none.
 */
export async function fetchFeaturedPublicJam(): Promise<FeaturedPublicJam | null> {
  const page = await fetchPublicJams({ sort: "top", limit: FEATURED_WINDOW });
  const song = pickFeatured(page.songs);
  return song ? { id: song.id, takesParts: takesParts(song) } : null;
}

/**
 * A door into public jams that has no song to show beside it (the quick
 * switcher's "Abrir o Jam", the search dialog's): the featured song, waiting
 * for a tap on play, or the sheet that starts one when there is none or the
 * lookup failed (a failed lookup says nothing about the catalogue, and
 * starting is always available).
 */
let doorRun = 0;

export async function openPublicJamsDoor(): Promise<void> {
  // The lookup takes a network round trip. A person who pressed the door twice, or
  // went somewhere else meanwhile, must not be pulled into Jam when it lands.
  doorRun += 1;
  const mine = doorRun;
  const startedAt = typeof window === "undefined" ? "" : window.location.pathname;
  let featured: FeaturedPublicJam | null = null;
  try {
    featured = await fetchFeaturedPublicJam();
  } catch {
    // Not an answer: fall through to starting one.
  }
  const moved = typeof window !== "undefined" && window.location.pathname !== startedAt;
  if (mine !== doorRun || moved) {
    return;
  }
  if (featured) {
    listenToPublicJam(featured.id);
  } else {
    startPublicJam();
  }
}

export type JamPublicTop =
  | { status: "idle" | "loading" | "error" }
  | { status: "ready"; song: FeaturedPublicJam | null };

/**
 * The featured public song, asked once while `active` (a card or a door that
 * may draw). `ready` with a null song is an answer: there is nothing to listen
 * to yet, and the surface offers starting one instead. `error` is not an
 * answer, and a surface that says something about it waits for one.
 */
export function useJamPublicTop(active: boolean): JamPublicTop {
  const [top, setTop] = useState<JamPublicTop>({ status: "idle" });
  const started = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!active || started.current) {
      return;
    }
    started.current = true;
    setTop({ status: "loading" });
    void fetchFeaturedPublicJam().then(
      (song) => {
        if (alive.current) setTop({ status: "ready", song });
      },
      () => {
        if (alive.current) setTop({ status: "error" });
      },
    );
  }, [active]);
  return top;
}

/**
 * Whether a door offers "Gravar minha parte": the featured song takes a part
 * and this account may record one (storage on, not blocked from publishing).
 */
export function canRecordOnFeatured(song: FeaturedPublicJam | null, me: JamPublicMeState): boolean {
  return song !== null && song.takesParts && me.uploads && me.publishing !== "blocked";
}

/** Who is waiting for this account's answer, and the starter's inbox. Empty while the flag is off. */
export function useJamPublicWaiting(): JamPublicWaiting {
  return useSyncExternalStore(subscribe, () => waiting, () => NOTHING);
}
