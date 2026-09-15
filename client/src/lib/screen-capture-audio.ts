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
 * - `systemAudio: "exclude"` is the default. The spec scopes that member to
 *   **monitor** surfaces. A tab share still carries that tab's own sound.
 *   A **window** share is not silent: Chrome's default `windowAudio` is
 *   system, so the window pane can offer the same mixer. We send
 *   `windowAudio: "window"` only on Windows 11 Chrome (per-app loopback) and
 *   `"exclude"` everywhere else, including every watch party.
 *
 * - `restrictOwnAudio: true` when the engine knows the name. The spec: drop
 *   audio this document produced. Chromium only honours that on Windows 11
 *   (build ≥ 22000). `getSupportedConstraints().restrictOwnAudio` is a
 *   stable flag, true on Windows 10 too, so it is not proof the OS can
 *   exclude us. We offer computer sound only after a UA-CH Win11 check
 *   (`platformVersion` major ≥ 13, or NT build ≥ 22000). Missing hint →
 *   exclude. Electron loopback is the same gate, parsed from `os.release()`
 *   as `10.0.BUILD`, never `major === 11`.
 *
 * - After the picker, if a monitor or window track still has audio and
 *   `getSettings().restrictOwnAudio` is **false** (or capabilities cannot
 *   include true), we strip that track before publish. Undefined settings are
 *   not a leak: stripping those would silence a working Win11 share.
 *
 * - `audio: false` in the Electron shell unless the user opted in AND this
 *   Windows build can exclude us. The handler still returns `"loopback"`;
 *   Electron 43.4+ remaps it to `loopbackWithoutChrome` when this file asked
 *   `restrictOwnAudio`. Passing `"loopbackWithoutChrome"` ourselves fails the
 *   whole capture on Windows 10.
 */

import {
  desktopShareCapabilities,
  getDesktop,
  isDesktopApp,
  type DesktopShareCapabilities,
} from "./desktop";
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
  /**
   * Chromium: what a **window** share may capture. `"system"` is the mixer
   * (the call). `"window"` is that app only, and only on Windows 11.
   * `"exclude"` is silent besides tab audio.
   */
  windowAudio?: "exclude" | "system" | "window";
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
 * IN THE DESKTOP SHELL IT IS IGNORED, both halves of it. There are no tab
 * surfaces to steer at, and Windows loopback minus our own output is the only
 * sound a capture there can carry, so a desktop watch party takes the same
 * audio path as any other desktop share. `steersAtBrowserTab` is the one place
 * that decides this.
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
  /**
   * Which watch party this go-live share belongs to (Farol, 2026-09-14, two
   * rounds). The gate this intent travels through can defer a share behind
   * `HlsHostAckSheet`'s disclosure notice for as long as the host takes to
   * read and confirm it. In that window the app's selected channel can
   * change, AND the party itself can end (the host closes it from another
   * tab, the grace-window sweep times it out). Carrying both fields lets
   * the eventual completion look the party up fresh by `channelId` and
   * confirm it is still the SAME live party (`id` matches) rather than
   * either re-reading "whatever is selected now" or trusting that a party
   * which asked for a share minutes ago is still the one on screen.
   */
  party?: { id: string; channelId: string };
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
   * Not proof the OS will honour it. That is `osCanExcludeCallAudio`.
   */
  supportsRestrictOwnAudio: boolean;
  /**
   * True only when this OS can actually strip this document from a mixer
   * tap: Windows 11 (UA-CH `platformVersion` major ≥ 13, or NT build ≥
   * 22000). Missing hint is false. Windows 10 reports the constraint and
   * cannot exclude us.
   */
  osCanExcludeCallAudio: boolean;
  /**
   * True when the desktop share picker itself asks about computer audio.
   * Absence means an older shell that treats `audioRequested` as the whole
   * switch, so the page must not request audio unless the person already
   * opted in somewhere the page owns.
   */
  sharePickerOffersAudio: boolean;
  /**
   * What the SHELL says about the machine's sound, rather than what we infer
   * from its platform: `"loopback"` if a capture there can carry it, `"none"`
   * if it cannot, null in a browser and in any shell built before 0.1.6.
   *
   * Null keeps the platform guess below (`shellPlatform === "win32"`), which is
   * what every client did until the shell learned to answer for itself. The
   * guess is right today and is still worth replacing: it is the page reasoning
   * about a binary it cannot see, and the next Electron that grows a macOS
   * loopback device would need a client deploy to be believed.
   */
  shellSystemAudio: "loopback" | "none" | null;
  /**
   * Whether the shell says it keeps this app's own playback out of that tap.
   * Null in a browser or an old shell. False is the one value that changes
   * anything: a shell admitting it cannot strip the call is never offered the
   * machine's mixer, because that offer is the 23 Aug 2026 echo.
   */
  shellRestrictOwnAudio: boolean | null;
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
 * video-only. That build registered `setDisplayMediaRequestHandler` with
 * `useSystemPicker: true`, and where the OS picker is used the handler is
 * skipped, so the renderer's audio request went straight to Chromium with
 * nothing in between to strip it. On macOS there is no system audio to give,
 * and an audio request that cannot be honoured rejects the WHOLE capture,
 * video included. The person ticks "share sound", picks a screen, and gets
 * nothing at all — while the same tick on Windows works.
 *
 * 0.1.6 turns the system picker off, so the handler now answers every request
 * and could in principle drop an audio ask on the floor. The page still does
 * not make one, for the same reason: the handler names a source and Chromium
 * decides what to do with a request it cannot fill, and "asked for nothing"
 * is the only answer with no failure mode in it.
 *
 * So the renderer has to know the platform too. Asking for audio only where it
 * can be delivered is the difference between a silent share and no share.
 */
export function shellCarriesScreenAudio(env: ScreenCaptureEnvironment): boolean {
  if (!env.isDesktopShell) {
    return false;
  }
  // The shell's own answer wins where it gave one. The platform test stays for
  // every build that never said, which is every build before 0.1.6.
  if (env.shellSystemAudio !== null) {
    return env.shellSystemAudio === "loopback";
  }
  return env.shellPlatform === "win32";
}

/**
 * Does this capture steer at a browser TAB?
 *
 * Only ever in a browser. `preferBrowserTab` is the watch party's product
 * ("share the player tab, with its sound") and the desktop shell has no tab
 * surfaces at all: its picker lists screens and windows, which is everything
 * `desktopCapturer` knows about.
 *
 * WHY THIS IS A FUNCTION AND NOT AN `IF`. Asking the shell for a tab is not a
 * hint that gets ignored. `displaySurface: "browser"` is a real constraint, and
 * Chromium checks it against the surface the embedder handed back AFTER the
 * picker closes: no tab, nothing satisfies it, the whole capture is refused
 * with "Invalid capture constraints", and the retry in `startScreenShare` does
 * not fire because that name is neither TypeError nor NotSupportedError. That
 * is a presenter on the desktop app who cannot start a watch party at all,
 * reported 13 Sep 2026, and it is why the tab steer has to be dropped rather
 * than merely tolerated.
 */
export function steersAtBrowserTab(
  env: ScreenCaptureEnvironment,
  intent: ScreenCaptureIntent = {},
): boolean {
  return intent.preferBrowserTab === true && !env.isDesktopShell;
}

export function screenCaptureEnvironment(
  isDesktopShell: boolean,
  shellPlatform: string | null = null,
  extras: {
    sharePickerOffersAudio?: boolean;
    shellSystemAudio?: "loopback" | "none" | null;
    shellRestrictOwnAudio?: boolean | null;
    osCanExcludeCallAudio?: boolean;
  } = {},
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
    osCanExcludeCallAudio: resolveOsCanExcludeCallAudio(
      extras.osCanExcludeCallAudio,
    ),
    sharePickerOffersAudio: extras.sharePickerOffersAudio === true,
    shellSystemAudio: extras.shellSystemAudio ?? null,
    shellRestrictOwnAudio: extras.shellRestrictOwnAudio ?? null,
  };
}

/**
 * The environment as it really is, read off the shell bridge.
 *
 * ONE READER, BECAUSE FOUR WAS ALREADY A BUG. Every caller used to assemble
 * this itself from `isDesktopApp()` plus two `getDesktop()?.` reads, and the
 * watch party's setup surface assembled a version missing the picker flag — so
 * the one share that most needs sound asked for none of it on a Windows desktop
 * whose picker was sitting there ready to offer the box. A capability the page
 * forgets to pass is a capability the shell does not have.
 *
 * `screenCaptureEnvironment` keeps taking its parts as arguments: that is what
 * makes every branch in this file reachable from a Node test, which is the only
 * place the shell's branches are ever exercised before a user hits them.
 */
export function liveScreenCaptureEnvironment(): ScreenCaptureEnvironment {
  const capabilities = desktopShareCapabilities();
  return screenCaptureEnvironment(isDesktopApp(), getDesktop()?.platform ?? null, {
    sharePickerOffersAudio:
      capabilities?.pickerOffersAudio === true ||
      getDesktop()?.sharePickerOffersAudio === true,
    shellSystemAudio: capabilities?.systemAudio ?? null,
    shellRestrictOwnAudio: capabilities?.restrictOwnAudio ?? null,
    osCanExcludeCallAudio: resolveOsCanExcludeCallAudio(undefined, capabilities),
  });
}

/**
 * Chromium's UA-CH Windows 11 signal.
 *
 * `platformVersion` major ≥ 13 is what Chrome reports for Windows 11. A
 * thawed 10.0.BUILD with BUILD ≥ 22000 is accepted if a browser ever stops
 * freezing the NT version. Missing or unparsable is not Win11.
 */
export const WINDOWS_11_NT_BUILD = 22000;

let osCanExcludeCallAudioCache: boolean | undefined;

/**
 * What the Electron shell already decided from `os.release()`.
 *
 * UA-CH is a browser hint. In the shell the main process parsed the NT
 * build and published loopback only when exclude can run. Trust that
 * object when it exists: Electron often has no `userAgentData`, and a
 * false cache would hide computer sound on Windows 11.
 *
 * `undefined` means this is not a current shell. The UA-CH cache stays
 * the source.
 */
export function osCanExcludeCallAudioFromCapabilities(
  capabilities: Pick<
    DesktopShareCapabilities,
    "systemAudio" | "restrictOwnAudio"
  > | null,
): boolean | undefined {
  if (!capabilities) {
    return undefined;
  }
  return (
    capabilities.systemAudio === "loopback" &&
    capabilities.restrictOwnAudio === true
  );
}

function resolveOsCanExcludeCallAudio(
  override?: boolean,
  capabilities: DesktopShareCapabilities | null = desktopShareCapabilities(),
): boolean {
  if (override !== undefined) {
    return override;
  }
  const fromShell = osCanExcludeCallAudioFromCapabilities(capabilities);
  if (fromShell !== undefined) {
    return fromShell;
  }
  return osCanExcludeCallAudioCache === true;
}

export function resetOsCanExcludeCallAudioForTests(): void {
  osCanExcludeCallAudioCache = undefined;
}

export function setOsCanExcludeCallAudioForTests(value: boolean): void {
  osCanExcludeCallAudioCache = value;
}

export function osCanExcludeCallFromUa(
  platform: string | undefined,
  platformVersion: string | undefined,
): boolean {
  if (platform !== "Windows") {
    return false;
  }
  if (!platformVersion) {
    return false;
  }
  const parts = platformVersion.split(".");
  const major = Number.parseInt(parts[0] ?? "", 10);
  if (!Number.isFinite(major)) {
    return false;
  }
  if (major >= 13) {
    return true;
  }
  if (major === 10 && parts.length >= 3) {
    const build = Number.parseInt(parts[2] ?? "", 10);
    return Number.isFinite(build) && build >= WINDOWS_11_NT_BUILD;
  }
  return false;
}

type NavigatorWithUaData = Navigator & {
  userAgentData?: {
    platform?: string;
    getHighEntropyValues?: (
      hints: string[],
    ) => Promise<{ platformVersion?: string }>;
  };
};

async function probeOsCanExcludeCallAudio(): Promise<boolean | "failed"> {
  try {
    const ua = (navigator as NavigatorWithUaData).userAgentData;
    if (!ua || typeof ua.getHighEntropyValues !== "function") {
      return false;
    }
    const values = await ua.getHighEntropyValues(["platformVersion"]);
    return osCanExcludeCallFromUa(ua.platform, values.platformVersion);
  } catch {
    // A thrown probe is not "this OS cannot exclude us". Caching that as
    // false would hide computer sound for the rest of the tab.
    return "failed";
  }
}

/**
 * Warm the Win11 hint. Missing `userAgentData` is false: we do not offer
 * computer sound until we know this OS can exclude the call.
 */
export async function ensureOsCanExcludeCallAudio(): Promise<boolean> {
  const fromShell = osCanExcludeCallAudioFromCapabilities(
    desktopShareCapabilities(),
  );
  if (fromShell !== undefined) {
    osCanExcludeCallAudioCache = fromShell;
    return fromShell;
  }
  if (osCanExcludeCallAudioCache !== undefined) {
    return osCanExcludeCallAudioCache;
  }
  const probed = await probeOsCanExcludeCallAudio();
  if (probed === "failed") {
    return false;
  }
  osCanExcludeCallAudioCache = probed;
  return probed;
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
  if (!env.supportsRestrictOwnAudio) {
    return false;
  }
  if (env.shellRestrictOwnAudio === false) {
    return false;
  }
  return env.osCanExcludeCallAudio;
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
  // `shellRestrictOwnAudio === false` is a shell stating it cannot strip its
  // own playback even though the renderer knows the constraint. Null is every
  // build that never said, and those are already gated by the renderer test
  // above: Electron 34 does not list the constraint at all.
  if (env.shellRestrictOwnAudio === false) {
    return false;
  }
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
  // In a BROWSER, a watch party never takes the machine's mixer: it wants the
  // player tab, whose sound is the clean path.
  //
  // IN THE SHELL THAT RULE INVERTS, and it has to, or a desktop watch party is
  // silent by construction. There is no tab to capture and therefore no tab
  // audio; the only sound a capture here can carry is Windows loopback, minus
  // this app's own output. Refusing it because the intent says "tab" left the
  // presenter broadcasting a film nobody could hear, which is the other half of
  // the 13 Sep 2026 report. The picker's checkbox is still the consent.
  const tabSteer = steersAtBrowserTab(env, intent);
  const browserOffersCheckbox = offersBrowserSystemAudio(env, intent);
  const shellWantsAudio =
    offersShellSystemAudio(env) &&
    (env.sharePickerOffersAudio || shareSystemAudio) &&
    !tabSteer;
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
      // Only where a tab can be picked. In the shell this member is not a hint
      // that gets ignored, it is a constraint nothing can satisfy, and it takes
      // the whole capture with it. See `steersAtBrowserTab`.
      ...(tabSteer ? { displaySurface: "browser" as const } : {}),
    },
    // In the shell, "no audio asked for" is the only way to stop it answering
    // with Windows loopback, and it costs nothing there: its picker has no tab
    // surfaces to offer tab audio from. It is also the only way to stop the
    // system picker, which skips our handler entirely, from carrying the
    // request to a platform that will reject the whole capture over it.
    audio: env.isDesktopShell && !carriesAudio ? false : audio,
    systemAudio: carriesAudio ? "include" : "exclude",
    // Window pane: Chrome's default is `system` (the mixer, the call). We
    // never send that. Win11 Chrome gets per-app `"window"`. Watch party
    // and every other browser get `"exclude"`. The shell is omitted: the
    // handler names loopback, and this member would fight it.
    ...(env.isDesktopShell
      ? {}
      : {
          windowAudio:
            tabSteer || intent.watchParty
              ? ("exclude" as const)
              : env.osCanExcludeCallAudio
                ? ("window" as const)
                : ("exclude" as const),
        }),
    // Sharing the pqp tab itself would put the call's own picture back into the
    // call, and the loop gets louder every trip; the picker not offering that
    // tab is a cheaper answer than a hall of mirrors nobody can locate.
    selfBrowserSurface: "exclude",
    surfaceSwitching: "include",
    ...(tabSteer
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
 * Is this live capture carrying the machine's mixer (or a window's stand-in
 * for it)?
 *
 * Answered from what the browser says was ACTUALLY picked, not from what we
 * asked for. A tab share ("browser") captures that tab and nothing else, so
 * the call is not in it. A **window** share can carry system audio: Chrome's
 * default `windowAudio` is the mixer, and Electron attaches loopback to window
 * sources the same as screens. That is Gio's Pocket Bard path, and it can
 * echo. `monitor` and `window` with a live audio track are the shapes that
 * can put the call back into the call.
 *
 * An absent `displaySurface` counts as NOT a mixer tap on purpose. The
 * browsers that omit it are the ones with no system-audio capture to begin
 * with, and warning about an echo the platform cannot produce is how a true
 * warning gets trained into background noise.
 */
export function capturesSystemAudio(input: {
  /** `videoTrack.getSettings().displaySurface`, absent on browsers that omit it. */
  displaySurface?: string | null;
  /** Whether the capture handed over an audio track. */
  hasAudio: boolean;
}): boolean {
  return (
    input.hasAudio &&
    (input.displaySurface === "monitor" || input.displaySurface === "window")
  );
}

/**
 * Strip leaked mixer audio only when we know exclude did not apply.
 *
 * `restrictOwnAudio === false`, or capabilities that cannot include `true`.
 * Undefined settings are not a leak: Chrome may omit the member when
 * exclude is on, and stripping those would silence a working Win11 share.
 */
export function shouldStripLeakedSystemAudio(input: {
  displaySurface?: string | null;
  hasAudio: boolean;
  restrictOwnAudio?: boolean;
  restrictOwnAudioCaps?: readonly boolean[];
}): boolean {
  if (
    !capturesSystemAudio({
      displaySurface: input.displaySurface,
      hasAudio: input.hasAudio,
    })
  ) {
    return false;
  }
  if (input.restrictOwnAudio === false) {
    return true;
  }
  if (
    Array.isArray(input.restrictOwnAudioCaps) &&
    !input.restrictOwnAudioCaps.includes(true)
  ) {
    return true;
  }
  return false;
}

type RestrictOwnAudioTrack = {
  getSettings?: () => { restrictOwnAudio?: boolean; displaySurface?: string };
  getCapabilities?: () => { restrictOwnAudio?: boolean[] };
  stop: () => void;
};

/**
 * Remove mixer audio we know still contains the call, before publish.
 * Returns true when a track was removed.
 */
export function stripLeakedSystemAudioTracks(stream: MediaStream): boolean {
  const video = stream.getVideoTracks()[0] as RestrictOwnAudioTrack | undefined;
  const audioTracks = stream.getAudioTracks() as RestrictOwnAudioTrack[];
  if (audioTracks.length === 0) {
    return false;
  }
  let displaySurface: string | undefined;
  try {
    displaySurface = video?.getSettings?.()?.displaySurface;
  } catch {
    // Unknown surface: do not strip. Same rule as capturesSystemAudio.
  }
  let stripped = false;
  for (const track of audioTracks) {
    let restrictOwnAudio: boolean | undefined;
    let restrictOwnAudioCaps: boolean[] | undefined;
    try {
      const settings = track.getSettings?.();
      if (settings && "restrictOwnAudio" in settings) {
        restrictOwnAudio = settings.restrictOwnAudio;
      }
    } catch {
      // Omit.
    }
    try {
      const caps = track.getCapabilities?.()?.restrictOwnAudio;
      if (Array.isArray(caps)) {
        restrictOwnAudioCaps = caps;
      }
    } catch {
      // Omit.
    }
    if (
      !shouldStripLeakedSystemAudio({
        displaySurface,
        hasAudio: true,
        restrictOwnAudio,
        restrictOwnAudioCaps,
      })
    ) {
      continue;
    }
    stream.removeTrack(track as MediaStreamTrack);
    track.stop();
    stripped = true;
  }
  return stripped;
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
