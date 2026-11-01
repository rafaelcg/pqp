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
 * One behaviour hangs off the flag: the PHONE LAYOUT (a chat floor, the server
 * rail put away) is for every seatless viewer of a live party on the flagged
 * server. It is a layout, not a lesson, so it does not look at how old the
 * account is. The one-line "what is this" strip and the quiet from the app
 * invite that shared this flag were removed on 2026-11-01.
 *
 * No React and no `window`, so each rule is a plain function a test can call.
 */

/**
 * A pane narrower than this is a phone for layout purposes. The same 640 the
 * voice nudge uses for "desktop", and under `md` (768), which is where the
 * server rail's own responsive rules already change.
 */
export const PHONE_PANE_MAX_WIDTH_PX = 640;

export interface PartyNewcomerFacts {
  /** `LiveHlsConfig.newcomerExperience` for the open server. Absent is off. */
  flagOn: boolean | undefined;
  /** The open channel is a watch party that is on air. */
  partyLive: boolean;
  /** This person has no seat in the call: they are watching the picture. */
  audience: boolean;
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
