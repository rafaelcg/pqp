/**
 * One Google Ads conversion, reported once, for an account that was just made.
 *
 * WHY THIS EXISTS. Campaign 24158771481 ran 25 clicks and reported zero
 * conversions, because there were none to report: nothing on pqp.gg ever told
 * Google that anybody signed up. A campaign with no conversion signal can only
 * bid for clicks, which is what it was doing. This is the missing signal.
 *
 * WHAT COUNTS AS THE CONVERSION. An account being created. Not a sign-in, not a
 * page view, not a visit by somebody who already has an account. Those are all
 * true on every load forever after, and a conversion that fires on every session
 * is worse than no conversion at all: it is a number that grows with retention
 * and gets fed to a bidding algorithm as if it were growth.
 *
 * WHAT TELLS US IT IS NEW. Clerk stamps `user.createdAt` when the account is
 * made, and it is the only fact in reach that says "created" rather than
 * "present". The app's own signals are all near misses: `shouldRunOnboarding`
 * is true for anyone who abandoned the wizard weeks ago, `shouldShowFirstRun`
 * stays true until three tasks are done, and `takeAcquisition` only exists when
 * the visit carried campaign parameters. So the test is a window: an account
 * created within `NEW_ACCOUNT_WINDOW_MS` of now is one that was just created.
 *
 * THE TWO GUARDS, AND WHY BOTH. The window alone would fire on every reload
 * inside it, so a person who signs up and refreshes four times is four
 * conversions. A `localStorage` note alone would fire for a returning member on
 * a browser whose storage was cleared. Together, each covers the other's hole:
 *
 *  - The stored note kills repeats inside the window (reloads, StrictMode's
 *    double effect, a navigation back into `/app`).
 *  - The window kills everything outside it, which is what a cleared browser or
 *    a second device turns into. Clear your storage a week after signing up and
 *    the account is a week old, so nothing fires. That is the whole reason the
 *    window is short: it bounds the damage the storage guard cannot prevent.
 *
 * What is left is a genuine gap: signing up on a phone and signing in on a
 * laptop within half an hour would count twice. It is rare, it is bounded by
 * the window, and it is the cheaper error: the alternative (no window, trust
 * storage alone) miscounts every returning member on a fresh browser, which is
 * not rare at all.
 *
 * NOTHING HERE RUNS UNLESS THE TAG IS THERE. `send_to` is built from the same
 * two build vars that decide whether the tag is injected at all (see
 * `google-ads-tag.ts`), and `window.gtag` only exists because that tag defined
 * it. A self-hosted build has neither, so every function below is inert.
 */

/** The shape gtag presents once the injected snippet has run. */
export type Gtag = (...args: unknown[]) => void;

/**
 * Thirty minutes. Longer than any sign-up takes, including the 18+ gate and the
 * onboarding wizard, and short enough that a returning member almost never
 * falls inside it. See the guards note above for what the length is trading.
 */
export const NEW_ACCOUNT_WINDOW_MS = 30 * 60 * 1000;

/**
 * Which account's sign-up has already been reported from this browser.
 *
 * One value, not a list. A second brand-new account on the same device has a
 * different id, so it still reports; the first account cannot report twice
 * because by the time it could come back around it is outside the window.
 */
export const SIGNUP_REPORTED_KEY = "pqp:ads-signup-reported";

type WritableStorage = Pick<Storage, "getItem" | "setItem">;

/**
 * `AW-XXXXXXXXX/Label`, or null when this build carries no Google tag.
 *
 * Both halves are required: an id with no label addresses the account but no
 * conversion action, and Google silently drops the event.
 */
export function conversionSendTo(
  id: string | undefined,
  label: string | undefined,
): string | null {
  const trimmedId = id?.trim();
  const trimmedLabel = label?.trim();
  if (!trimmedId || !trimmedLabel) {
    return null;
  }
  return `${trimmedId}/${trimmedLabel}`;
}

/** What this build was configured with, which for a self-host is nothing. */
export function configuredSendTo(): string | null {
  return conversionSendTo(
    import.meta.env.VITE_GOOGLE_ADS_ID,
    import.meta.env.VITE_GOOGLE_ADS_SIGNUP_LABEL,
  );
}

/**
 * Was this account created just now?
 *
 * A missing date is "no", not "maybe": under the dev auth bypass there is no
 * Clerk user at all, and a build that cannot tell the age of an account must
 * not be guessing on a number an advertiser bids against.
 *
 * A creation date in the future is also "no". Clocks drift, and the only clock
 * involved here is the visitor's own.
 */
export function isNewAccount(
  createdAt: Date | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!createdAt) {
    return false;
  }
  const at = createdAt.getTime();
  if (!Number.isFinite(at) || at > now) {
    return false;
  }
  return now - at <= NEW_ACCOUNT_WINDOW_MS;
}

export interface SignupConversionInputs {
  /** Clerk's `user.createdAt`. */
  accountCreatedAt: Date | null | undefined;
  /** Clerk's `user.id`, so a second sign-up on this device is not swallowed. */
  userId: string | null | undefined;
  /** What `SIGNUP_REPORTED_KEY` currently holds. */
  lastReportedUserId: string | null;
  now?: number;
}

/** The decision, with no browser attached, so it can be tested as a table. */
export function shouldReportSignup({
  accountCreatedAt,
  userId,
  lastReportedUserId,
  now = Date.now(),
}: SignupConversionInputs): boolean {
  if (!userId) {
    return false;
  }
  if (lastReportedUserId === userId) {
    return false;
  }
  return isNewAccount(accountCreatedAt, now);
}

export interface ReportSignupDeps {
  accountCreatedAt: Date | null | undefined;
  userId: string | null | undefined;
  storage: WritableStorage | null;
  gtag: Gtag | undefined;
  sendTo?: string | null;
  now?: number;
}

/**
 * Report the sign-up, at most once, and say whether it did.
 *
 * The note is written *before* the event, not after. If the write throws
 * (storage denied, quota) the conversion is skipped entirely rather than sent
 * unguarded: a browser that cannot remember having reported would report on
 * every reload for the next half hour, and a missing conversion is a smaller
 * lie than a multiplied one.
 */
export function reportSignupConversion({
  accountCreatedAt,
  userId,
  storage,
  gtag,
  sendTo = configuredSendTo(),
  now = Date.now(),
}: ReportSignupDeps): boolean {
  if (!sendTo || typeof gtag !== "function") {
    return false;
  }
  let lastReportedUserId: string | null = null;
  try {
    lastReportedUserId = storage?.getItem(SIGNUP_REPORTED_KEY) ?? null;
  } catch {
    // Unreadable storage is the same as unwritable storage: bail below.
  }
  if (
    !userId ||
    !shouldReportSignup({ accountCreatedAt, userId, lastReportedUserId, now })
  ) {
    return false;
  }
  if (!storage) {
    return false;
  }
  try {
    storage.setItem(SIGNUP_REPORTED_KEY, userId);
  } catch {
    return false;
  }
  gtag("event", "conversion", { send_to: sendTo });
  return true;
}
