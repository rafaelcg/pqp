import {
  ageCheckToday,
  isAtLeastYearsOld,
  isPlausibleBirthDate,
  LIVE_PREVIEW_MEDIUM,
  parseCalendarDate,
} from "@pqp/shared";
import { peekAcquisition, stashAcquisition } from "./acquisition";
import type { LivePreviewStartResult } from "./api";
import { isDevAuthBypassEnabled } from "./dev-auth";

/**
 * THE SIGNED-OUT LIVE PREVIEW, client half ("prévia ao vivo").
 *
 * A visitor with no account opens a community's link (`/c/<slug>`) or one of
 * its invites while a watch party is live. They confirm their age on their
 * own device, watch the film for a few minutes, and are asked to create an
 * account to keep watching and to chat. After sign-up they land in that
 * community, in that channel (`stashLiveChannelIntent`).
 *
 * The server half (`server/src/services/live-preview.ts`) decides everything
 * that matters: whether the channel may be previewed at all, and when the
 * window ends. The token it hands out stops working at `expiresAt` whatever
 * this page does; the countdown here only says so out loud.
 *
 * This module is the pure part: the age verdict, what the visitor's device
 * remembers, the phase the panel is in, and the sign-up hand-off. The panel
 * (`components/live-preview/live-preview-panel.tsx`) draws it.
 */

// ------------------------------------------------------------------- age

export type PreviewAgeVerdict = "adult" | "minor" | "invalid";

/**
 * The account gate's own rule (`isAtLeastYearsOld` against
 * `MINIMUM_AGE_YEARS`, with the same generous "today"), run on the visitor's
 * device. The date is not sent and not stored: only the verdict is.
 */
export function judgePreviewAge(
  isoDate: string | null,
  now: Date = new Date(),
): PreviewAgeVerdict {
  const dob = isoDate ? parseCalendarDate(isoDate) : null;
  const today = ageCheckToday(now);
  if (!dob || !isPlausibleBirthDate(dob, today)) {
    return "invalid";
  }
  return isAtLeastYearsOld(dob, today) ? "adult" : "minor";
}

/** Tab-long: an adult is not asked again in the same tab. */
export const PREVIEW_AGE_OK_KEY = "pqp:live-preview-age-ok";
/**
 * Device-long, for a day: somebody who answered under the threshold is not
 * offered the date again straight away. The account gate's one-attempt rule,
 * kept loosely, because there is no account here to hold it.
 */
export const PREVIEW_AGE_DECLINED_KEY = "pqp:live-preview-age-declined";
export const PREVIEW_AGE_DECLINED_TTL_MS = 24 * 60 * 60 * 1000;

type ReadStorage = Pick<Storage, "getItem">;
type WriteStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type PreviewAgeMemory = "passed" | "declined" | null;

export function readPreviewAgeMemory(
  session: ReadStorage | null,
  local: ReadStorage | null,
  now: number = Date.now(),
): PreviewAgeMemory {
  try {
    const declinedAt = Number(local?.getItem(PREVIEW_AGE_DECLINED_KEY) ?? NaN);
    if (Number.isFinite(declinedAt) && now - declinedAt < PREVIEW_AGE_DECLINED_TTL_MS) {
      return "declined";
    }
    if (session?.getItem(PREVIEW_AGE_OK_KEY) === "1") {
      return "passed";
    }
  } catch {
    // Storage denied: ask again. Nothing plays without an answer.
  }
  return null;
}

export function rememberPreviewAge(
  verdict: "adult" | "minor",
  session: WriteStorage | null,
  local: WriteStorage | null,
  now: number = Date.now(),
): void {
  try {
    if (verdict === "adult") {
      session?.setItem(PREVIEW_AGE_OK_KEY, "1");
    } else {
      local?.setItem(PREVIEW_AGE_DECLINED_KEY, String(now));
    }
  } catch {
    // Denied storage forgets the answer, which only means asking again.
  }
}

// ---------------------------------------------------------------- ticket

/**
 * The window ticket the server hands back, kept per channel so a reload, a
 * new session on the same channel or a second tab continues the same window
 * instead of starting another. Kept past the window on purpose: presenting it
 * is how the server says "this visitor's preview is over". Dropped after a
 * day and an hour, by which time the server would issue a new one anyway.
 */
const TICKET_PREFIX = "pqp:live-preview-ticket:";
const TICKET_KEEP_MS = 25 * 60 * 60 * 1000;

export function readPreviewTicket(
  storage: ReadStorage | null,
  channelId: string,
  now: number = Date.now(),
): string | null {
  try {
    const raw = storage?.getItem(`${TICKET_PREFIX}${channelId}`);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as { ticket?: unknown; at?: unknown };
    if (typeof parsed.ticket !== "string" || typeof parsed.at !== "number") {
      return null;
    }
    return now - parsed.at > TICKET_KEEP_MS ? null : parsed.ticket;
  } catch {
    return null;
  }
}

export function writePreviewTicket(
  storage: WriteStorage | null,
  channelId: string,
  ticket: string,
  now: number = Date.now(),
): void {
  const key = `${TICKET_PREFIX}${channelId}`;
  try {
    // Keep the FIRST write's time: the ticket itself carries the window, and
    // this only decides when the stash is old enough to forget.
    const existing = storage?.getItem(key);
    const at =
      existing && (JSON.parse(existing) as { ticket?: unknown }).ticket === ticket
        ? (JSON.parse(existing) as { at?: number }).at ?? now
        : now;
    storage?.setItem(key, JSON.stringify({ ticket, at }));
  } catch {
    // Denied storage: the next start will ask for a new window, which the
    // server rate limits per address. The window itself is still enforced.
  }
}

// ----------------------------------------------------------------- phase

export type LivePreviewPhase =
  | { kind: "idle" }
  | { kind: "age" }
  | { kind: "declined" }
  | { kind: "starting" }
  | {
      kind: "watching";
      hlsUrl: string;
      mode: "conventional" | "ll";
      expiresAt: number;
    }
  | { kind: "ended" }
  | { kind: "gone" }
  | { kind: "error" };

/** What tapping "Assistir" leads to, from what this device remembers. */
export function phaseOnWatch(memory: PreviewAgeMemory): LivePreviewPhase {
  if (memory === "declined") {
    return { kind: "declined" };
  }
  return memory === "passed" ? { kind: "starting" } : { kind: "age" };
}

/** The phase a start answer puts the panel in. */
export function phaseAfterStart(
  result: LivePreviewStartResult,
  now: number = Date.now(),
): LivePreviewPhase {
  switch (result.kind) {
    case "ok":
      return result.body.expiresAt <= now
        ? { kind: "ended" }
        : {
            kind: "watching",
            hlsUrl: result.body.stream.hlsUrl,
            mode: result.body.stream.mode ?? "conventional",
            expiresAt: result.body.expiresAt,
          };
    case "ended":
      return { kind: "ended" };
    case "gone":
      return { kind: "gone" };
    default:
      return { kind: "error" };
  }
}

/** Whole seconds left, never negative. */
export function previewSecondsLeft(expiresAt: number, now: number = Date.now()): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 1000));
}

/** `4:05`. */
export function formatPreviewCountdown(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
}

// ------------------------------------------------------------------ page

/**
 * Whether the page around the player is drawn. Only the entry card shows
 * while idle; every other phase is the full live page (the age question and
 * the end are sheets over it).
 */
export function previewShowsPage(phase: LivePreviewPhase): boolean {
  return phase.kind !== "idle";
}

/**
 * Whether anything on screen may offer an account. Never to somebody who
 * answered under the threshold: the account gate's blocked screen never
 * suggests signing up again, and this keeps that rule for every button on
 * the page, the sticky bar and the header included.
 */
export function previewOffersSignUp(phase: LivePreviewPhase): boolean {
  return phase.kind !== "declined";
}

/** The countdown turns to the warning colour at this many seconds left. */
export const PREVIEW_URGENT_SECONDS = 30;

export function previewIsUrgent(secondsLeft: number): boolean {
  return secondsLeft <= PREVIEW_URGENT_SECONDS;
}

/**
 * How much of the window is left, 0 to 1, for the bar across the top of the
 * player. The window's length is the listing's `seconds`, so the bar is full
 * at the start of a fresh window and shorter on a resumed one.
 */
export function previewRemainingFraction(
  expiresAt: number,
  windowSeconds: number,
  now: number = Date.now(),
): number {
  if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) {
    return 0;
  }
  const left = (expiresAt - now) / (windowSeconds * 1000);
  return Math.min(1, Math.max(0, left));
}

/** The window in whole minutes, for "Prévia de N minutos". Never below one. */
export function previewWindowMinutes(seconds: number): number {
  return Math.max(1, Math.round(seconds / 60));
}

/**
 * The viewer count to draw, or null to draw none. Zero is not shown: "0
 * assistindo" on a live party says something false about the room (the
 * count is accounts only, and a party with only seated people or only
 * preview visitors can read zero).
 */
export function previewViewerCount(channel: { viewers?: number } | null): number | null {
  const viewers = channel?.viewers;
  return typeof viewers === "number" && Number.isFinite(viewers) && viewers > 0
    ? Math.floor(viewers)
    : null;
}

export type ShareOutcome = "shared" | "copied" | "cancelled" | "failed";

type ShareNavigator = {
  share?: (data: { url: string; title?: string }) => Promise<void>;
  clipboard?: { writeText: (text: string) => Promise<void> };
};

/**
 * The Share button: the system share sheet where there is one (phones, the
 * in-app browsers), copying the link otherwise. A sheet the person closed is
 * "cancelled", not a reason to copy behind their back.
 */
export async function shareLink(
  url: string,
  title: string,
  nav: ShareNavigator | null = typeof navigator === "undefined" ? null : navigator,
): Promise<ShareOutcome> {
  if (nav?.share) {
    try {
      await nav.share({ url, title });
      return "shared";
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return "cancelled";
      }
      // A share sheet that refuses (an embedded webview without one) falls
      // through to copying.
    }
  }
  if (nav?.clipboard) {
    try {
      await nav.clipboard.writeText(url);
      return "copied";
    } catch {
      return "failed";
    }
  }
  return "failed";
}

// --------------------------------------------------------------- sign-up

/**
 * First-touch attribution for an account that came out of a preview:
 * `medium: live_preview`, keeping the referring site a plain visit already
 * recorded. `stashAcquisition` still lets a real campaign (a `utm_*` link the
 * visitor arrived on) win, because that is the link that found them.
 */
export function stashLivePreviewAcquisition(
  storage: WriteStorage | null,
  landing: string,
  now: number = Date.now(),
): void {
  const existing = peekAcquisition(storage, now);
  stashAcquisition(
    storage,
    {
      ...(existing?.source ? { source: existing.source } : {}),
      medium: LIVE_PREVIEW_MEDIUM,
      landing,
    },
    now,
  );
}

// ------------------------------------------------------------------- dev

/**
 * DEV ONLY. The dev auth bypass signs every browser in, so a signed-out page
 * cannot be seen locally. With `localStorage["pqp:dev-signed-out"] = "1"` the
 * community page draws its signed-out half anyway, preview included. Gated on
 * `import.meta.env.DEV` AND the bypass, so a production build compiles it to
 * false and no stored value can turn it on there.
 */
export const DEV_SIGNED_OUT_KEY = "pqp:dev-signed-out";

export function devSignedOutPreview(storage: ReadStorage | null = safeLocal()): boolean {
  if (!import.meta.env.DEV || !isDevAuthBypassEnabled()) {
    return false;
  }
  try {
    return storage?.getItem(DEV_SIGNED_OUT_KEY) === "1";
  } catch {
    return false;
  }
}

export function safeLocal(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function safeSession(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}
