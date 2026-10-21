import type { ShareAudioApi } from "@pqp/app-sdk";
import type { AudioHub } from "./audio";

/**
 * The game's sound, for a share of the pane. The page cannot reach into this frame (an opaque origin), so while it
 * wants the sound (a share is running) the audio hub's tap hands every block it reads to the host, which plays them
 * into the share. Nothing is read or sent while the page does not want it. The tap sits before the mute switch, so
 * M silences this person's own speakers and the people watching still hear the game.
 *
 * A host that predates `share.audio` never pushes `on: true`, and one that does but refuses the blocks answers
 * `invalid`: either way this stays idle or costs a few ignored messages, never an error on screen.
 */
export function wireShareSound(shareAudio: ShareAudioApi, hub: Pick<AudioHub, "setTap">): () => void {
  const stop = shareAudio.onWanted((wanted) => {
    hub.setTap(wanted ? (block) => shareAudio.send(block) : null);
  });
  return () => {
    stop();
    hub.setTap(null);
  };
}
