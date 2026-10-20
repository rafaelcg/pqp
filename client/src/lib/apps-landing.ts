/**
 * The public pages of pqp Apps (`/apps`, `/apps/locadora`, `/locadora`): the
 * three small decisions they share, kept out of the components so each can be
 * tested alone.
 *
 * 1. Do they exist? The runtime flag `apps_landing`, read from
 *    `GET /api/public/apps/config` (no auth, `{ enabled }`). Off, unknown, an
 *    older API with no such route, a network error and a malformed body all
 *    mean the same thing: the pages do not exist, the router sends a visitor to
 *    `/`. A failure is only remembered for `RETRY_AFTER_MS`, so a blip does not
 *    keep a real page dark until the next full load. Same shape as
 *    `hooks/use-communities-enabled.ts`, and for the same reason: a signed-out
 *    visitor is who these pages are for, and every authenticated config route
 *    answers them 401.
 * 2. Where does the docs link go? `VITE_APPS_DOCS_URL`, hosted-only in spirit
 *    exactly like the donation links (`support-links.ts`): empty means the link
 *    is not drawn, and a self-host never inherits ours.
 * 3. What do the sign-up buttons carry? The site's own `?ref=` tag, through the
 *    acquisition stash that already survives a Clerk round trip
 *    (`acquisition.ts`), so `users.acquisition_ref` says which of the two pages
 *    produced an account.
 *
 * MEASUREMENT IS ONE CLOSED EVENT. `apps_door_view`, through `track()` (inert
 * without the hosted Umami tag), with no properties: which of the two pages
 * is already the path Umami records, and nothing here names a person, a game
 * or a file. The events after the click (guest play and the rest of the
 * telemetry spec's funnel) belong to the guest-play change and are
 * deliberately not here.
 */

import { stashAcquisition, landingForStorage } from "./acquisition";
import { intentStorage } from "./handle-intent";
import { track } from "./track";
import { getApiBaseUrl } from "./utils";

export const APPS_LANDING_REF = "apps-landing";
export const LOCADORA_LANDING_REF = "locadora-landing";
export type AppsLandingRef = typeof APPS_LANDING_REF | typeof LOCADORA_LANDING_REF;

/** The one event these pages send. A name, no properties. */
export const APPS_DOOR_VIEW_EVENT = "apps_door_view";

/** Where the sign-up buttons end up: the app, with the page's tag on the URL as the belt. */
export function appsCtaHref(ref: AppsLandingRef): string {
  return `/app?ref=${ref}`;
}

/**
 * Remember which page the sign-up started from, before Clerk takes over (the
 * modal can end in a navigation this page does not survive). First touch is the
 * stash's own rule: a campaign that already found this browser keeps the
 * credit, and a plain visit (just a landing) is replaced by this explicit tag.
 */
export function rememberAppsRef(
  ref: AppsLandingRef,
  path: "/apps" | "/apps/locadora",
  storage = intentStorage(),
  now: number = Date.now(),
): void {
  stashAcquisition(storage, { ref, landing: landingForStorage(path) }, now);
}

export function trackAppsDoorView(): void {
  track(APPS_DOOR_VIEW_EVENT);
}

// ------------------------------------------------------------- the docs link

export interface AppsDocsEnv {
  readonly VITE_APPS_DOCS_URL?: unknown;
}

/**
 * The docs URL, or null. Only an absolute http(s) URL survives: the value ends
 * up in an `href`, and anything else (a `javascript:` URL, a relative path, a
 * stray word) is "not configured".
 */
export function appsDocsUrlFrom(env: AppsDocsEnv): string | null {
  const raw = env.VITE_APPS_DOCS_URL;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export function appsDocsUrl(): string | null {
  return appsDocsUrlFrom({ VITE_APPS_DOCS_URL: import.meta.env.VITE_APPS_DOCS_URL });
}

// ------------------------------------------------------------------ the flag

export const RETRY_AFTER_MS = 5_000;

let answer: boolean | null = null;
let inflight: Promise<boolean> | null = null;
let failedAt = 0;

export function resetAppsLandingProbe(): void {
  answer = null;
  inflight = null;
  failedAt = 0;
}

async function ask(): Promise<boolean> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/public/apps/config`, {
      headers: { accept: "application/json" },
    });
    // Drain the body even for an answer that is thrown away, so the request is
    // not left "in flight" (it keeps `networkidle` from ever firing).
    const text = await response.text();
    if (response.status !== 200) throw new Error(`status ${response.status}`);
    const body = JSON.parse(text) as { enabled?: unknown };
    if (typeof body.enabled !== "boolean") throw new Error("malformed");
    answer = body.enabled;
    failedAt = 0;
    return answer;
  } catch {
    failedAt = Date.now();
    return false;
  }
}

/** True only on a clean 200 `{ enabled: true }`. */
export function probeAppsLanding(): Promise<boolean> {
  if (answer !== null) return Promise.resolve(answer);
  if (inflight) return inflight;
  if (failedAt && Date.now() - failedAt < RETRY_AFTER_MS) {
    return Promise.resolve(false);
  }
  inflight = ask().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** What the last clean answer said, or null while nothing has answered yet. */
export function cachedAppsLanding(): boolean | null {
  return answer;
}
