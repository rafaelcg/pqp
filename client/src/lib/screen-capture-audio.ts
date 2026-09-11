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
 *   On Chrome this is the path that already stops the call coming back (heard
 *   on a Windows Chrome share, 30 Aug 2026). On the desktop app it needs
 *   Electron 43.4+, where the handler started honouring the constraint.
 *
 * - `audio: false` in the Electron shell, unless the user opted in. The shell
 *   answers `setDisplayMediaRequestHandler` itself and returns
 *   `{ video: source, audio: "loopback" }` on Windows (`electron/lib/display-
 *   sources.js`). From Electron 43.4 / 44 that `"loopback"` is remapped to
 *   `loopbackWithoutChrome` when this file asked `restrictOwnAudio: true`, so
 *   the call playing in this window is kept out of the tap. Electron 34
 *   (v0.1.3) ignores the constraint, which is why a new desktop binary is the
 *   remaining fix. The page not asking for audio is still the off switch, and
 *   the picker lists screens and windows only, never tabs, so there is no
 *   tab-audio path for `audio: false` to take away.
 */

import {
  cursorConstraintFor,
  type CursorCaptureConstraint,
} from "./screen-capture-cursor";

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
export interface ScreenCaptureOptions
  extends Omit<DisplayMediaStreamOptions, "video"> {
  /** Widened so the cursor constraint the DOM lib omits can be carried. */
  video?: boolean | ScreenVideoConstraints;
  /** Chromium: offer the machine's own output as a capturable source. */
  systemAudio?: "include" | "exclude";
  /** Chromium: whether the tab running this app may be picked. */
  selfBrowserSurface?: "include" | "exclude";
  /** Chromium: offer "share this tab instead" while a share is running. */
  surfaceSwitching?: "include" | "exclude";
  /** Chromium: open the picker already pointed at tabs. */
  preferCurrentTab?: boolean;
  /** Chromium: whether entire screens are offered. */
  monitorTypeSurfaces?: "include" | "exclude";
}

/**
 * How the picker should be steered. The default is a normal share: screens,
 * windows and tabs, no system audio unless the user opted in.
 *
 * Watch party is a tab share of the player. `preferBrowserTab` asks Chrome
 * for a tab surface and hides the whole desktop, and it never takes the
 * system-audio opt-in: that opt-in is the echo path.
 *
 * `hideCursor` is the standing "leave my mouse out of it" preference
 * (`lib/screen-capture-cursor.ts`). It rides on the intent rather than on its
 * own parameter because it is the same kind of thing: a steer on the capture
 * we are about to ask for, decided before the picker opens.
 *
 * `maxFrameRate` is 60 so a 24 fps film on a 60 Hz display is captured the
 * way the host sees it. Capture at 30 is what made that film judder for
 * the audience. 30 remains available when the presenter pins it, or when
 * the HLS ladder is 30-only.
 */
export interface ScreenCaptureIntent {
  preferBrowserTab?: boolean;
  /**
   * This share feeds a watch party's stream. The one fact the mic-into-share
   * mix (`lib/screen-mix.ts`) keys on. Deliberately NOT `preferBrowserTab`:
   * that is a picker hint the ordinary call strip's Watch party button also
   * sends in a plain voice call, where folding somebody's mic into a track
   * other people's volume sliders control would be wrong.
   */
  watchParty?: boolean;
  hideCursor?: boolean;
  /** 60 to match the host display; 30 when the presenter or ladder says so. */
  maxFrameRate?: 30 | 60;
  /**
   * A display stream the caller already has, to publish instead of opening
   * the picker again.
   *
   * The watch party setup surface exists so a host can see exactly what the
   * room will see BEFORE anybody sees it, which means the picker has to run
   * during setup rather than at "Ir ao vivo". Handing that same stream to the
   * call is what makes the preview a preview rather than a rehearsal: without
   * it the host picks a window, looks at it, presses go live, and is asked to
   * pick a window a second time, at which point the thing they approved and
   * the thing that goes out are two different captures.
   *
   * Everything downstream of the capture is unchanged: the same track
   * bookkeeping, the same "share ended" listener, the same audio handling.
   * Only the two lines that would have called `getDisplayMedia` are skipped.
   */
  stream?: MediaStream;
}

/** `MediaTrackConstraintSet` plus the screen-audio member TypeScript lacks. */
type ScreenAudioConstraints = MediaTrackConstraints & {
  /** Chrome 141+: drop audio this document itself produced. */
  restrictOwnAudio?: boolean;
};

/** `MediaTrackConstraintSet` plus the cursor member TypeScript lacks. */
type ScreenVideoConstraints = MediaTrackConstraints & {
  /** Screen Capture spec: whether the pointer is drawn into the capture. */
  cursor?: CursorCaptureConstraint;
};

export interface ScreenCaptureEnvironment {
  /**
   * True inside the Electron shell. Injected rather than read from
   * `isDesktopApp()` so the shell's branch is reachable from a Node test, which
   * is the only place it will ever be exercised before a user hits it.
   */
  isDesktopShell: boolean;
  /**
   * `process.platform` as the shell reported it (`window.pqpDesktop.platform`),
   * null in a browser. It decides whether asking the shell for audio can be
   * answered at all: see `shellCarriesScreenAudio`.
   */
  shellPlatform: string | null;
  /**
   * Whether this browser knows the `restrictOwnAudio` constraint, i.e.
   * `navigator.mediaDevices.getSupportedConstraints().restrictOwnAudio`.
   */
  supportsRestrictOwnAudio: boolean;
  /**
   * True when the desktop share picker itself asks about computer audio.
   * Absence means an older shell that treats `audioRequested` as the whole
   * switch, so the page must not request audio unless the person already
   * opted in somewhere the page owns.
   */
  sharePickerOffersAudio: boolean;
}

/**
 * Can a capture inside the desktop shell carry the machine's sound at all?
 *
 * Windows only, and that is not our rule: Chromium's loopback device is WASAPI,
 * which exists on no other platform, so `electron/lib/display-sources.js` answers
 * every macOS and Linux request with video alone.
 *
 * THE BUG THIS ANSWERS (reported 3 Sep 2026, "o picker fecha e a stream não
 * começa"). The shell being video-only is not the same as the *page* being
 * video-only. `setDisplayMediaRequestHandler` is registered with
 * `useSystemPicker: true`, and where the OS picker is used the handler is
 * skipped, so the renderer's audio request goes straight to Chromium with
 * nothing in between to strip it. On macOS there is no system audio to give,
 * and an audio request that cannot be honoured rejects the WHOLE capture,
 * video included. The person ticks "share sound", picks a screen, and gets
 * nothing at all — while the same tick on Windows works.
 *
 * So the renderer has to know the platform too. Asking for audio only where it
 * can be delivered is the difference between a silent share and no share.
 */
export function shellCarriesScreenAudio(env: ScreenCaptureEnvironment): boolean {
  return env.isDesktopShell && env.shellPlatform === "win32";
}

export function screenCaptureEnvironment(
  isDesktopShell: boolean,
  shellPlatform: string | null = null,
  extras: { sharePickerOffersAudio?: boolean } = {},
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
  return {
    isDesktopShell,
    shellPlatform,
    supportsRestrictOwnAudio,
    sharePickerOffersAudio: extras.sharePickerOffersAudio === true,
  };
}

/**
 * Can this capture strip the call out of a system-audio tap?
 *
 * Without that, offering "share this computer's sound" is offering the
 * 23 Aug 2026 echo. Chrome 141+ and Electron 43.4+ can; older engines cannot,
 * so they keep the exclude default and a tab share is the only clean path.
 */
export function canExcludeCallFromSystemAudio(
  env: ScreenCaptureEnvironment,
): boolean {
  return env.supportsRestrictOwnAudio;
}

/**
 * Chrome / Edge will show their own "Share system audio" box when we include.
 *
 * That is the one-checkbox path on the web: we unlock the option, they tick
 * it in the same picker where they pick the screen. Watch party never wants
 * this — it is a tab share of the player.
 */
export function offersBrowserSystemAudio(
  env: ScreenCaptureEnvironment,
  intent: ScreenCaptureIntent = {},
): boolean {
  return (
    !env.isDesktopShell &&
    canExcludeCallFromSystemAudio(env) &&
    !intent.preferBrowserTab
  );
}

/**
 * The desktop app can tap Windows loopback AND strip its own playback.
 *
 * Old shells (Electron 34 / v0.1.3) can tap and cannot strip, so they are
 * treated as unable: asking for audio there is how every share echoed.
 */
export function offersShellSystemAudio(env: ScreenCaptureEnvironment): boolean {
  return shellCarriesScreenAudio(env) && canExcludeCallFromSystemAudio(env);
}

/**
 * The page has to ask about computer audio before `getDisplayMedia`.
 *
 * True only on a Windows shell that can exclude the call but whose picker
 * does not ask yet. The next desktop binary puts the box in the picker and
 * advertises `sharePickerOffersAudio`, and this becomes false.
 */
export function needsShareAudioPrompt(env: ScreenCaptureEnvironment): boolean {
  return offersShellSystemAudio(env) && !env.sharePickerOffersAudio;
}

/**
 * What we ask a screen capture for.
 *
 * `shareSystemAudio` is the user's explicit opt-in on a desktop shell whose
 * picker cannot ask yet. On the web it is ignored: Chrome 141+ gets
 * `systemAudio: "include"` so its own picker shows one checkbox, and
 * `restrictOwnAudio` keeps the call out of that tap. False does not mean
 * "silent share": a Chrome tab share still carries that tab's own sound.
 *
 * The mic's processing chain stays off in both modes. Echo cancellation and
 * noise suppression exist for a person talking into a laptop and would chew
 * holes in a film's soundtrack, and (see the file header) neither of them can
 * touch this echo anyway.
 *
 * `intent.hideCursor` puts the spec's cursor constraint on the video request.
 * What that is worth on each engine, and why it is asked for anyway, is in
 * `lib/screen-capture-cursor.ts`.
 */
export function screenCaptureOptions(
  shareSystemAudio: boolean,
  env: ScreenCaptureEnvironment,
  intent: ScreenCaptureIntent = {},
): ScreenCaptureOptions {
  const audio: ScreenAudioConstraints = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  };
  if (env.supportsRestrictOwnAudio) {
    audio.restrictOwnAudio = true;
  }
  // Three doors, one rule: never offer the machine's mixer unless this
  // document can be kept out of it.
  //
  // 1. Browser + restrictOwnAudio: `include` so Chrome shows *its* checkbox
  //    in the same picker. The old pre-arm toggle was a second box for the
  //    same question and is why people could not find the control.
  // 2. Windows shell whose picker asks: request audio so the handler can
  //    attach loopback when they tick it. The picker is the consent.
  // 3. Windows shell whose picker cannot ask: the page dialog is the consent,
  //    and `shareSystemAudio` is its answer. Off means `audio: false`, which
  //    is still the only lever a v0.1.3 install honours.
  //
  // Watch party never takes the machine's mixer: it wants the player tab.
  const browserOffersCheckbox = offersBrowserSystemAudio(env, intent);
  const shellWantsAudio =
    offersShellSystemAudio(env) &&
    (env.sharePickerOffersAudio || shareSystemAudio) &&
    !intent.preferBrowserTab;
  const carriesAudio = browserOffersCheckbox || shellWantsAudio;
  const maxFrameRate = intent.maxFrameRate === 60 ? 60 : 30;
  return {
    // `video: true` used to be the whole of this, and it is why a share arrived
    // as a slideshow. With no frameRate asked for, a capture of a large surface
    // is handed over at whatever rate the browser feels like, and with no
    // ceiling on size a 4K or Retina display is captured at its full pixel count
    // and then has to be scaled down inside the encoder every frame. 1080p30 is
    // the size people actually share. 60 fps is the cadence of the host's
    // display, which is what keeps a 24 fps film looking like it does on
    // their screen. Pin 30 via `maxFrameRate` when the machine or a 30-only
    // HLS ladder cannot spend it.
    video: {
      frameRate: { ideal: maxFrameRate, max: maxFrameRate },
      width: { max: 1920 },
      height: { max: 1080 },
      // Asked for unconditionally, not feature-detected like `restrictOwnAudio`
      // above, and the difference is deliberate. An audio constraint an engine
      // cannot honour can fail the whole capture, so that one is only sent
      // where it is known; an unknown *dictionary member* is dropped by the
      // bindings before any capturer sees it, which is what all three engines
      // do with `cursor` today. So it costs nothing to ask, and the day one of
      // them implements it every client already asked for the right thing. The
      // promise is gated elsewhere (`canControlShareCursor`), not here.
      cursor: cursorConstraintFor(intent.hideCursor ? "hide" : "show"),
      ...(intent.preferBrowserTab ? { displaySurface: "browser" as const } : {}),
    },
    // In the shell, "no audio asked for" is the only way to stop it answering
    // with Windows loopback, and it costs nothing there: its picker has no tab
    // surfaces to offer tab audio from. It is also the only way to stop the
    // system picker, which skips our handler entirely, from carrying the
    // request to a platform that will reject the whole capture over it.
    audio: env.isDesktopShell && !carriesAudio ? false : audio,
    systemAudio: carriesAudio ? "include" : "exclude",
    // Sharing the pqp tab itself would put the call's own picture back into the
    // call, and the loop gets louder every trip; the picker not offering that
    // tab is a cheaper answer than a hall of mirrors nobody can locate.
    selfBrowserSurface: "exclude",
    surfaceSwitching: "include",
    ...(intent.preferBrowserTab
      ? {
          // Tab-first picker. `preferCurrentTab` is the other Chrome hint
          // and it means "offer *this* tab", which is pqp: mutually exclusive
          // with `selfBrowserSurface: "exclude"` and the hall-of-mirrors case.
          // `displaySurface: "browser"` on video (above) plus hiding monitors
          // is the valid shape that opens on the Tabs pane.
          monitorTypeSurfaces: "exclude" as const,
        }
      : {}),
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

/**
 * Does a share we are RECEIVING carry sound?
 *
 * WHY THIS EXISTS. The presenter has always been told when their own share is
 * silent ("Você está transmitindo (sem som)"). The person watching was told
 * nothing, so the only move available to somebody staring at a silent stream
 * was to ask in chat, which they did, over and over: "dá pra ouvir o som do
 * compartilhamento? pq não to conseguindo ouvir" (QG, 3 Sep 2026, and a dozen
 * times before it).
 *
 * The old reason for the silence was that whether a peer's share carries sound
 * is "their business, and we would only be guessing". That was true of what
 * they PICKED and is not true of what we RECEIVED: the audio track either
 * arrived on this machine or it did not. Reading it is a fact, not a guess.
 *
 * `ended` tracks do not count. A track that has stopped is one the presenter
 * turned off mid-share, and the viewer's answer to "can I hear this" is the
 * same as if it had never come. `muted` is deliberately NOT consulted: on a
 * remote track it means "no data this instant", which is briefly true for
 * every healthy track right after it arrives, and reading it would flash "sem
 * som" over a share that is about to be perfectly audible.
 *
 * Takes the tracks rather than the stream so the decision is testable without
 * a MediaStream, which jsdom does not implement.
 */
export function shareStreamHasAudio(
  audioTracks: readonly { readyState?: string }[],
): boolean {
  return audioTracks.some((track) => track.readyState !== "ended");
}
