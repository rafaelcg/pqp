import { isHintSeen, rememberHint } from "@/lib/hints";

/**
 * "O fórum abriu": one corner card per person per server, telling the members
 * of a server whose forum just went live that it exists, one tap from it.
 *
 * Behind the runtime flag `forum_announcement` (per server, default off),
 * served as `announce` on `GET /api/forum/config?serverId=`, which the server
 * only ever answers yes to where `forum_channels` is on too. Off, nothing is
 * drawn and nothing is stored.
 *
 * WHO. A member of the open server (it is in the account's own server list)
 * who can see a forum channel there and is not looking at it right now. The
 * card is about the server on screen, so a person in the QG who is busy in
 * another server is not pulled away from it.
 *
 * WHEN. It is a campaign card in the corner queue (`forumNews` in
 * `CORNER_HINT_ORDER`), and on top of the queue's own rules it never shows in
 * a call, while sharing or watching a share, in a running app, or over a live
 * party, whatever `hint_budget` says: the announcement is the kind of thing
 * that must not interrupt. Typing (the composer focused or holding a draft)
 * only holds its ENTRANCE: once it is up, clicking into the composer does not
 * pull it away, or it would blink out under the cursor.
 *
 * ONCE. "Abrir o fórum", "Agora não", the X and Escape each stamp it for that
 * server, and so does opening the forum channel by any route (the channel
 * list, a link): somebody who found the forum has nothing left to be told.
 * Painting is not an impression; a card that was up and then yielded to a
 * call comes back when the call ends. Per browser, through `lib/hints.ts`,
 * like every campaign card (`docs/ONBOARDING.md` §"Preference vs.
 * localStorage"): a second device may show it once more.
 */
export const FORUM_ANNOUNCEMENT_KEY_PREFIX = "pqp:forum-announcement-2026-10:";

export function forumAnnouncementKey(serverId: string): string {
  return `${FORUM_ANNOUNCEMENT_KEY_PREFIX}${serverId}`;
}

/**
 * Closed in this page load. `lib/hints.ts` remembers nothing on localhost, and
 * a card the person just closed must not come straight back on the next render.
 */
const closedThisLoad = new Set<string>();

export function isForumAnnouncementSeen(
  serverId: string,
  storage?: Pick<Storage, "getItem"> | null,
  persist?: boolean,
): boolean {
  return (
    closedThisLoad.has(serverId) ||
    isHintSeen(forumAnnouncementKey(serverId), storage, persist)
  );
}

export function rememberForumAnnouncement(
  serverId: string,
  storage?: Pick<Storage, "setItem"> | null,
  persist?: boolean,
): void {
  closedThisLoad.add(serverId);
  rememberHint(forumAnnouncementKey(serverId), storage, persist);
}

export interface ForumAnnouncementFacts {
  /** `announce` on the open server's forum config. */
  announce: boolean;
  /** The open server is one of the account's own servers. */
  member: boolean;
  /** The first forum channel the person can see in the open server, if any. */
  forumChannelId: string | null;
  /** The open channel is a forum (this one or another). */
  viewingForum: boolean;
  /** Stamped for this server, on this device or in this load. */
  seen: boolean;
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
  /** The composer has focus or holds a draft. */
  typing: boolean;
  /** The card is on screen already; typing does not take it away. */
  showing: boolean;
}

/** The forum channel to offer, or null when the card must not want the corner. */
export function forumAnnouncementTarget(facts: ForumAnnouncementFacts): string | null {
  if (
    !facts.announce ||
    !facts.member ||
    facts.forumChannelId === null ||
    facts.viewingForum ||
    facts.seen ||
    facts.automated ||
    facts.inCall ||
    facts.sharing ||
    facts.appRunning ||
    facts.campaignsYield
  ) {
    return null;
  }
  if (facts.typing && !facts.showing) {
    return null;
  }
  return facts.forumChannelId;
}

/** Test seam. */
export function resetForumAnnouncementForTests(): void {
  closedThisLoad.clear();
}
