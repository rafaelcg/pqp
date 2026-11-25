import { isHintSeen, rememberHint } from "@/lib/hints";

/**
 * "A Jam abriu": one corner card per browser, telling people already on pqp
 * that public jams exist, one tap from hearing one.
 *
 * Behind the runtime flag `jam_announcement` (GLOBAL, default off), served as
 * `announce` on the signed-in `GET /api/jam-public/config` and only ever true
 * while `jam_public` is on too (`server/src/lib/jam-public-config.ts`). It is
 * the second step of the launch: `jam_public` goes on first and is watched,
 * this goes on a day or two later. Off, nothing is drawn and nothing stored.
 *
 * WHO. Anybody signed in, wherever they are: public jams belong to no server,
 * so unlike "O fórum abriu" the card is not about the server on screen.
 *
 * WHEN. A campaign card in the corner queue (`jamNews` in `CORNER_HINT_ORDER`),
 * and on top of the queue's own rules (`hint_budget`) it never shows in a call,
 * while sharing or watching a share, in a running app, or over a live party or
 * the watch-now strip. Nor while the arrival strip is up for somebody who just
 * joined (one instruction for one screen), nor before the top-song lookup has
 * answered: the primary button's label depends on it ("Ouvir uma jam" or, with
 * nothing public yet, "Começar uma jam"), and a card must not paint one label
 * and swap it. Typing only holds its ENTRANCE.
 *
 * ONCE. Both buttons, the X and Escape stamp it, and so does opening a jam by
 * any route (a jam channel, a public jam, the directory's door): somebody who
 * found Jam has nothing left to be told. Painting is not an impression; a card
 * that yielded to a call comes back when the call ends. Per browser, through
 * `lib/hints.ts`, like every campaign card.
 */
export const JAM_ANNOUNCEMENT_KEY = "pqp:jam-announcement-2026-11";

/**
 * Closed in this page load. `lib/hints.ts` remembers nothing on localhost, and
 * a card the person just closed must not come straight back on the next render.
 */
let closedThisLoad = false;

export function isJamAnnouncementSeen(
  storage?: Pick<Storage, "getItem"> | null,
  persist?: boolean,
): boolean {
  return closedThisLoad || isHintSeen(JAM_ANNOUNCEMENT_KEY, storage, persist);
}

export function rememberJamAnnouncement(
  storage?: Pick<Storage, "setItem"> | null,
  persist?: boolean,
): void {
  closedThisLoad = true;
  rememberHint(JAM_ANNOUNCEMENT_KEY, storage, persist);
}

export interface JamAnnouncementFacts {
  /** `announce` on the jam-public config (already beside `jam_public`). */
  announce: boolean;
  /** The top-song lookup answered (a song, or none). A failed ask is not an answer. */
  topReady: boolean;
  /** Stamped on this device or in this load. */
  seen: boolean;
  /** Already in Jam: a jam channel or a public jam is open. */
  inJam: boolean;
  /** Playwright or another driver: never a card. */
  automated: boolean;
  /** Voice is not idle: connecting, connected, reconnecting. */
  inCall: boolean;
  /** Presenting a screen, or somebody else's share is on the stage. */
  sharing: boolean;
  /** Seated in a live app or game session. */
  appRunning: boolean;
  /** A live party or the watch-now strip owns the moment (`campaignsYield`). */
  campaignsYield: boolean;
  /** The arrival strip is up for the open server (joined this session). */
  arriving: boolean;
  /** The composer has focus or holds a draft. */
  typing: boolean;
  /** The card is on screen already; typing does not take it away. */
  showing: boolean;
}

/** Whether the card wants the corner. */
export function jamAnnouncementWanted(facts: JamAnnouncementFacts): boolean {
  if (
    !facts.announce ||
    !facts.topReady ||
    facts.seen ||
    facts.inJam ||
    facts.automated ||
    facts.inCall ||
    facts.sharing ||
    facts.appRunning ||
    facts.campaignsYield ||
    facts.arriving
  ) {
    return false;
  }
  return !(facts.typing && !facts.showing);
}

/** Test seam. */
export function resetJamAnnouncementForTests(): void {
  closedThisLoad = false;
}
