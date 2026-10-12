/**
 * "Aparecer no diretório": the one-time card that asks the owner of a room
 * with a public address whether it should be in the communities directory
 * too. `components/communities/listing-nudge-hint.tsx` draws it; this module
 * holds the two decisions worth testing without a DOM.
 *
 * WHO. The server decides (`GET /api/communities/listing-nudge`,
 * `findListingNudge`): the owner, of an addressed, unlisted, unsuspended room
 * that passes the directory's quality bar, so the card never invites an empty
 * shell. Behind the runtime flag `community_listing_nudge` (default on), which
 * answers `null` when off.
 *
 * ONCE. A preference, not localStorage: the question is about the account
 * and must not come back on the next device. `communityListingNudgeAt` is
 * stamped when the card paints (an impression, the same rule as the QG card),
 * and the server reads it too, so a second browser never even gets a
 * candidate. Answering, "Agora não", the X and Escape all just close it.
 */

/** Whether to ask the server for a candidate at all. */
export function shouldFetchListingNudge(input: {
  /** `GET /api/communities/config` answered `enabled: true`. */
  communitiesEnabled: boolean;
  /** Signed in, the age gate passed (every `/api` route is 403 before). */
  ready: boolean;
  /** `preferences.communityListingNudgeAt` is set. */
  seen: boolean;
  /** Playwright and friends get no campaign cards (`lib/hints.ts`). */
  automated: boolean;
}): boolean {
  return (
    input.communitiesEnabled && input.ready && !input.seen && !input.automated
  );
}

/**
 * Whether the card wants the corner. The queue in `lib/corner-hints.ts`
 * decides whether it gets it; a live party or the watch-now strip holds every
 * campaign back (`campaignsYield` in `App`).
 */
export function wantsListingNudge(input: {
  hasCandidate: boolean;
  closed: boolean;
  campaignsYield: boolean;
}): boolean {
  return input.hasCandidate && !input.closed && !input.campaignsYield;
}

/** The preference patch written the first time the card paints. */
export function listingNudgeSeenPatch(
  now: Date = new Date(),
): { communityListingNudgeAt: string } {
  return { communityListingNudgeAt: now.toISOString() };
}
