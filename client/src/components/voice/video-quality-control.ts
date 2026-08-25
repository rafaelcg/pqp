/**
 * When the in-call video quality control exists, and what its being open means
 * for the bar it sits in.
 *
 * WHY THIS EXISTS. The quality selector shipped into Settings under a tab
 * then called "Voice & Audio", and nobody found it: a video control filed under
 * "audio", two clicks away from the call, with a readout that only says
 * anything while a camera is running. The fix is a second surface on the call
 * itself, next to the camera button. That surface has to answer three
 * questions, and all three are decisions rather than markup:
 *
 *   1. Is the control there at all?
 *   2. If it was open and the thing it belongs to goes away, is it still open?
 *   3. May the control bar fade itself out while somebody is reading it?
 *
 * They live here, pure, because the client suite runs in node with no DOM: a
 * component test could not reach any of them, and each one is a bug with a
 * visible shape (a menu floating over nothing, a bar that vanishes mid-read).
 */

export interface VideoQualityControlContext {
  /** Whether this machine's camera is currently sending. */
  isCameraOn: boolean;
  /** Whether this machine is currently presenting a screen. */
  isSharingScreen: boolean;
  /**
   * Whether anybody else's video is arriving right now.
   *
   * NEW TERM, AND THE REASON THE CONTROL EXISTS FOR VIEWERS AT ALL. Until now
   * this was `isCameraOn || isSharingScreen`, so somebody who was only
   * *watching* had no video surface on the call whatsoever. That is precisely
   * the person who reported a soft screen share, went looking for a quality
   * control, and found the only one the product has: the Settings selector,
   * which governs what leaves *their* machine and could not possibly change
   * what arrives. They moved it from 360p to 1080p, twice, and nothing
   * happened, because nothing was ever going to.
   *
   * A viewer cannot be given a knob here — the sender encodes the stream and
   * `RTCRtpReceiver` has no size or rate parameter — but they can be given the
   * answer, which is the size that is actually arriving and whose choice it
   * was. So the control opens for them too, showing the receiving half alone.
   */
  hasIncomingVideo: boolean;
  /** The stage's one-line collapsed strip, which carries only the essentials. */
  collapsed: boolean;
}

/**
 * HIDDEN, not disabled, when there is no video on this call in either
 * direction.
 *
 * Three reasons, in order of weight. The bar is crowded and sending-nothing is
 * the state *everybody* is in by default, so hiding is what keeps the bar
 * exactly as it is today for the people who never touch video. The readout is
 * the whole reason the control is here at all, and with nothing going out it
 * has nothing to report but "turn your camera on" — which is precisely the
 * dead-end that made the Settings placement useless. And nothing is lost:
 * Settings still carries the same choice for anyone who wants to pin a size
 * before a call.
 *
 * SCREEN SHARE COUNTS, and it did not used to. The condition was `isCameraOn`
 * alone, from when the setting genuinely only moved the camera. Now that the
 * same choice governs the screen sender, camera-off-and-sharing is the single
 * case where somebody most wants this control and is the exact situation the
 * bug report came from: presenting, watching it go soft, with the one thing
 * that would fix it hidden because their webcam happened to be off.
 *
 * Collapsed hides it for the same reason the share and fullscreen buttons are
 * already hidden there: that strip is a reminder that a call exists, not a
 * console.
 */
export function showsVideoQualityControl({
  isCameraOn,
  isSharingScreen,
  hasIncomingVideo,
  collapsed,
}: VideoQualityControlContext): boolean {
  return (isCameraOn || isSharingScreen || hasIncomingVideo) && !collapsed;
}

/**
 * The menu is open only while its button is on screen.
 *
 * Derived rather than corrected after the fact. Stopping the last outgoing
 * video with the menu open (or collapsing the stage) removes the button it
 * hangs from, and a popover anchored to nothing is the visible bug this
 * prevents in the very render where that happens. The caller still clears its
 * requested flag afterwards, so the menu cannot spring back open by itself
 * later; this function is what makes the intervening frame correct.
 *
 * Note that it takes *all three* video terms, so ending a share while the
 * camera is still on — or while somebody else is still sending you something —
 * leaves the menu up rather than yanking it away: it still has something to
 * govern or something to report.
 */
export function videoQualityMenuOpen(
  context: VideoQualityControlContext & { requested: boolean },
): boolean {
  return context.requested && showsVideoQualityControl(context);
}

/**
 * Whether the control bar may fade itself out after a few idle seconds.
 *
 * The existing rule is desktop-pointer plus video plus not collapsed. The menu
 * adds one term: a bar that fades while its own popover is open takes the
 * popover with it (the container goes `pointer-events-none`), and reading a
 * three-line readout takes longer than the three-second idle timer. Somebody
 * standing still and reading is not idle.
 */
export function callControlsMayIdle(input: {
  /** Desktop pointer, motion not reduced. */
  autoHide: boolean;
  /** Any video on the stage at all; over avatars there is nothing to uncover. */
  anyVideo: boolean;
  collapsed: boolean;
  menuOpen: boolean;
}): boolean {
  return input.autoHide && input.anyVideo && !input.collapsed && !input.menuOpen;
}
