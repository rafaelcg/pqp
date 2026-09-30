import { track, type TrackData } from "./track";

/**
 * Sign-up assist: measure the trip through the Clerk modal, and pick it back
 * up when a phone throws the page away while the person reads their mail.
 *
 * THE GAP THIS CLOSES. `users.created_at` starts after Clerk finishes, so the
 * time between "Entrar na comunidade" and an account has never been measured
 * anywhere (found in the 2026-09-29 retention review). And the one step that
 * is certainly slow on a phone, the emailed code, is also the one that sends
 * the person to another app. Two things can happen while they are away:
 *
 *  - The page survives. Clerk's modal is still open at the code screen and
 *    `forceRedirectUrl` carries the join on. Nothing to fix.
 *  - The page does not (an in-app browser or a tab evicted under memory
 *    pressure reloads on return). The modal is gone, the URL is the poster
 *    again, and the half-finished sign-up lives only in Clerk's client. The
 *    person sees a poster they already acted on and no sign of their code.
 *    `shouldResumeSignUp` says when to open the modal again, on the code step.
 *
 * FLAG. `signupAssistEnabled` gates the resume, the one visible change. The
 * timing events are not gated: they are inert unless the hosted Umami tag is
 * injected, they change nothing on screen, and the funnel is worth nothing if
 * it only exists on the days the flag is on. A signed-out visitor has no
 * runtime flag channel (every `/api` route wants a Bearer), so this is a build
 * flag plus a per-browser override for QA; the runtime kill switch for the
 * Twitch button itself is Clerk's dashboard toggle.
 *
 * Storage denied means nothing is recorded and nothing resumes, which is what
 * a page with no assist does today.
 */

export const SIGNUP_CTA_KEY = "pqp:signup-cta";
/** Longer than any sign-up, the same hour the join intent itself lives for. */
export const SIGNUP_CTA_TTL_MS = 60 * 60 * 1000;
export const SIGNUP_ASSIST_OVERRIDE_KEY = "pqp:signup-assist";

type ReadWriteStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function signupAssistEnabled(
  buildValue: string | undefined = import.meta.env.VITE_SIGNUP_ASSIST,
  storage: Pick<Storage, "getItem"> | null = safeLocalStorage(),
): boolean {
  let override: string | null = null;
  try {
    override = storage?.getItem(SIGNUP_ASSIST_OVERRIDE_KEY) ?? null;
  } catch {
    override = null;
  }
  if (override === "off") return false;
  if (override === "on") return true;
  return ["1", "true", "on"].includes((buildValue ?? "").trim().toLowerCase());
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export type WebviewKind =
  | "instagram"
  | "facebook"
  | "tiktok"
  | "line"
  | "android-webview"
  | "ios-webview";

/**
 * The in-app browsers that matter for a link posted on a social feed. Google
 * refuses OAuth inside an embedded webview (`disallowed_useragent`), so this
 * is also the list of places where the Google button cannot work and the
 * emailed code is the only way in. Custom Tabs and SFSafariViewController are
 * real browsers and report as Chrome and Safari; they are deliberately not
 * detected, because they do not have this problem.
 */
export function webviewKind(ua: string): WebviewKind | null {
  if (/Instagram/i.test(ua)) return "instagram";
  if (/FBAN|FBAV|FB_IAB/i.test(ua)) return "facebook";
  if (/musical_ly|BytedanceWebview|TikTok/i.test(ua)) return "tiktok";
  if (/\bLine\//i.test(ua)) return "line";
  if (/Android/i.test(ua) && /; wv\)/.test(ua)) return "android-webview";
  if (/iPhone|iPad|iPod/i.test(ua) && /AppleWebKit/i.test(ua) && !/Safari\//.test(ua)) {
    return "ios-webview";
  }
  return null;
}

function callerUa(): string {
  return typeof navigator === "undefined" ? "" : navigator.userAgent;
}

/** Bucket, not a number: Umami properties are grouped by exact value. */
export function secondsBucket(seconds: number): string {
  if (seconds < 15) return "<15s";
  if (seconds < 30) return "15-30s";
  if (seconds < 60) return "30-60s";
  if (seconds < 120) return "1-2m";
  if (seconds < 300) return "2-5m";
  return "5m+";
}

interface StoredCta {
  at: number;
  surface: string;
  /** The community slug the tap was for. Resume and redirect never leave it. */
  target: string;
}

export const SIGNUP_RETURN_LOCK_KEY = "pqp:signup-return-lock";
/** Long enough for every tab to boot, short enough to be gone by the next sign-up. */
export const SIGNUP_RETURN_LOCK_MS = 10_000;
/** Clerk stamps `createdAt` on its clock, the tap on ours. */
export const SIGNUP_CLOCK_SKEW_MS = 60_000;

/**
 * The tap on a sign-up button, before Clerk takes over. Kept in localStorage,
 * not sessionStorage: the reload this exists to survive is the one that would
 * lose it.
 */
export function noteSignupCta(
  surface: string,
  target: string,
  storage: ReadWriteStorage | null = safeLocalStorage(),
  now: number = Date.now(),
  ua: string = callerUa(),
): void {
  const data: TrackData = { surface };
  const webview = webviewKind(ua);
  if (webview) data.webview = webview;
  track("signup_cta_click", data);
  try {
    storage?.setItem(
      SIGNUP_CTA_KEY,
      JSON.stringify({ at: now, surface, target } satisfies StoredCta),
    );
  } catch {
    // Denied: the click is counted, the return will not have a time.
  }
}

function readCta(storage: Pick<Storage, "getItem"> | null, now: number): StoredCta | null {
  try {
    const raw = storage?.getItem(SIGNUP_CTA_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof (parsed as StoredCta).at !== "number" ||
      typeof (parsed as StoredCta).surface !== "string" ||
      typeof (parsed as StoredCta).target !== "string"
    ) {
      return null;
    }
    const cta = parsed as StoredCta;
    return now - cta.at > SIGNUP_CTA_TTL_MS || cta.at > now ? null : cta;
  } catch {
    return null;
  }
}

/** When Clerk says the signed-in account was created, in ms, or null. */
export function clerkAccountCreatedAtMs(): number | null {
  try {
    const created = (
      window as unknown as { Clerk?: { user?: { createdAt?: Date | number | null } | null } }
    ).Clerk?.user?.createdAt;
    const ms = created instanceof Date ? created.getTime() : created;
    return typeof ms === "number" && Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

/**
 * The account exists and the app is up: `signup_return`, with how long the
 * round trip took and where it started.
 *
 * COUNTED ONLY FOR A SIGN-UP THIS TAP CAUSED. A tap that was abandoned, then
 * an existing account signed in some other way inside the hour, would
 * otherwise read as a completed sign-up. So the account must have been created
 * at or after the tap (`accountCreatedAtMs`, from Clerk, with a minute of
 * clock skew allowed); an unknown creation time counts nothing. The record is
 * consumed either way. Returns the trip in seconds (5 s steps, at most 15
 * minutes) when it was counted, else null: the same number goes to the
 * account as `acquisition.signupSeconds`, so the two never disagree.
 *
 * COUNTED ONCE ACROSS TABS. Two tabs that boot together both read the record
 * before either removes it, so removing is not a claim. A short-lived lock key
 * is: the first tab to find it absent writes its own id and reads it back, and
 * only the tab that reads its own id counts. localStorage has no compare and
 * set, so a sub-millisecond double claim is still possible; that costs one
 * duplicate event, never a wrong one.
 */
export function noteSignupReturn(
  storage: ReadWriteStorage | null = safeLocalStorage(),
  now: number = Date.now(),
  ua: string = callerUa(),
  accountCreatedAtMs: number | null = clerkAccountCreatedAtMs(),
): number | null {
  const cta = readCta(storage, now);
  try {
    storage?.removeItem(SIGNUP_CTA_KEY);
  } catch {
    // Nothing to do about it.
  }
  if (!cta) return null;
  if (accountCreatedAtMs === null || accountCreatedAtMs < cta.at - SIGNUP_CLOCK_SKEW_MS) return null;
  if (!claimReturn(storage, now)) return null;
  const seconds = Math.round((now - cta.at) / 1000);
  const data: TrackData = {
    surface: cta.surface,
    seconds,
    bucket: secondsBucket(seconds),
  };
  const webview = webviewKind(ua);
  if (webview) data.webview = webview;
  track("signup_return", data);
  // What the ACQUISITION carries, rounded to 5 s. Past 15 minutes it was two
  // visits, and a duration spanning them measures the person's day, not the
  // modal, so the event above keeps it (its bucket says "5m+") and the
  // account's column does not.
  return seconds <= SIGNUP_DURATION_MAX_S ? Math.round(seconds / 5) * 5 : null;
}

/** The longest sign-up reported as a single trip. */
export const SIGNUP_DURATION_MAX_S = 15 * 60;

function claimReturn(storage: ReadWriteStorage | null, now: number): boolean {
  if (!storage) return false;
  try {
    const held = Number(storage.getItem(SIGNUP_RETURN_LOCK_KEY)?.split(":")[0]);
    if (Number.isFinite(held) && now - held < SIGNUP_RETURN_LOCK_MS) return false;
    const mine = `${now}:${Math.random().toString(36).slice(2)}`;
    storage.setItem(SIGNUP_RETURN_LOCK_KEY, mine);
    return storage.getItem(SIGNUP_RETURN_LOCK_KEY) === mine;
  } catch {
    return false;
  }
}

/** Whether Clerk holds a sign-up that is waiting on a code. */
export interface PendingSignUp {
  status?: string | null;
  unverifiedFields?: readonly string[] | null;
}

/**
 * Open the modal again? Only when ALL of these hold: the flag is on, this very
 * browser tapped the sign-up button for THIS community within the hour (a
 * pending sign-up started for community A must never finish into B) (so the
 * person asked for it and it is not a stranger's leftover), and Clerk has a
 * sign-up that is stuck at a verification step (so there is a code screen to
 * return to, rather than a blank form we would be pushing on somebody).
 */
export function shouldResumeSignUp(input: {
  enabled: boolean;
  surface: string;
  /** The community this page is for. Must be the one the tap was for. */
  target: string;
  signUp: PendingSignUp | null | undefined;
  storage: Pick<Storage, "getItem"> | null;
  now?: number;
}): boolean {
  if (!input.enabled) return false;
  const cta = readCta(input.storage, input.now ?? Date.now());
  if (!cta || cta.surface !== input.surface || cta.target !== input.target) return false;
  const signUp = input.signUp;
  if (!signUp || signUp.status !== "missing_requirements") return false;
  const unverified = signUp.unverifiedFields ?? [];
  return unverified.includes("email_address") || unverified.includes("phone_number");
}
