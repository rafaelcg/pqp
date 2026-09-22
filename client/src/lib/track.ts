/**
 * One named event to the hosted site's Umami, or nothing at all.
 *
 * WHY IT IS INERT ON A SELF-HOST BY CONSTRUCTION. The Umami tag is injected
 * into `index.html` at build time only when `VITE_UMAMI_WEBSITE_ID` is set
 * (`vite.config.ts`, the `pqp-umami` plugin), which is the hosted build and
 * never a self-host (AGPL: nobody inherits our analytics). With no tag there
 * is no `window.umami`, and this is a no-op. Nothing here loads a script,
 * sets a cookie or names a person: an event is a name and a few labels.
 *
 * NEVER THROWS. Analytics is the last thing allowed to break a sign-up, so a
 * tag that is missing, half-loaded, blocked or throwing is swallowed here.
 *
 * The first-run funnel is the reason this exists (docs/ONBOARDING.md):
 * `onboarding_start` → `age_gate_pass` → `onboarding_you_next` →
 * `onboarding_room_door` → `onboarding_server_created` →
 * `onboarding_invite_copied`, and `arrival_view` for the invitee.
 */

export type TrackData = Record<string, string | number | boolean>;

interface UmamiLike {
  track: (name: string, data?: TrackData) => unknown;
}

declare global {
  interface Window {
    umami?: UmamiLike;
  }
}

export function track(
  name: string,
  data?: TrackData,
  target: { umami?: UmamiLike } | undefined = typeof window === "undefined"
    ? undefined
    : window,
): void {
  try {
    const umami = target?.umami;
    if (umami && typeof umami.track === "function") {
      void umami.track(name, data);
    }
  } catch {
    // A blocked or broken tag. The funnel loses one point, nothing else.
  }
}

// ------------------------------------------------------ first-run timing

const START_KEY = "pqp:onboarding-started-at-ms";
const DONE_KEY = "pqp:onboarded-at-ms";

function session(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function readMs(key: string): number | null {
  try {
    const raw = session()?.getItem(key);
    const value = raw ? Number(raw) : NaN;
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function writeMs(key: string, value: number): void {
  try {
    session()?.setItem(key, String(value));
  } catch {
    // Denied storage: the event still fires, without `seconds`.
  }
}

/**
 * `onboarding_start`, once per tab session, from whichever of the gate and
 * the wizard paints first. The time is kept so `onboarding_done` can say how
 * long the whole flow took.
 */
export function trackOnboardingStart(data: TrackData): void {
  if (readMs(START_KEY) !== null) {
    return;
  }
  writeMs(START_KEY, Date.now());
  track("onboarding_start", data);
}

/** Seconds since `onboarding_start`, or null when it was not recorded here. */
export function secondsSinceOnboardingStart(now = Date.now()): number | null {
  const started = readMs(START_KEY);
  return started === null ? null : Math.round((now - started) / 1000);
}

/** Mark the wizard finished, for the two "first thing they did" events. */
export function markOnboarded(now = Date.now()): void {
  writeMs(DONE_KEY, now);
}

/**
 * `arrival_first_message` / `arrival_first_voice`: fired at most once each,
 * and only for an account that finished the wizard in this tab.
 */
export function trackFirstAction(
  name: "arrival_first_message" | "arrival_first_voice",
  now = Date.now(),
): void {
  const done = readMs(DONE_KEY);
  if (done === null) {
    return;
  }
  const spentKey = `pqp:${name}`;
  try {
    const store = session();
    if (store?.getItem(spentKey)) {
      return;
    }
    store?.setItem(spentKey, "1");
  } catch {
    return;
  }
  track(name, { seconds: Math.round((now - done) / 1000) });
}
