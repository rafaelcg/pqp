/**
 * Which link brought somebody here, remembered until they sign up.
 *
 * WHAT THIS IS. A paid or organic channel is judged by signups, not clicks, and
 * the two events are minutes to weeks apart with a Clerk round trip in between.
 * The landing page sees `?utm_source=...` (or `gclid`, or the site's own
 * `ref`); the account does not exist yet. So the parameters are stashed here at
 * boot, survive the sign-up the same way the handle intents do (see
 * `handle-intent.ts` for why localStorage and not sessionStorage), and are sent
 * to the API exactly once on the first ready bootstrap, then deleted. The
 * server keeps them only on an account that has none, so a second visit with a
 * different campaign changes nothing: first touch, and only ever first touch.
 *
 * WHAT IT IS NOT. Not a cookie, not a tag, not an identifier. There is no id
 * in the stored object and none is sent, the store is the site's own origin,
 * and the third parties the cookie notice lists stay exactly as listed. The
 * whole point of doing it this way is that the cookie notice's "no analytics
 * cookies, no third-party tracking" stays true while the operator still learns
 * whether a campaign produced anybody.
 *
 * WHY FIRST TOUCH IN THE STASH TOO. A person can open three campaign links
 * before they sign up. Overwriting would credit the last one; the question the
 * report answers is which one found them, and that is the first.
 *
 * WHY A 30-DAY TTL. Long enough to cover "saw the ad, came back a fortnight
 * later and signed up", short enough that a stash left behind by somebody who
 * never signed up does not sit there indefinitely. Nothing acts on an expired
 * entry; it is simply dropped on read.
 *
 * Every function tolerates storage being denied by doing nothing, which loses
 * one attribution and nothing else.
 */

import type { AcquisitionInput } from "@pqp/shared";

export const ACQUISITION_KEY = "pqp:acquisition";

export const ACQUISITION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Same bounds as `acquisitionSchema`; anything longer is cut, not refused. */
const FIELD_MAX = 100;
const GCLID_MAX = 200;
const LANDING_MAX = 200;

export type Acquisition = AcquisitionInput;

interface StoredAcquisition extends Acquisition {
  at: number;
}

type WritableStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function clip(value: string | null, max: number): string | undefined {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? undefined : trimmed.slice(0, max);
}

/**
 * The campaign parameters in a query string, or null when it carries none.
 *
 * `ref` is the site's own parameter, for links pqp hands out itself; the UTM
 * trio and `gclid` are what ad platforms and newsletters append. Everything
 * else in the query string is ignored, including `add`/`claim`/`join`, which
 * are intents and not attribution. The landing path is recorded alongside
 * because "/tela" and "/" are different doors even under the same campaign.
 */
export function acquisitionFromLocation(
  search: string,
  pathname: string,
): Acquisition | null {
  const params = new URLSearchParams(search);
  const acquisition: Acquisition = {
    source: clip(params.get("utm_source"), FIELD_MAX),
    medium: clip(params.get("utm_medium"), FIELD_MAX),
    campaign: clip(params.get("utm_campaign"), FIELD_MAX),
    gclid: clip(params.get("gclid"), GCLID_MAX),
    ref: clip(params.get("ref"), FIELD_MAX),
  };
  const carriesSomething = Object.values(acquisition).some(
    (value) => value !== undefined,
  );
  if (!carriesSomething) {
    return null;
  }
  acquisition.landing = clip(pathname, LANDING_MAX) ?? "/";
  return compact(acquisition);
}

/** Drop the undefined keys so the stored JSON says only what was there. */
function compact(acquisition: Acquisition): Acquisition {
  const out: Acquisition = {};
  for (const [key, value] of Object.entries(acquisition) as [
    keyof Acquisition,
    string | undefined,
  ][]) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

/** The live (unexpired, well-formed) entry's fields, or null. */
function readStored(
  storage: WritableStorage | null,
  now: number,
): Acquisition | null {
  if (!storage) {
    return null;
  }
  let raw: string | null;
  try {
    raw = storage.getItem(ACQUISITION_KEY);
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
      Array.isArray(parsed) ||
      typeof (parsed as StoredAcquisition).at !== "number"
    ) {
      return null;
    }
    const stored = parsed as StoredAcquisition;
    if (now - stored.at > ACQUISITION_TTL_MS || stored.at > now + 60_000) {
      return null;
    }
    const fields: Acquisition = {};
    for (const key of [
      "source",
      "medium",
      "campaign",
      "gclid",
      "ref",
      "landing",
    ] as const) {
      const value = stored[key];
      if (typeof value === "string" && value !== "") {
        fields[key] = value;
      }
    }
    return Object.keys(fields).length === 0 ? null : fields;
  } catch {
    // User-writable storage. Anything unreadable is "no record".
    return null;
  }
}

/**
 * Remember an acquisition, unless a live one is already there.
 *
 * "Live" means unexpired: an entry past its TTL is as good as absent, so a
 * fresh campaign visit a month after an abandoned one does get recorded.
 */
export function stashAcquisition(
  storage: WritableStorage | null,
  acquisition: Acquisition | null,
  now: number = Date.now(),
): void {
  if (!storage || !acquisition) {
    return;
  }
  if (readStored(storage, now)) {
    return;
  }
  try {
    storage.setItem(
      ACQUISITION_KEY,
      JSON.stringify({ ...compact(acquisition), at: now } satisfies StoredAcquisition),
    );
  } catch {
    // Storage denied. One attribution is the whole cost.
  }
}

/**
 * Read and CONSUME. Never a plain read: the value causes one request, and a
 * stash that survives the request it caused is a request that repeats.
 * Expired and unreadable entries are removed too, so the key does not linger.
 */
export function takeAcquisition(
  storage: WritableStorage | null,
  now: number = Date.now(),
): Acquisition | null {
  if (!storage) {
    return null;
  }
  const stored = readStored(storage, now);
  try {
    storage.removeItem(ACQUISITION_KEY);
  } catch {
    return null;
  }
  return stored;
}

/**
 * What `main.tsx` calls once at boot, before routing: look at the URL this
 * page loaded with and remember it if it carries a campaign. The URL itself is
 * left alone; stripping parameters from the address bar is a decision for the
 * page that owns the route, not for a boot hook.
 */
export function rememberAcquisitionFromLocation(
  storage: WritableStorage | null,
  location: Pick<Location, "search" | "pathname">,
  now: number = Date.now(),
): void {
  stashAcquisition(
    storage,
    acquisitionFromLocation(location.search, location.pathname),
    now,
  );
}
