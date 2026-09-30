import { browserStorage } from "./arrival";

/**
 * THE NEWCOMER'S FIRST MINUTES IN A LIVE WATCH PARTY, as pure rules.
 *
 * Everything behind the runtime flag `party_newcomer_experience`
 * (`server/src/lib/flags.ts`, answered per server by
 * `GET /api/live-hls/config?serverId=` as `newcomerExperience`). Why: the
 * 2026-09-29 signup retention report. Accounts created during a show stayed a
 * median of 4 minutes, 65% of them on a phone, where the film was all there
 * was and the room was a swipe nobody told them about.
 *
 * Three behaviours hang off one flag, and this file is the only place that
 * decides who gets which:
 *
 *  - the PHONE LAYOUT (a chat floor, the server rail put away) is for every
 *    seatless viewer of a live party on the flagged server. It is a layout,
 *    not a lesson, so it does not look at how old the account is;
 *  - the CONTEXT STRIP and the QUIET FROM THE APP INVITE are for a newcomer:
 *    an account that finished first-run recently.
 *
 * No React and no `window`, so each rule is a plain function a test can call.
 */

/** How long an account counts as new. A show and the next morning. */
export const NEWCOMER_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Remembered once the strip is closed. Per browser, like every campaign card. */
export const PARTY_NEWCOMER_STRIP_STORAGE_KEY = "pqp:party-newcomer-strip-2026-09";

/**
 * A pane narrower than this is a phone for layout purposes. The same 640 the
 * voice nudge uses for "desktop", and under `md` (768), which is where the
 * server rail's own responsive rules already change.
 */
export const PHONE_PANE_MAX_WIDTH_PX = 640;

/**
 * Whether the account finished first-run within the window.
 *
 * `preferences.onboardedAt` is the signal because it is the one instant the
 * client already holds for an account: written when the wizard finishes or is
 * skipped, and backfilled once, in August 2026, for accounts that predate it
 * (so a regular is never mistaken for a newcomer). There is no `createdAt` on
 * the user the client receives. Absent, unparseable, or in the future (a wrong
 * device clock) all read as "not new": failing quiet costs a missing strip,
 * failing loud puts a beginner's strip over a regular's film.
 */
export function isNewcomerAccount(
  onboardedAt: string | null | undefined,
  now: number = Date.now(),
  windowMs: number = NEWCOMER_WINDOW_MS,
): boolean {
  if (!onboardedAt) {
    return false;
  }
  const at = Date.parse(onboardedAt);
  if (!Number.isFinite(at)) {
    return false;
  }
  const age = now - at;
  // A minute of slack for a device clock a little behind the server's.
  return age >= -60_000 && age < windowMs;
}

export function isPartyNewcomerStripDismissed(
  storage: Pick<Storage, "getItem"> | null = browserStorage(),
): boolean {
  try {
    return storage?.getItem(PARTY_NEWCOMER_STRIP_STORAGE_KEY) === "1";
  } catch {
    // Unreadable storage shows the strip: the session state in the component
    // still lets the person close it, and it is one line.
    return false;
  }
}

export function dismissPartyNewcomerStrip(
  storage: Pick<Storage, "setItem"> | null = browserStorage(),
): void {
  try {
    storage?.setItem(PARTY_NEWCOMER_STRIP_STORAGE_KEY, "1");
  } catch {
    // Session-only hide lives in the component that called this.
  }
}

export interface PartyNewcomerFacts {
  /** `LiveHlsConfig.newcomerExperience` for the open server. Absent is off. */
  flagOn: boolean | undefined;
  /** The open channel is a watch party that is on air. */
  partyLive: boolean;
  /** This person has no seat in the call: they are watching the picture. */
  audience: boolean;
  /** `isNewcomerAccount(...)`. */
  newcomer: boolean;
  /** The strip was closed on this device (or this session). */
  dismissed: boolean;
}

/**
 * The phone layout: chat floor and the rail put away. Every viewer of a live
 * party on a flagged server; the narrow-viewport half is decided where the
 * width is known (CSS for the rail, the pane's measured width for the split).
 */
export function partyPhoneLayoutOn(
  facts: Pick<PartyNewcomerFacts, "flagOn" | "partyLive" | "audience">,
): boolean {
  return facts.flagOn === true && facts.partyLive && facts.audience;
}

/** The one-line "what is this" strip. */
export function partyNewcomerStripVisible(facts: PartyNewcomerFacts): boolean {
  return (
    facts.flagOn === true &&
    facts.partyLive &&
    facts.audience &&
    facts.newcomer &&
    !facts.dismissed
  );
}

/**
 * The "get the app" strip under the channel list is furniture for everybody
 * else and a way out of the page for somebody who arrived ten minutes ago from
 * a stream. Held back only for a newcomer, only while the party is on air.
 */
export function suppressAppInviteForNewcomer(
  facts: Pick<PartyNewcomerFacts, "flagOn" | "partyLive" | "newcomer">,
): boolean {
  return facts.flagOn === true && facts.partyLive && facts.newcomer;
}

/**
 * How tall the stage is on a phone while the chat is guaranteed a floor.
 *
 * `container` is the pane's height, `width` its width. The picture only ever
 * needs a 16:9 box across the pane plus a little for its own controls; the
 * `68svh` rule gave it more than that and the transcript the sliver left over.
 * So the stage takes what the picture can use, capped so the chat keeps at
 * least `PHONE_CHAT_FLOOR_SHARE` of the pane, and the chat gets everything
 * else. The result is a target the caller still runs through `clampSplit`, so
 * the ordinary minimums bound it the way they bound a drag.
 */
export const PHONE_CHAT_FLOOR_SHARE = 0.38;
export const PHONE_STAGE_EXTRA_PX = 48;
/** What the short-pane fallback reserves for the chat before the stage may grow. */
export const PHONE_SHORT_CHAT_RESERVE_PX = 160;

/**
 * The stage on a pane too short for a divider: under half, and never more than
 * what is left after reserving the chat's share. On a very short pane the stage
 * shrinks toward nothing before the chat does.
 */
export function phoneShortStageHeight(container: number): number {
  return Math.max(
    0,
    Math.min(
      Math.round(container * 0.45),
      container - PHONE_SHORT_CHAT_RESERVE_PX,
    ),
  );
}

export function phoneStageTarget(
  container: number,
  width: number,
  chatMinPx: number,
  dividerPx: number,
): number {
  const picture = Math.round((width * 9) / 16) + PHONE_STAGE_EXTRA_PX;
  const chat = Math.max(chatMinPx, Math.round(container * PHONE_CHAT_FLOOR_SHARE));
  const ceiling = container - dividerPx - chat;
  return Math.min(picture, ceiling);
}
