/**
 * What somebody came to do on the public jam site (jam.pqp.gg, `/jam`) and
 * could not, because they have no account yet. The same shape as the handle
 * and community intents in `handle-intent.ts`, and for the same reason: the
 * sign-up round trip keeps the path and drops the query, so the intention has
 * to be written down somewhere the app can find it afterwards.
 *
 *   ?jam=<songId>&record=1[&instrument=bass]   "record a part on this jam"
 *   ?jam=<songId>                              "take me to this jam"
 *   ?jam=<songId>&act=like                     "like this jam" (the heart, signed out)
 *   ?jam=<songId>&act=report[&track=<trackId>] "report this jam", or one part of it
 *   ?jam=new                                   "let me start a jam"
 *
 * TWO CARRIERS. On the hosted site the public pages live on `jam.pqp.gg` and
 * the app on `pqp.gg`: two origins, so a `localStorage` stash written by the
 * public page is invisible to the app. The URL is therefore the carrier there
 * (`jamIntentHref` always writes it) and `rememberJamIntentFromLocation`, run
 * at the app's boot, turns it into a one-hour stash on the app's own origin
 * that survives Clerk's redirect. On a same-origin mount (`/jam`, a preview,
 * localhost) the public page also stashes directly.
 *
 * WHAT THE APP DOES WITH IT TODAY. Nothing public-jam-shaped exists in the app
 * yet, so `App` peeks the intent (never consumes it) and sends the person back
 * to the public page with `?from=app`, which says "open in the app" honestly.
 * The in-app public jam view takes the intent with `takeJamIntent` and opens
 * the song (and the studio when `record` is set). `docs/JAM_SITE.md` has the
 * full hand-over.
 *
 * Consume-on-read, a one hour TTL, storage-denied tolerance: all as the other
 * intents, for the same reasons (an intent that outlives its action repeats).
 */

export type JamInstrumentName = "guitar" | "bass" | "drums" | "vocals" | "keys" | "other";

const INSTRUMENTS: readonly string[] = ["guitar", "bass", "drums", "vocals", "keys", "other"];

export type JamAct = "like" | "report";

export type JamIntent =
  | { kind: "new" }
  | {
      kind: "song";
      songId: string;
      record: boolean;
      instrument: JamInstrumentName | null;
      /** What else the person tried before sign-up: like it, or report it (or one part of it). */
      act?: JamAct | null;
      trackId?: string | null;
    };

const KEY = "pqp:pending-jam";
export const JAM_INTENT_TTL_MS = 60 * 60 * 1000;
/** The query parameters this intent is read from, for the URL clean-up. */
export const JAM_INTENT_PARAMS = ["jam", "record", "instrument", "act", "track"] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type WritableStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function instrumentOf(raw: string | null | undefined): JamInstrumentName | null {
  return raw && INSTRUMENTS.includes(raw) ? (raw as JamInstrumentName) : null;
}

/** The intent on a URL, or null when the shape is not one we mean. */
export function jamIntentFromSearch(search: string): JamIntent | null {
  const params = new URLSearchParams(search);
  const raw = params.get("jam")?.trim().toLowerCase() ?? "";
  if (raw === "new") {
    return { kind: "new" };
  }
  if (!UUID.test(raw)) {
    return null;
  }
  const record = params.get("record") === "1";
  const act = !record && (params.get("act") === "like" || params.get("act") === "report") ? (params.get("act") as JamAct) : null;
  const track = act === "report" ? (params.get("track")?.trim().toLowerCase() ?? "") : "";
  return {
    kind: "song",
    songId: raw,
    record,
    instrument: record ? instrumentOf(params.get("instrument")) : null,
    act,
    trackId: UUID.test(track) ? track : null,
  };
}

/** The query string (no leading `?`) that carries an intent. */
export function jamIntentQuery(intent: JamIntent): string {
  if (intent.kind === "new") {
    return "jam=new";
  }
  const params = new URLSearchParams({ jam: intent.songId });
  if (intent.record) {
    params.set("record", "1");
    if (intent.instrument) {
      params.set("instrument", intent.instrument);
    }
  } else if (intent.act) {
    params.set("act", intent.act);
    if (intent.act === "report" && intent.trackId) {
      params.set("track", intent.trackId);
    }
  }
  return params.toString();
}

/** The app URL every sign-up button of the public site points at. */
export function jamIntentHref(intent: JamIntent, origin = ""): string {
  return `${origin}/app?${jamIntentQuery(intent)}`;
}

function encode(intent: JamIntent): string {
  if (intent.kind === "new") {
    return "new";
  }
  if (!intent.record) {
    if (intent.act === "like") return `${intent.songId}:like`;
    if (intent.act === "report") return intent.trackId ? `${intent.songId}:report:${intent.trackId}` : `${intent.songId}:report`;
    return intent.songId;
  }
  return intent.instrument
    ? `${intent.songId}:record:${intent.instrument}`
    : `${intent.songId}:record`;
}

function decode(value: string): JamIntent | null {
  if (value === "new") {
    return { kind: "new" };
  }
  const [songId = "", flag, extra] = value.split(":");
  if (!UUID.test(songId)) {
    return null;
  }
  const record = flag === "record";
  const act: JamAct | null = !record && (flag === "like" || flag === "report") ? flag : null;
  return {
    kind: "song",
    songId: songId.toLowerCase(),
    record,
    instrument: record ? instrumentOf(extra) : null,
    act,
    trackId: act === "report" && extra && UUID.test(extra) ? extra.toLowerCase() : null,
  };
}

function read(storage: Pick<Storage, "getItem"> | null, now: number): JamIntent | null {
  if (!storage) {
    return null;
  }
  let raw: string | null;
  try {
    raw = storage.getItem(KEY);
  } catch {
    return null;
  }
  if (!raw) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof (parsed as { value?: unknown }).value !== "string" ||
      typeof (parsed as { at?: unknown }).at !== "number"
    ) {
      return null;
    }
    const { value, at } = parsed as { value: string; at: number };
    return now - at > JAM_INTENT_TTL_MS ? null : decode(value);
  } catch {
    // User-writable storage: anything unreadable is "no intent".
    return null;
  }
}

export function stashJamIntent(
  storage: WritableStorage | null,
  intent: JamIntent,
  now: number = Date.now(),
): void {
  if (!storage) {
    return;
  }
  try {
    storage.setItem(KEY, JSON.stringify({ value: encode(intent), at: now }));
  } catch {
    // Storage denied: one extra click is the whole cost.
  }
}

/** Read WITHOUT consuming. */
export function peekJamIntent(
  storage: Pick<Storage, "getItem"> | null,
  now: number = Date.now(),
): JamIntent | null {
  return read(storage, now);
}

/** Read and CONSUME. */
export function takeJamIntent(
  storage: WritableStorage | null,
  now: number = Date.now(),
): JamIntent | null {
  const intent = read(storage, now);
  if (storage) {
    try {
      storage.removeItem(KEY);
    } catch {
      // Nothing to do.
    }
  }
  return intent;
}

/** At the app's boot, before routing: the sign-in redirect drops the query. */
export function rememberJamIntentFromLocation(
  storage: WritableStorage | null,
  location: Pick<Location, "search">,
  now: number = Date.now(),
): void {
  const intent = jamIntentFromSearch(location.search);
  if (intent) {
    stashJamIntent(storage, intent, now);
  }
}

/**
 * Where the public site shows a song the person just came back from the app
 * for: `?from=app` is the marker for the "open in the app" state.
 */
export function jamReturnPath(intent: JamIntent): string {
  if (intent.kind === "new") {
    return "/jam?from=app&jam=new";
  }
  const params = new URLSearchParams({ from: "app" });
  if (intent.record) {
    params.set("record", "1");
    if (intent.instrument) {
      params.set("instrument", intent.instrument);
    }
  }
  // like and report have nothing to say on the public page: it just opens the song.
  return `/jam/m/${intent.songId}?${params.toString()}`;
}
