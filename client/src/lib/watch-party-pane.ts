import { watchPartySurface, type WatchPartyPhase } from "@pqp/shared";

/**
 * ONE SURFACE OWNS THE CHANNEL PANE, and this says which.
 *
 * THE BUG THIS EXISTS FOR (2026-09-18). A watch party channel mounts three
 * stages into the same slot: `WatchPartyPanel`'s own surface, the seatless
 * `WatchChannelStage`, and `VoiceChannelStage`. Two of them asked disjoint
 * questions and so could both answer yes. `WatchPartyPanel` asked
 * `watchPartySurface` — "what is this party, to this person" — while
 * `WatchChannelStage` asked only "is there a playlist on this channel and am
 * I out of the call", which knows nothing about the party and nothing about
 * who is looking. So a host who pressed Criar watch party on a channel that
 * still had a stream going out — the second party of the night while the
 * previous egress was finishing, a share that outlived the party it belonged
 * to, a co-host still presenting — got their private setup surface rendered
 * into a pane the audience player had already filled. The host asked to start
 * a party and was shown the viewer's screen.
 *
 * THE RULE. When the party's own surface fills the pane for this person, the
 * seatless audience stage stands down. It is the party's pane: a draft, a
 * scheduled card and a holding screen are all things this person is being
 * shown ABOUT their party, and none of them is improved by a picture drawn
 * over them by a component that does not know the party exists.
 *
 * DERIVED FROM `watchPartySurface`, NOT FROM A SECOND COPY OF ITS RULES. That
 * function is the one place the empty/setup/scheduled/live decision is made
 * and it is exhaustively tested; this adds the one thing the panel already
 * knew privately (which of those surfaces actually FILLS the pane, as opposed
 * to drawing a bar) and hands the same answer to the other stage. Both
 * callers now read one function, which is what stops them disagreeing again.
 */
export function watchPartyPanelOwnsPane(input: {
  /** The party as this person may see it, or null when there is none. */
  state: WatchPartyPhase | null;
  /** A playable stream exists for this channel. */
  hasStream: boolean;
  /** This person holds a seat in this channel's voice room. */
  inCall: boolean;
  /** This person may start a party here (START_WATCH_PARTY). */
  canStart: boolean;
}): boolean {
  const surface = watchPartySurface(input);
  return (
    surface === "setup" ||
    surface === "scheduled" ||
    surface === "empty" ||
    // A live party with nothing on screen yet: the panel draws the holding or
    // preparing stage. With a picture it draws nothing and the pane is the
    // audience stage's, exactly as before.
    ((surface === "live" || surface === "liveUntitled") &&
      !input.hasStream &&
      !input.inCall)
  );
}
