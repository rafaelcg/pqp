import type { JamTakeNotice } from "@pqp/shared";

/**
 * Where a Jam notice may be drawn, and which one, so that it never covers the
 * controls it would be interrupting.
 *
 * User test round 3 (N-1): after two "entrou" notices, a Jam card and the
 * first-run card, the notices followed a returning visitor onto the song and the
 * recorder and sat over the red record button on a 390 px phone until she
 * closed them. Three rules, all pure so they can be tested:
 *
 *  1. ONE AT A TIME. The toast ("Chegou uma parte") is the moment and the cards
 *     are the durable list: a toast up holds the cards back, and of the cards
 *     only the first is drawn, with a count of how many wait behind it. They are
 *     the onboarding queue's rule (`lib/corner-hints.ts`), applied to the Jam's
 *     own notices.
 *  2. NEVER OVER A TRANSPORT. The studio and a song's panel are where play,
 *     record and share are. With the studio open nothing is drawn (it waits,
 *     the cards are durable and the toast keeps its place). Over a public view
 *     the card is drawn IN the flow of the view, above the song, so it pushes
 *     the song down instead of covering it. Over a channel's own song panel
 *     (the Jam wall) it waits too: that panel has no slot.
 *  3. THE CORNER YIELDS. While a notice is up, no corner card is (`JamHintContext.notice`).
 */

export type JamNoticePlacement = "overlay" | "inline" | "hold";

export function jamNoticePlacement(context: {
  /** The studio is open (anywhere). */
  studio: boolean;
  /** A song's panel is open. */
  song: boolean;
  /** The public view of a song is open (`/app/jam/<id>`), which has a slot for it. */
  view: boolean;
}): JamNoticePlacement {
  if (context.studio) {
    return "hold";
  }
  if (context.view) {
    return "inline";
  }
  return context.song ? "hold" : "overlay";
}

export interface JamNoticeQueue {
  /** Draw the toast. */
  toast: boolean;
  /** The one card to draw, if any, and how many more are waiting behind it. */
  card: JamTakeNotice | null;
  more: number;
}

/** What is drawn now, given what is waiting. A toast first, then the newest card. */
export function jamNoticeQueue(
  notices: readonly JamTakeNotice[],
  toastWaiting: boolean,
  placement: JamNoticePlacement,
): JamNoticeQueue {
  if (placement === "hold") {
    return { toast: false, card: null, more: 0 };
  }
  // The toast has no slot inside a view: it waits for the view to close.
  if (toastWaiting && placement === "overlay") {
    return { toast: true, card: null, more: 0 };
  }
  const [card = null, ...rest] = notices;
  return { toast: false, card, more: rest.length };
}
