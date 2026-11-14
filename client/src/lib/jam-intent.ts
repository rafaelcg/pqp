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
 *   ?jam=<songId>&act=report[&track=<trackId>][&reason=copyright]
 *                                              "report this jam", or one part of it,
 *                                              optionally already as a copyright report
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
 * WHAT THE APP DOES WITH IT. `App` takes the intent with `takeJamIntent` and
 * hands it to the public jam view (`lib/jam-public-nav.ts`), which opens the
 * song (and the studio when `record` is set, a like, a report, or the start
 * sheet). `docs/JAM_SITE.md` has the hand-over.
 *
 * WHERE PEOPLE CAME FROM. The hand-over also carries `ref` and any `utm_*` the
 * public site was opened with, and `ref=jam` when it had no `ref`, so the
 * account that comes out of this sign-up lands in the acquisition report
 * (`lib/acquisition.ts`, read at the app's boot from the very same URL) as
 * "came from the jam site" or "came from this clip". See `JamAttribution`
 * below. No tag, no beacon: parameters on a link the person clicked.
 *
 * Consume-on-read, a one hour TTL, storage-denied tolerance: all as the other
 * intents, for the same reasons (an intent that outlives its action repeats).
 */

export type JamInstrumentName = "guitar" | "bass" | "drums" | "vocals" | "keys" | "other";

const INSTRUMENTS: readonly string[] = ["guitar", "bass", "drums", "vocals", "keys", "other"];

export type JamAct = "like" | "report";

/** The one reason a link may ask the report dialog to open on. */
export type JamReportReason = "copyright";

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
      /** A report that already knows its reason (the site's "copyright" menu item). */
      reason?: JamReportReason | null;
    };

const KEY = "pqp:pending-jam";
export const JAM_INTENT_TTL_MS = 60 * 60 * 1000;
/** The query parameters this intent is read from, for the URL clean-up. */
export const JAM_INTENT_PARAMS = ["jam", "record", "instrument", "act", "track", "reason"] as const;

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
    ...(act === "report" && params.get("reason") === "copyright" ? { reason: "copyright" as const } : {}),
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
    if (intent.act === "report" && intent.reason) {
      params.set("reason", intent.reason);
    }
  }
  return params.toString();
}

/** The app URL every sign-up button of the public site points at. */
export function jamIntentHref(
  intent: JamIntent,
  origin = "",
  attribution: JamAttribution | null = null,
): string {
  return `${origin}/app?${jamIntentQuery(intent)}&${jamAttributionQuery(attribution)}`;
}

// ------------------------------------------------------------ attribution

/**
 * Where a visit to the public site came from, as the acquisition report
 * already knows how to read it: pqp's own `ref` and the UTM trio. Nothing else
 * from the query string is ever forwarded (no `gclid`, no `fbclid`, no
 * `jam=...`), and nothing is sent anywhere by this code: the values ride as
 * ordinary parameters on the link to the app, where `lib/acquisition.ts` stashes
 * them at boot and sends them once after the account exists.
 */
export interface JamAttribution {
  ref?: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
}

/** What `ref` is when the public site was opened with none: "came from jam.pqp.gg". */
export const JAM_DEFAULT_REF = "jam";

export const JAM_ATTRIBUTION_PARAMS = ["ref", "utm_source", "utm_medium", "utm_campaign"] as const;

/** The same bound `lib/acquisition.ts` clips every field to. */
const ATTRIBUTION_FIELD_MAX = 100;

const ATTRIBUTION_KEY = "pqp:jam-attribution";
/** As long as the app's own stash (`ACQUISITION_TTL_MS`): "saw the clip, signed up a fortnight later". */
export const JAM_ATTRIBUTION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function attributionValue(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  // Control characters and whitespace runs are folded out: this is a label, not text.
  const clean = raw.replace(/[\p{Cc}\s]+/gu, " ").trim().slice(0, ATTRIBUTION_FIELD_MAX);
  return clean === "" ? undefined : clean;
}

/** The `ref` and `utm_*` on a URL, or null when it carries none of them. */
export function jamAttributionFromSearch(search: string): JamAttribution | null {
  const params = new URLSearchParams(search);
  const found: JamAttribution = {};
  for (const key of JAM_ATTRIBUTION_PARAMS) {
    const value = attributionValue(params.get(key));
    if (value !== undefined) {
      found[key] = value;
    }
  }
  return Object.keys(found).length === 0 ? null : found;
}

/**
 * The query string (no leading `?`) the hand-over appends. Always has a `ref`:
 * the one the site was opened with, else `jam`.
 */
export function jamAttributionQuery(attribution: JamAttribution | null): string {
  const params = new URLSearchParams();
  params.set("ref", attribution?.ref ?? JAM_DEFAULT_REF);
  for (const key of ["utm_source", "utm_medium", "utm_campaign"] as const) {
    const value = attribution?.[key];
    if (value) {
      params.set(key, value);
    }
  }
  return params.toString();
}

/** A link to somewhere on the main site (not a jam intent) that keeps the attribution. */
export function jamMainHref(path: string, origin = "", attribution: JamAttribution | null = null): string {
  return `${origin}${path}${path.includes("?") ? "&" : "?"}${jamAttributionQuery(attribution)}`;
}

function readAttribution(storage: Pick<Storage, "getItem"> | null, now: number): JamAttribution | null {
  if (!storage) {
    return null;
  }
  try {
    const raw = storage.getItem(ATTRIBUTION_KEY);
    if (!raw) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || typeof (parsed as { at?: unknown }).at !== "number") {
      return null;
    }
    const { at, value } = parsed as { at: number; value?: unknown };
    if (now - at > JAM_ATTRIBUTION_TTL_MS || at > now + 60_000 || !value || typeof value !== "object") {
      return null;
    }
    const found: JamAttribution = {};
    for (const key of JAM_ATTRIBUTION_PARAMS) {
      const one = attributionValue((value as Record<string, unknown>)[key]);
      if (one !== undefined) {
        found[key] = one;
      }
    }
    return Object.keys(found).length === 0 ? null : found;
  } catch {
    // User-writable storage: anything unreadable is "no attribution".
    return null;
  }
}

/**
 * At the public site's boot: the sign-up buttons are often a page or two away
 * from the address the person arrived on, and the site moves with `pushState`,
 * so the arrival's parameters are written down now. First touch, like the
 * app's own stash: a second explicit arrival inside the window changes nothing.
 */
export function rememberJamAttribution(
  storage: WritableStorage | null,
  search: string,
  now: number = Date.now(),
): void {
  const arrived = jamAttributionFromSearch(search);
  if (!storage || !arrived || readAttribution(storage, now)) {
    return;
  }
  try {
    storage.setItem(ATTRIBUTION_KEY, JSON.stringify({ value: arrived, at: now }));
  } catch {
    // Storage denied: the current address still says it while the person stays on it.
  }
}

/**
 * What a hand-over carries: the first remembered arrival, else this address,
 * else nothing (and `jamAttributionQuery` then says `ref=jam`).
 */
export function currentJamAttribution(
  storage: Pick<Storage, "getItem"> | null,
  search: string,
  now: number = Date.now(),
): JamAttribution | null {
  return readAttribution(storage, now) ?? jamAttributionFromSearch(search);
}

function encode(intent: JamIntent): string {
  if (intent.kind === "new") {
    return "new";
  }
  if (!intent.record) {
    if (intent.act === "like") return `${intent.songId}:like`;
    if (intent.act === "report") {
      const base = intent.trackId ? `${intent.songId}:report:${intent.trackId}` : `${intent.songId}:report`;
      return intent.reason ? `${base}${intent.trackId ? "" : ":-"}:${intent.reason}` : base;
    }
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
  const [songId = "", flag, extra, extra2] = value.split(":");
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
    ...(act === "report" && (extra === "copyright" || extra2 === "copyright") ? { reason: "copyright" as const } : {}),
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
