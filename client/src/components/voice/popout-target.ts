import { cameraSoloId } from "@/components/dm/call-stage-state";

/**
 * Which ONE picture the share popout shows (issue 1736).
 *
 * The popout holds a single picture on purpose: several floating windows over
 * a chat is clutter, and the theater (maximize) is where several shares are
 * watched side by side. So with more than one candidate somebody has to win,
 * and these are the rules, in order:
 *
 *  1. What the person picked in the popout's switcher (or by pressing
 *     "Assistir"). Somebody who asked for a picture keeps it.
 *  2. What the popout is already showing, while it is still there. A popout
 *     that jumps to another share because the roster changed is a popout you
 *     cannot watch anything in; this is the same rule as the stage's "position
 *     does not change" (`stage-layout.ts`).
 *  3. The focused share (`VoiceState.focusedScreenPeerId`). That is the share
 *     whose sound plays, and it is also the newest one: the wire carries no
 *     start time and `nextScreenShareFocus` already works "newest" out by
 *     diffing rosters, so this rule covers both "the one with the audio" and
 *     "the most recent".
 *  4. A share that arrived with sound.
 *  5. The last share in roster order.
 *  6. With no share being watched, the camera of somebody speaking, then the
 *     camera already on the popout.
 *
 * Our own share and our own camera are never candidates: we know what we are
 * sending, and `OwnShareStrip` says so. A share the person has not chosen to
 * watch (dismissed) is not a candidate either, because nothing is received for
 * it.
 *
 * Ids are the stage's own: a screen is its `peerId`, a camera is
 * `camera:<personKey>` (`cameraSoloId`), so a pick made here means the same
 * tile in the theater's grid, the fullscreen machinery and the PiP button.
 */

export interface PopoutScreenInput {
  peerId: string;
  isSelf: boolean;
  /** The received stream carries sound (`ScreenShareTile.hasAudio`). */
  hasAudio: boolean;
}

export interface PopoutCameraInput {
  /** The person's stage key, the same key `planStage` uses. */
  key: string;
  isSelf: boolean;
}

export type PopoutChoiceKind = "screen" | "camera";

export interface PopoutChoice {
  id: string;
  kind: PopoutChoiceKind;
  /** `peerId` for a screen, the person key for a camera. */
  key: string;
}

/**
 * Everything the popout could show, in the order the switcher lists it:
 * watched shares in roster order, then cameras in roster order.
 */
export function popoutChoices(input: {
  screens: readonly PopoutScreenInput[];
  /** `VoiceState.dismissedSharePeerIds`. */
  dismissedScreenIds: readonly string[];
  /** People with a camera picture right now. */
  cameras: readonly PopoutCameraInput[];
}): PopoutChoice[] {
  const dismissed = new Set(input.dismissedScreenIds);
  const screens: PopoutChoice[] = input.screens
    .filter((screen) => !screen.isSelf && !dismissed.has(screen.peerId))
    .map((screen) => ({ id: screen.peerId, kind: "screen", key: screen.peerId }));
  const cameras: PopoutChoice[] = input.cameras
    .filter((camera) => !camera.isSelf)
    .map((camera) => ({ id: cameraSoloId(camera.key), kind: "camera", key: camera.key }));
  return [...screens, ...cameras];
}

export function popoutTarget(input: {
  screens: readonly PopoutScreenInput[];
  dismissedScreenIds: readonly string[];
  cameras: readonly PopoutCameraInput[];
  /** The switcher's choice, as a choice id. */
  pickedId: string | null;
  /** What the popout showed last time, as a choice id. */
  currentId: string | null;
  /** `VoiceState.focusedScreenPeerId`. */
  focusedScreenPeerId: string | null;
  /** Person keys speaking right now. */
  speakingKeys?: ReadonlySet<string>;
}): string | null {
  const choices = popoutChoices(input);
  const ids = new Set(choices.map((choice) => choice.id));
  if (input.pickedId !== null && ids.has(input.pickedId)) {
    return input.pickedId;
  }
  const screens = choices.filter((choice) => choice.kind === "screen");
  const current = choices.find((choice) => choice.id === input.currentId);
  // Only a share is sticky. A camera on the popout yields to a share (a camera
  // only got the popout because nobody was sharing a moment ago), and among
  // cameras it follows whoever is speaking, which is rule 6.
  if (current?.kind === "screen") {
    return current.id;
  }
  if (screens.length > 0) {
    if (
      input.focusedScreenPeerId !== null &&
      screens.some((screen) => screen.id === input.focusedScreenPeerId)
    ) {
      return input.focusedScreenPeerId;
    }
    const withSound = input.screens.find(
      (screen) => ids.has(screen.peerId) && screen.hasAudio,
    );
    if (withSound) {
      return withSound.peerId;
    }
    return screens[screens.length - 1]!.id;
  }
  const cameras = choices.filter((choice) => choice.kind === "camera");
  const speaking = input.speakingKeys;
  const speaker = speaking
    ? cameras.find((camera) => speaking.has(camera.key))
    : undefined;
  if (speaker) {
    return speaker.id;
  }
  if (current && current.kind === "camera") {
    return current.id;
  }
  return null;
}
