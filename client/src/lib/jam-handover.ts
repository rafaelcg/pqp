import { useEffect, useSyncExternalStore } from "react";
import { bidiClean } from "@/lib/bidi";
import {
  jamIntentFromSearch,
  peekJamIntent,
  type JamInstrumentName,
  type JamIntent,
} from "@/lib/jam-intent";
import { getApiBaseUrl } from "@/lib/utils";

/**
 * A person who came from the public jam site (jam.pqp.gg), and what that
 * changes inside the app for the rest of the session.
 *
 * `lib/jam-intent.ts` carries WHAT somebody came to do across the sign-up round
 * trip, and it is spent the moment the app acts on it: the song opens, the
 * stash is gone, the query string is wiped. What was missing was the other half
 * of the story, that this person is a visitor and not a member who happens to be
 * looking at a jam. Without it, closing the song dropped a brand-new account
 * into the chat product (Amigos, an empty Comunidades) with no way back to the
 * thing they signed up for (finding M1 of the launch user test).
 *
 * So this record outlives the intent, for one session, and three things read it:
 *
 *  - the first run, which counts the screens of the `jam` path and shows "tua
 *    jam tá esperando" with the song's title on the ones it does show;
 *  - the public jam view's close, which takes a visitor to the Jam site's list
 *    instead of the chat home (`leavesToJamSite`);
 *  - one strip in the app shell with "Voltar pra jam" (`JamHandoverStrip`).
 *
 * WHERE IT LIVES. `sessionStorage`: it is about this tab's visit and must not
 * follow the person into tomorrow's tab, and it survives the Clerk round trip
 * (same tab, same origin) and a reload. An hour, like the intent it comes from.
 * Storage denied or unreadable is "no handover": the app behaves as it did.
 *
 * WHO IT IS NOT. Nothing here is sent anywhere. The title is read from the
 * public jam route the site itself uses, which needs no account, so the
 * age gate (which paints before the account is usable) can say it too.
 */

export interface JamHandover {
  /** A song id, or `new` (the person came to start one). */
  target: string;
  /** They came to record: the studio opens on `instrument` when the song is open. */
  record: boolean;
  instrument: JamInstrumentName | null;
  /** The song's title once the public route answered; null until then, or for `new`. */
  title: string | null;
  at: number;
}

const KEY = "pqp:jam-handover";
export const JAM_HANDOVER_TTL_MS = 60 * 60 * 1000;

type WritableStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** The record a fresh intent starts. */
export function handoverFromIntent(
  intent: JamIntent,
  now: number,
  title: string | null = null,
): JamHandover {
  if (intent.kind === "new") {
    return { target: "new", record: false, instrument: null, title: null, at: now };
  }
  return {
    target: intent.songId,
    record: intent.record,
    instrument: intent.instrument,
    title,
    at: now,
  };
}

function isHandover(value: unknown): value is JamHandover {
  if (!value || typeof value !== "object") {
    return false;
  }
  const one = value as Partial<JamHandover>;
  return (
    typeof one.target === "string" &&
    typeof one.record === "boolean" &&
    typeof one.at === "number" &&
    (one.title === null || typeof one.title === "string") &&
    (one.instrument === null || typeof one.instrument === "string")
  );
}

/** The stored handover, or null when there is none, it expired, or it is not ours. */
export function readJamHandover(
  storage: Pick<Storage, "getItem"> | null,
  now: number = Date.now(),
): JamHandover | null {
  if (!storage) {
    return null;
  }
  try {
    const raw = storage.getItem(KEY);
    if (!raw) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!isHandover(parsed) || now - parsed.at > JAM_HANDOVER_TTL_MS || parsed.at > now + 60_000) {
      return null;
    }
    return parsed;
  } catch {
    // User-writable storage: anything unreadable is "no handover".
    return null;
  }
}

export function writeJamHandover(storage: WritableStorage | null, handover: JamHandover): void {
  if (!storage) {
    return;
  }
  try {
    storage.setItem(KEY, JSON.stringify(handover));
  } catch {
    // Storage denied: the person loses the strip, nothing else.
  }
}

export function removeJamHandover(storage: WritableStorage | null): void {
  if (!storage) {
    return;
  }
  try {
    storage.removeItem(KEY);
  } catch {
    // Nothing to do.
  }
}

/**
 * Does closing the public jam view of `target` leave the app for the Jam site?
 *
 * Only for the song the visitor came for (or the jam they started, once it has
 * a song: `rebindJamHandover`). A member who opens some other public jam from
 * the Jam wall in the same tab is inside the app on purpose, and closing goes
 * back to the wall as it always did.
 */
export function leavesToJamSite(handover: JamHandover | null, target: string): boolean {
  return handover !== null && handover.target === target;
}

// ---------------------------------------------------------------- the store

let snapshot: JamHandover | null | undefined;
const listeners = new Set<() => void>();

function sessionStore(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function localStore(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

/**
 * The current handover, read once: a stored one, else the intent the arrival
 * carries (the address, then the boot-time stash), because the age gate paints
 * before the app has acted on the intent and still has to know it is there.
 * Seeding from the intent is safe: `App` takes that same intent at the first
 * moment the account exists, so what is seeded here is what is noted there.
 */
function current(): JamHandover | null {
  if (snapshot !== undefined) {
    return snapshot;
  }
  const now = Date.now();
  const stored = readJamHandover(sessionStore(), now);
  if (stored) {
    snapshot = stored;
    return snapshot;
  }
  const intent =
    typeof window === "undefined"
      ? null
      : (jamIntentFromSearch(window.location.search) ?? peekJamIntent(localStore(), now));
  snapshot = intent ? handoverFromIntent(intent, now) : null;
  if (snapshot) {
    writeJamHandover(sessionStore(), snapshot);
  }
  return snapshot;
}

function set(next: JamHandover | null): void {
  snapshot = next;
  if (next) {
    writeJamHandover(sessionStore(), next);
  } else {
    removeJamHandover(sessionStore());
  }
  emit();
}

export function peekJamHandover(): JamHandover | null {
  const held = current();
  if (held && Date.now() - held.at > JAM_HANDOVER_TTL_MS) {
    snapshot = null;
    removeJamHandover(sessionStore());
    return null;
  }
  return held;
}

/**
 * The app acted on an intent from the site: this session came from there. The
 * title is kept when it is the same song (the age gate may have fetched it).
 */
export function noteJamHandover(intent: JamIntent): void {
  const held = peekJamHandover();
  const target = intent.kind === "new" ? "new" : intent.songId;
  set(handoverFromIntent(intent, Date.now(), held && held.target === target ? held.title : null));
}

/** A jam the visitor started got its first part: from now on it is "the jam they came from". */
export function rebindJamHandover(songId: string): void {
  const held = peekJamHandover();
  if (held && held.target === "new") {
    set({ ...held, target: songId, record: false, instrument: null, at: Date.now() });
  }
}

/** "Not now": the strip goes, and so does the leave-on-close. */
export function dismissJamHandover(): void {
  set(null);
}

function setTitle(target: string, title: string): void {
  const held = peekJamHandover();
  if (held && held.target === target && held.title !== title) {
    snapshot = { ...held, title };
    writeJamHandover(sessionStore(), snapshot);
    emit();
  }
}

export function subscribeJamHandover(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam: forget the in-memory copy so the next read goes to storage again. */
export function resetJamHandoverForTests(): void {
  snapshot = undefined;
  listeners.clear();
}

export function useJamHandover(): JamHandover | null {
  return useSyncExternalStore(subscribeJamHandover, peekJamHandover, () => null);
}

// ---------------------------------------------------------------- the title

const requested = new Set<string>();

/**
 * Ask the public jam route for the song's title, once per song per page, and
 * write it onto the handover. Best effort and silent: a route that is off
 * (`jam_public`), a network failure or a song that is gone leaves the screens
 * saying "tua jam tá esperando" without a name, which is still true.
 */
export function resolveJamHandoverTitle(handover: JamHandover | null): void {
  if (!handover || handover.target === "new" || handover.title !== null || requested.has(handover.target)) {
    return;
  }
  const target = handover.target;
  requested.add(target);
  void (async () => {
    try {
      const response = await fetch(
        `${getApiBaseUrl()}/api/public/jams/${encodeURIComponent(target)}`,
        { headers: { accept: "application/json" } },
      );
      if (!response.ok) {
        return;
      }
      const body: unknown = await response.json();
      const song = body && typeof body === "object" ? (body as { song?: unknown }).song : null;
      const title =
        song && typeof song === "object" ? (song as { title?: unknown }).title : null;
      if (typeof title === "string" && title.trim() !== "") {
        setTitle(target, bidiClean(title.trim()));
      }
    } catch {
      // Silent: see above.
      requested.delete(target);
    }
  })();
}

/** The handover, and the title fetched for it while a screen is showing it. */
export function useJamArrival(): JamHandover | null {
  const handover = useJamHandover();
  useEffect(() => {
    resolveJamHandoverTitle(handover);
  }, [handover]);
  return handover;
}
