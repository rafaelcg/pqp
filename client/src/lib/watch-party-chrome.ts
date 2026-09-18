import type { WatchPartyPhase } from "@pqp/shared";

/**
 * DOES THE PARTY OWN THIS CHANNEL'S CHROME?
 *
 * ONE PREDICATE, BECAUSE TWO OF THEM COST A LIVE SHOW (2026-09-18, 20:57
 * UTC). PR 711 put the watch party's controls on one bar drawn over the
 * bottom edge of the picture and raised `CallStage`'s own control bar to the
 * same rung of `STAGE_LAYER` so the two would not fight. It guarded the
 * collision with `watchPartyChrome`, which asks `party.state === "live"`, and
 * drew the bar itself behind `partyOwnsHeader`, which asks what
 * `watchPartySurface` asks: live, OR scheduled with a stream. Those are not
 * the same question, and the gap between them is a real state — a host who
 * shares while the party row still reads `scheduled`, which is also the
 * window between the `channel-live` frame and the `watch-party-update` that
 * says the show started, since those are two independent frames.
 *
 * In that state the party bar is drawn AND `CallStage` keeps its own control
 * bar: same `absolute inset-x-0 bottom-0`, same `z-50`, same containing
 * stacking context, and later in document order, so the call bar paints on
 * top — opaque gradient, whole box hit-testable, with the red hang-up at the
 * right-hand end. A host aiming for Camera or Parar or the mixer on the bar
 * they can see presses `voice.leave()` instead, and the broadcast ends with
 * the client reporting nothing except that it left. It happened twice in
 * four minutes on pqp.gg, and the host did not know he had done it.
 *
 * So the question is asked once, here, and both gates read the answer. A
 * bar over a picture and the decision to stand down for it are one fact.
 */
export function partyOwnsChannelChrome(input: {
  /** The party on this channel as this person may see it, or none. */
  state: WatchPartyPhase | null | undefined;
  /** A playable stream exists for this channel. */
  hasStream: boolean;
}): boolean {
  if (!input.state) {
    return false;
  }
  // Same two branches as `watchPartySurface`'s "live": a stream on a channel
  // whose party has not started is still a channel that is live.
  return (
    input.state === "live" || (input.state === "scheduled" && input.hasStream)
  );
}
