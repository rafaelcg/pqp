import type { Channel, WatchParty } from "@pqp/shared";

/**
 * Where somebody who has just JOINED a server should land when a watch
 * party is on air there: the party, not the server's front page.
 *
 * WHY THIS EXISTS. MoonKase's party on 2026-09-26: 93 accounts were created
 * mid-show from the community's link (`/c/<slug>`, `?join=`), and every one
 * of the newcomer sessions that ever reached the party went through the
 * server's Overview first, spending a median 45 s (up to two minutes) finding
 * it. The Overview's start cards and the arrival banner point at `#general`
 * and the voice lobby; the party was one row in a channel list that a phone
 * keeps behind a menu. Accounts created during the show watched a median of
 * 4 minutes against 90 for everybody else. Somebody who clicked a streamer's
 * link while the film is running came for the film.
 *
 * Only a party that is LIVE and whose channel this person can see (it is in
 * the list the API returned for them) qualifies; a scheduled or ended party
 * is not a reason to skip the front page. With two on air, the one that went
 * live most recently wins, the same order the sidebar's live block uses.
 */
export function pickLivePartyChannel(
  parties: readonly Pick<WatchParty, "channelId" | "state" | "wentLiveAt">[],
  channels: readonly Pick<Channel, "id">[],
): string | null {
  const visible = new Set(channels.map((channel) => channel.id));
  const live = parties
    .filter((party) => party.state === "live" && visible.has(party.channelId))
    .sort((a, b) => (b.wentLiveAt ?? "").localeCompare(a.wentLiveAt ?? ""));
  return live[0]?.channelId ?? null;
}
