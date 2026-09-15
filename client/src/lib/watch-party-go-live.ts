/**
 * The decision behind `finishWatchPartyGoLiveShare` in App.tsx (Farol,
 * 2026-09-14, three rounds), pulled out pure and exported so the scenario
 * that prompted the third round — the disclosure sheet outliving the party
 * it was raised for — has an actual unit test rather than a source scan.
 * App.tsx is not mounted in this suite; this is.
 *
 * A go-live share can be asked for, then wait behind `HlsHostAckSheet`'s
 * disclosure notice for as long as the host takes to read and confirm it.
 * In that window the party can end on its own: the host closes it from
 * another tab, or the five-minute host-disconnect grace sweep times it out.
 * A confirmed share landing after that is not this function's problem — the
 * capture belongs to whoever owns it now — but arming a mic prompt for a
 * party that no longer exists, or exists as something other than `live`, is
 * a dialog with nothing sensible for the host to do with it.
 *
 * `party` is a fresh lookup (`watchParties.byChannel[channelId]`) at
 * completion time, never the snapshot the share was requested with: the
 * whole point is to catch the party having moved on since then. Matched on
 * `id` too, not only presence, because a channel that has since started a
 * DIFFERENT live party is exactly as wrong a target as an empty one.
 */
export type GoLiveMicPromptDecision =
  | { arm: true }
  | { arm: false; reason: "not-shared" | "party-gone" | "already-unmuted" };

export function decideGoLiveMicPrompt(input: {
  /** Whether the capture itself actually started. */
  wentOut: boolean;
  /** The party id this share was requested for. */
  requestedPartyId: string;
  /** A fresh lookup of that party's channel, or absent/moved on. */
  party: { id: string; state: string } | null | undefined;
  /** Whether the mic needs turning on at all. */
  isMuted: boolean;
}): GoLiveMicPromptDecision {
  if (!input.wentOut) {
    return { arm: false, reason: "not-shared" };
  }
  if (input.party?.id !== input.requestedPartyId || input.party.state !== "live") {
    return { arm: false, reason: "party-gone" };
  }
  if (!input.isMuted) {
    return { arm: false, reason: "already-unmuted" };
  }
  return { arm: true };
}
