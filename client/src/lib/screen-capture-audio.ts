/**
 * What a screen capture is allowed to pick up, and when to warn about it.
 *
 * THE BUG THIS FILE EXISTS FOR. A 3-star call rating on 23 Aug 2026, verbatim:
 * "Quando alguém transmite, ele repete a Call de quem esta na chamada tbm. Aí
 * fica com eco." Somebody shares their screen and everyone hears themselves
 * come back. The cause was one word in the capture options: `systemAudio:
 * "include"` asks the picker to offer the machine's whole audio output, and
 * the machine's whole audio output contains the call. Every voice in the room
 * was captured off the speakers-mixer and sent straight back into the room.
 *
 * THREE THINGS THAT LOOK LIKE THE FIX AND ARE NOT.
 *
 * 1. Echo cancellation. AEC subtracts a known reference signal from what a
 *    *microphone* heard. System audio is tapped after the mixer and never goes
 *    near a microphone, so there is nothing for AEC to subtract. And
 *    `echoCancellation: false` on a screen-audio track is *correct*: it is what
 *    keeps a film's soundtrack from being chewed into holes. The flag is not
 *    the bug and turning it on would not fix the bug.
 *
 * 2. Headphones. On Windows the loopback tap is WASAPI's render endpoint, which
 *    is the same endpoint whether the audio then leaves via speakers or via a
 *    headset. Unlike ordinary acoustic echo, where headphones are the whole
 *    answer, here they change nothing.
 *
 * 3. `selfBrowserSurface: "exclude"`. It keeps our own tab out of the *video*
 *    picker. It says nothing at all about audio.
 *
 * WHAT ACTUALLY FIXES IT, in the order the platform gives them to us:
 *
 * - `systemAudio: "exclude"` is the default here now. Per the Screen Capture
 *   spec it applies to monitor surfaces only, so a whole-screen share can no
 *   longer carry the machine's output, and a **tab** share still can. Tab audio
 *   is the clean path (a tab share captures that tab and nothing else, so the
 *   call in another tab is not in it) and it stays fully available. Measured on
 *   Chrome 151: with `systemAudio: "exclude"` a tab capture still hands over a
 *   "Tab audio" track.
 *
 * - `restrictOwnAudio: true`, for the person who deliberately opts back in.
 *   Chrome desktop 141 shipped it and the spec is explicit: "the user agent
 *   MUST attempt to remove any audio from the audio being captured that was
 *   produced by the document that performed getDisplayMedia()". Our document is
 *   the one playing everybody's voices, so this is the per-source exclusion that
 *   Chromium was long assumed not to expose. Feature-detected, because it is
 *   young: a browser that does not know the name would be handed a constraint it
 *   cannot honour, and this is not a promise worth risking a whole capture on.
 *   NOT verified against a real Windows loopback capture by anyone here, which
 *   is exactly why it is a second line of defence and not the whole answer.
 *
 * - `audio: false` in the Electron shell, unless the user opted in. The shell
 *   answers `setDisplayMediaRequestHandler` itself and returns
 *   `{ video: source, audio: "loopback" }` on Windows (`electron/lib/display-
 *   sources.js`), which is whole-system loopback with no self-exclusion of any
 *   kind, and which Chromium 132 (Electron 34) has no `restrictOwnAudio` to
 *   soften. The shell only asks for loopback when the page asked for audio, so
 *   the page not asking is the off switch, and it is an off switch that works on
 *   shells that are ALREADY INSTALLED: the desktop app loads the live web
 *   client, so this lands on v0.1.3 without anybody shipping a new binary.
 *   The shell's picker lists screens and windows only, never tabs, so there is
 *   no tab-audio path in Electron for this to take away.
 */

/**
 * The display-capture options the DOM lib does not know about yet.
 *
 * `systemAudio`, `selfBrowserSurface` and `surfaceSwitching` are Screen Capture
 * spec extensions that TypeScript's `DisplayMediaStreamOptions` still omits.
 * Declared narrowly, as the fields we actually pass, so a typo stays a compile
 * error, where casting the call to `any` would hide exactly the mistakes this
 * feature is most likely to make. A browser that does not know a key ignores
 * it, which is the degradation we want.
 */
export interface ScreenCaptureOptions extends DisplayMediaStreamOptions {
  /** Chromium: offer the machine's own output as a capturable source. */
  systemAudio?: "include" | "exclude";
  /** Chromium: whether the tab running this app may be picked. */
  selfBrowserSurface?: "include" | "exclude";
  /** Chromium: offer "share this tab instead" while a share is running. */
  surfaceSwitching?: "include" | "exclude";
}

/** `MediaTrackConstraintSet` plus the screen-audio member TypeScript lacks. */
type ScreenAudioConstraints = MediaTrackConstraints & {
  /** Chrome 141+: drop audio this document itself produced. */
  restrictOwnAudio?: boolean;
};

export interface ScreenCaptureEnvironment {
  /**
   * True inside the Electron shell. Injected rather than read from
   * `isDesktopApp()` so the shell's branch is reachable from a Node test, which
   * is the only place it will ever be exercised before a user hits it.
   */
  isDesktopShell: boolean;
  /**
   * Whether this browser knows the `restrictOwnAudio` constraint, i.e.
   * `navigator.mediaDevices.getSupportedConstraints().restrictOwnAudio`.
   */
  supportsRestrictOwnAudio: boolean;
}

export function screenCaptureEnvironment(
  isDesktopShell: boolean,
): ScreenCaptureEnvironment {
  let supportsRestrictOwnAudio = false;
  try {
    const supported = navigator.mediaDevices.getSupportedConstraints() as
      MediaTrackSupportedConstraints & { restrictOwnAudio?: boolean };
    supportsRestrictOwnAudio = supported.restrictOwnAudio === true;
  } catch {
    // No `mediaDevices` at all. The caller is about to fail for a much larger
    // reason than a missing constraint; answering "no" is the safe shape.
  }
  return { isDesktopShell, supportsRestrictOwnAudio };
}

/**
 * What we ask a screen capture for.
 *
 * `shareSystemAudio` is the user's explicit opt-in and it defaults to false at
 * every call site. False does not mean "silent share": a Chrome tab share still
 * carries that tab's own sound, which is the route this product recommends and
 * the only one that cannot echo.
 *
 * The mic's processing chain stays off in both modes. Echo cancellation and
 * noise suppression exist for a person talking into a laptop and would chew
 * holes in a film's soundtrack, and (see the file header) neither of them can
 * touch this echo anyway.
 */
export function screenCaptureOptions(
  shareSystemAudio: boolean,
  env: ScreenCaptureEnvironment,
): ScreenCaptureOptions {
  const audio: ScreenAudioConstraints = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  };
  if (env.supportsRestrictOwnAudio) {
    audio.restrictOwnAudio = true;
  }
  return {
    // `video: true` used to be the whole of this, and it is why a share arrived
    // as a slideshow. With no frameRate asked for, a capture of a large surface
    // is handed over at whatever rate the browser feels like, and with no
    // ceiling on size a 4K or Retina display is captured at its full pixel count
    // and then has to be scaled down inside the encoder every frame. 1080p30 is
    // the shape of the thing people actually share, and asking for it is cheaper
    // than paying for pixels nobody in the call can see.
    video: {
      frameRate: { ideal: 30, max: 30 },
      width: { max: 1920 },
      height: { max: 1080 },
    },
    // In the shell, "no audio asked for" is the only way to stop it answering
    // with Windows loopback, and it costs nothing there: its picker has no tab
    // surfaces to offer tab audio from.
    audio: env.isDesktopShell && !shareSystemAudio ? false : audio,
    systemAudio: shareSystemAudio ? "include" : "exclude",
    // Sharing the pqp tab itself would put the call's own picture back into the
    // call, and the loop gets louder every trip; the picker not offering that
    // tab is a cheaper answer than a hall of mirrors nobody can locate.
    selfBrowserSurface: "exclude",
    surfaceSwitching: "include",
  };
}

/**
 * Is this live capture carrying the machine's whole output?
 *
 * Answered from what the browser says was ACTUALLY picked, not from what we
 * asked for, which is the difference between a guess and a fact: the user may
 * have opted in and then chosen a tab, or the shell may have handed over
 * loopback we did not expect. `displaySurface: "monitor"` plus a live audio
 * track is the only combination that can put the call back into the call, and
 * it is decided the moment the picker closes, which is when the person can
 * still do something about it.
 *
 * A tab share ("browser") captures that tab and nothing else, so the call,
 * which is in another tab or is this very document, is not in it. A window
 * share carries no audio on any platform this ships to. Neither can echo.
 *
 * An absent `displaySurface` counts as NOT a monitor on purpose. The browsers
 * that omit it are the ones with no system-audio capture to begin with, and
 * warning about an echo the platform cannot produce is how a true warning gets
 * trained into background noise.
 */
export function capturesSystemAudio(input: {
  /** `videoTrack.getSettings().displaySurface`, absent on browsers that omit it. */
  displaySurface?: string | null;
  /** Whether the capture handed over an audio track. */
  hasAudio: boolean;
}): boolean {
  return input.hasAudio && input.displaySurface === "monitor";
}
