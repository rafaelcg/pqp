/**
 * The Android closed beta: the two links that get somebody into it, and the
 * once-per-session prompt that announces it.
 *
 * WHY THESE ARE ENV VARS AND NOT CONSTANTS, unlike `testflight.ts`.
 * A TestFlight join link is public and self-serve — anybody with the URL is in,
 * so hardcoding the current one costs nothing and works on every copy of the
 * site. A Play **closed** track is neither. It can be closed, re-made, or
 * swapped for an open track, the tester intake can change shape, and this whole
 * surface had to be able to ship and deploy before any of that existed. So both
 * links are build-time variables with no fallback: unset means "we have nothing
 * to send you to yet", and every surface has to render something honest for
 * that case rather than a button that goes nowhere.
 *
 * WHY TWO LINKS, AND WHY THEY ARE ONE GATE. Getting in takes two steps in a
 * fixed order: join the public Google Group, which is what puts your Google
 * account on the tester list, and *then* open the Play opt-in URL. Doing the
 * second first lands you on a Google page that does nothing, from which the
 * only available conclusion is that the app is broken. A build that has one URL
 * and not the other can therefore only offer half a flow, so `androidBetaLinks`
 * answers all-or-nothing and the surfaces never have to model a half state.
 *
 * Runbook: `docs/ANDROID_RELEASE.md` §4.
 */

/** Where somebody writes when there is no track to point them at yet. */
export const ANDROID_BETA_CONTACT_EMAIL = "contato@pqp.gg";

export interface AndroidBetaLinks {
  /** Step 1: the public Google Group that is the tester list. */
  groupUrl: string;
  /** Step 2: `https://play.google.com/apps/testing/<applicationId>`. */
  optInUrl: string;
}

/**
 * Both links, or `null` when this build cannot offer the whole flow.
 *
 * Trimmed because a value set from CI can arrive with a trailing newline, and
 * because a whitespace-only value is how you blank one without a code change.
 */
export function androidBetaLinks(): AndroidBetaLinks | null {
  const groupUrl = readEnvUrl(import.meta.env.VITE_ANDROID_BETA_GROUP_URL);
  const optInUrl = readEnvUrl(import.meta.env.VITE_ANDROID_BETA_URL);
  if (!groupUrl || !optInUrl) {
    return null;
  }
  return { groupUrl, optInUrl };
}

function readEnvUrl(raw: unknown): string | null {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed || null;
}

/**
 * Remembered for one browsing session, not for ever.
 *
 * `sessionStorage`, deliberately, and it is the one difference from
 * `download-hint.ts` worth stating: the download hint is a permanent preference
 * ("I do not want the desktop app"), while this is a campaign announcement.
 * Nobody should have to see it twice in an afternoon, and nobody should be shut
 * out of it for ever by one stray click on a shared machine. A new tab is a new
 * session, which is the right granularity for something this small.
 */
export const ANDROID_BETA_PROMPT_STORAGE_KEY = "pqp:android-beta-prompt";

/** The browser's per-tab store, or null where there is not one to use. */
export function sessionBrowserStorage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Has this session already been shown the prompt?
 *
 * Missing or hostile storage answers `true` — the opposite of
 * `isDownloadHintDismissed`, and on purpose. A hint that returns is a reminder;
 * an unsolicited popup that returns on every navigation is spam, and Safari's
 * private mode would produce exactly that. Failing towards silence costs one
 * impression and cannot annoy anyone.
 */
export function isAndroidBetaPromptSeen(
  storage: Pick<Storage, "getItem"> | null = sessionBrowserStorage(),
): boolean {
  if (!storage) {
    return true;
  }
  try {
    return storage.getItem(ANDROID_BETA_PROMPT_STORAGE_KEY) === "1";
  } catch {
    return true;
  }
}

/**
 * Record the impression. Written when the prompt is *shown*, not when it is
 * dismissed: a person who scrolls past it and navigates has still seen it, and
 * re-showing it because they did not press the X is the behaviour this key
 * exists to prevent.
 */
export function rememberAndroidBetaPrompt(
  storage: Pick<Storage, "setItem"> | null = sessionBrowserStorage(),
): void {
  try {
    storage?.setItem(ANDROID_BETA_PROMPT_STORAGE_KEY, "1");
  } catch {
    // Quota or a denied store. The component keeps its own React state for this
    // session, so the worst case is the prompt returning on a full reload.
  }
}
