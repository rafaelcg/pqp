import type {
  JamPublicConsent,
  JamPublicConsentRequest,
  JamPublicInboxItem,
  JamPublicNotice,
  JamTakeDecision,
  JamTakeNotice,
} from "@pqp/shared";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { onConfigRefresh } from "@/lib/config-refresh";
import {
  ackJamTakeNotice,
  answerJamConsent,
  fetchJamPublicConsents,
  fetchJamPublicInbox,
  fetchJamPublicMe,
  fetchJamTakeNotices,
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
  /**
   * The open take notices (`jam_take_notices`): parts waiting for this account
   * as a starter, and the starter's answers to the parts it sent. The card
   * the host draws; empty while the server's flag is off.
   */
  notices: readonly JamTakeNotice[];
}

const NOTHING: JamPublicWaiting = { consents: [], inbox: [], notices: [] };

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

/** What the store holds right now (a handler that must look after a read, not hook into render). */
export function getJamPublicWaiting(): JamPublicWaiting {
  return waiting;
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

/** Set by the last read of the waiting lists: one of the three answers did not arrive, so a list is out of date. */
let waitingStale = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
const WAITING_RETRY_MS = [3000, 10000, 30000] as const;

/**
 * Read the waiting lists again AFTER something this person did that changes them (a delete of
 * their own part, an undo, a decline), as a best effort that never gets in the way of what they
 * did: the action already succeeded and has been applied locally, so a failed read must not make
 * it look undone (Farol, PR 1778). It cannot reject (every one of the three reads has its own
 * catch); when one of them failed the list it feeds is stale, so the read is tried again a few
 * times, 3, 10 and 30 seconds later, one retry in flight at a time.
 */
export function refreshJamPublicWaiting(attempt = 0): void {
  void loadJamPublicWaiting()
    .catch(() => undefined)
    .then(() => {
      if (!waitingStale || attempt >= WAITING_RETRY_MS.length || retryTimer !== null) {
        return;
      }
      retryTimer = setTimeout(() => {
        retryTimer = null;
        refreshJamPublicWaiting(attempt + 1);
      }, WAITING_RETRY_MS[attempt]);
    });
}

/** Test seam: is a list known to be out of date. */
export function jamPublicWaitingStaleForTests(): boolean {
  return waitingStale;
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
    fetchJamTakeNotices().catch(() => null),
  ])
    .then(([consents, inbox, notices]) => {
      if (mine !== epoch) return;
      waitingStale = consents === null || inbox === null || notices === null;
      waiting = {
        consents: consents ? consents.pending : waiting.consents,
        inbox: inbox ? inbox.takes : waiting.inbox,
        notices: notices ? notices.notices : waiting.notices,
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

/**
 * A take left the inbox (put in the mix, or removed): drop it without waiting
 * for the read. The starter's notice for that song follows when this was the
 * last take waiting on it (the server empties it the same way).
 */
export function dropInboxTake(trackId: string): void {
  const dropped = waiting.inbox.find((one) => one.track.id === trackId);
  const inbox = waiting.inbox.filter((one) => one.track.id !== trackId);
  const songDone = dropped ? !inbox.some((one) => one.songId === dropped.songId) : false;
  waiting = {
    ...waiting,
    inbox,
    notices: songDone
      ? waiting.notices.filter((one) => !(one.kind === "take" && one.songId === dropped!.songId))
      : waiting.notices,
  };
  emit();
}

/** The person tapped or dismissed a take notice: it leaves the list at once, and the server keeps it spent. */
export function ackTakeNotice(id: string): void {
  waiting = { ...waiting, notices: waiting.notices.filter((one) => one.id !== id) };
  emit();
  void ackJamTakeNotice(id).catch(() => undefined);
}

// ---- the frame ---------------------------------------------------------------

const noticeListeners = new Set<(notice: JamPublicNotice) => void>();

/**
 * `jam-public-notice` is not in the chat frame union: this is how the one handler in App tells them apart.
 * The sender's `jam-take-decision` rides the same door (a distinct frame type, so a tab that predates it
 * ignores it instead of reading an unknown kind as a consent question).
 */
export function isJamPublicNotice(message: { type?: unknown }): message is JamPublicNotice | JamTakeDecision {
  return message.type === "jam-public-notice" || message.type === "jam-take-decision";
}

export function dispatchJamPublicNotice(notice: JamPublicNotice | JamTakeDecision): void {
  // A nudge: read again. The durable lists are the truth.
  if (me.enabled) {
    void loadJamPublicWaiting();
  }
  if (notice.type === "jam-take-decision") {
    // The card the list draws is the whole notice; nothing else listens.
    return;
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
/** Waiting inbox takes per song, computed once per inbox read and shared by every tile. */
let countsFor: readonly JamPublicInboxItem[] | null = null;
let countsBySong: ReadonlyMap<string, number> = new Map();
function waitingCountOf(songId: string): number {
  if (countsFor !== waiting.inbox) {
    const counts = new Map<string, number>();
    for (const item of waiting.inbox) {
      counts.set(item.songId, (counts.get(item.songId) ?? 0) + 1);
    }
    countsBySong = counts;
    countsFor = waiting.inbox;
  }
  return countsBySong.get(songId) ?? 0;
}

/** How many outside takes wait for this account's answer on one song. A tile re-renders only when ITS number moves. */
export function useJamWaitingCount(songId: string): number {
  return useSyncExternalStore(subscribe, () => waitingCountOf(songId), () => 0);
}

export function useJamPublicWaiting(): JamPublicWaiting {
  return useSyncExternalStore(subscribe, () => waiting, () => NOTHING);
}
