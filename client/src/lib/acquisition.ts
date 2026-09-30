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
 * WHAT A LINK WITH NO CAMPAIGN RECORDS (2026-09-29). Most doors carry no
 * parameters at all: a streamer's plain `pqp.gg/c/<slug>` in chat, a link in a
 * bio. Recording nothing for those left 210 of 213 viewers of one watch party
 * with no acquisition row. So a visit with no parameters still records the
 * page it landed on and, when the browser volunteers one, the SITE it came
 * from (the referrer's host only, never its path or query; an Android Custom
 * Tab reports the app's package, `android-app://com.twitch.android.app`).
 * That entry is "plain" and is the weakest claim there is: a later link with
 * real campaign parameters replaces it (first EXPLICIT touch), and two plain
 * ones never replace each other. Landing paths are cut to their first segment
 * except `/c/<slug>`, so an invite code in the path is never stored.
 *
 * Every function tolerates storage being denied by doing nothing, which loses
 * one attribution and nothing else.
 */

import type { AcquisitionInput } from "@pqp/shared";

export const ACQUISITION_KEY = "pqp:acquisition";

/**
 * Set the first time a stash is consumed on this browser. A plain visit is
 * only remembered while it is absent: without it every reload of a signed-in
 * person would stash a fresh landing and send it on the next bootstrap, one
 * pointless request per page load for everybody who already has an account.
 * With it, a returning account costs one request per browser, ever.
 */
export const ACQUISITION_DONE_KEY = "pqp:acquisition-done";

export const ACQUISITION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Same bounds as `acquisitionSchema`; anything longer is cut, not refused. */
const FIELD_MAX = 100;
const GCLID_MAX = 200;
const LANDING_MAX = 200;

export type Acquisition = AcquisitionInput;

interface StoredAcquisition extends Acquisition {
  at: number;
  /** No campaign parameters: a landing (and maybe a referrer host) only. */
  plain?: boolean;
}

/** What `main.tsx` knows about this page load beyond the URL. */
export interface ArrivalContext {
  referrer: string;
  hostname: string;
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
  acquisition.landing = landingForStorage(pathname);
  return compact(acquisition);
}

/**
 * The landing path, safe to keep: `/c/<slug>` whole (a public address), and
 * every other path down to its first segment (`/@rafa`, `/tela`, `/blog`,
 * `/invite`, `/app`), because the rest of a path can be a capability.
 */
export function landingForStorage(pathname: string): string {
  const segments = pathname.split("/").filter((segment) => segment !== "");
  if (segments.length === 0) {
    return "/";
  }
  const keep = segments[0] === "c" ? 2 : 1;
  return clip(`/${segments.slice(0, keep).join("/")}`, LANDING_MAX) ?? "/";
}

/**
 * The same site: the same host, or one a subdomain of the other
 * (`staging.pqp.gg` and `pqp.gg`). Deliberately NOT "same last two labels",
 * which would call every `*.co.uk` site ours on a `.co.uk` self-host.
 */
function sameSite(host: string, own: string): boolean {
  return (
    own !== "" &&
    (host === own || host.endsWith(`.${own}`) || own.endsWith(`.${host}`))
  );
}

/**
 * The referring SITE, as a coarse source label, or null when there is none or
 * it is us or our own sign-in. Host only: a referrer's path and query are the
 * other site's business and can hold anything.
 */
export function referrerSource(
  referrer: string,
  ownHostname: string,
): { source: string; medium: string } | null {
  let url: URL;
  try {
    url = new URL(referrer);
  } catch {
    return null;
  }
  if (url.protocol === "android-app:") {
    const pkg = clip(url.hostname || url.pathname.replace(/^\/+/, ""), FIELD_MAX - 12);
    return pkg ? { source: `android-app:${pkg}`, medium: "referral" } : null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (
    host === "" ||
    host === "localhost" ||
    sameSite(host, ownHostname.toLowerCase().replace(/^www\./, "")) ||
    host.endsWith("clerk.accounts.dev") ||
    host.endsWith(".clerk.com")
  ) {
    return null;
  }
  return { source: clip(host, FIELD_MAX) ?? host, medium: "referral" };
}

/** A visit that carried no campaign: where it landed, and who sent it. */
export function plainAcquisition(
  pathname: string,
  context: ArrivalContext,
): Acquisition {
  const from = referrerSource(context.referrer, context.hostname);
  return compact({
    source: from?.source,
    medium: from?.medium,
    landing: landingForStorage(pathname),
  });
}

/** Drop the undefined keys so the stored JSON says only what was there. */
function compact(acquisition: Acquisition): Acquisition {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(acquisition)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out as Acquisition;
}

/** The live (unexpired, well-formed) entry's fields, or null. */
function readStored(
  storage: WritableStorage | null,
  now: number,
): (Acquisition & { plain?: boolean }) | null {
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
    if (Object.keys(fields).length === 0) {
      return null;
    }
    return stored.plain === true ? { ...fields, plain: true } : fields;
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
  plain = false,
): void {
  if (!storage || !acquisition) {
    return;
  }
  const existing = readStored(storage, now);
  // First touch, with one exception: a real campaign replaces a plain visit
  // (a landing and maybe a referrer), never the other way round.
  if (existing && !(existing.plain === true && !plain)) {
    return;
  }
  try {
    storage.setItem(
      ACQUISITION_KEY,
      JSON.stringify({
        ...compact(acquisition),
        at: now,
        ...(plain ? { plain: true } : {}),
      } satisfies StoredAcquisition),
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
  const stored = peekAcquisition(storage, now);
  acknowledgeAcquisition(storage, stored !== null);
  return stored;
}

/**
 * Read WITHOUT consuming. What the app uses: the stash is only cleared by
 * `acknowledgeAcquisition` once the server has accepted it, so a request that
 * failed (a dropped connection, a 503 from the breaker) is sent again on the
 * next load instead of losing the attribution for good.
 */
export function peekAcquisition(
  storage: WritableStorage | null,
  now: number = Date.now(),
): Acquisition | null {
  if (!storage) {
    return null;
  }
  const stored = readStored(storage, now);
  if (!stored) {
    return null;
  }
  const { plain: _plain, ...fields } = stored;
  return fields;
}

/**
 * The server accepted it (or refused it for good): clear the stash and, only when something was actually sent, set the marker
 * that stops later plain visits being stashed again on this browser.
 */
export function acknowledgeAcquisition(
  storage: WritableStorage | null,
  sent: boolean,
): void {
  if (!storage) {
    return;
  }
  try {
    storage.removeItem(ACQUISITION_KEY);
    if (sent) {
      storage.setItem(ACQUISITION_DONE_KEY, "1");
    }
  } catch {
    // Storage denied: the plain visit may repeat. Harmless, server-refused.
  }
}

function hasConsumedBefore(storage: WritableStorage | null): boolean {
  try {
    return storage?.getItem(ACQUISITION_DONE_KEY) != null;
  } catch {
    return true;
  }
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
  arrival?: ArrivalContext,
): void {
  const campaign = acquisitionFromLocation(location.search, location.pathname);
  if (campaign) {
    stashAcquisition(storage, campaign, now);
    return;
  }
  // No campaign parameters. Without the page-load context (a caller that only
  // has a URL) there is nothing to record, exactly as before.
  if (arrival && !hasConsumedBefore(storage)) {
    stashAcquisition(storage, plainAcquisition(location.pathname, arrival), now, true);
  }
}
