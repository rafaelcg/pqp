import { useSyncExternalStore } from "react";

/**
 * Whether your mouse pointer rides along with a screen share.
 *
 * THE REPORT THIS FILE EXISTS FOR (QG, 5 Sep 2026, verbatim): "galera tô
 * streamando um filme pelo modo janela, porém o mouse fica aparecendo enquanto
 * mexo com ele... Estou stramando o filme em segundo plano, mas estou jogando.
 * Daí o mouse fica mexendo na janela compartilhada." A film shared from one
 * window, a game played in another, and the pointer drawn over the film every
 * time it moves. It is noise for the room and it leaks what he is doing
 * somewhere else.
 *
 * The two things people do with a share pull in opposite directions. Walking
 * somebody through something IS pointing at it, so the cursor is the content.
 * Watching a film together is the opposite: the cursor is the only thing on
 * screen that is not the film. One default cannot serve both, which is why
 * this is a preference and not a constant.
 *
 * WHAT THE PLATFORM ACTUALLY GIVES US, measured rather than assumed
 * (Playwright's Chromium 141, Firefox 153 and WebKit 26.5, 7 Sep 2026):
 *
 * - The Screen Capture spec has had a `cursor` constrainable property for
 *   years, `"always" | "motion" | "never"`, and NO SHIPPING ENGINE IMPLEMENTS
 *   IT. `navigator.mediaDevices.getSupportedConstraints()` lists no `cursor`
 *   in any of the three. Blink's `media_track_constraint_set.idl` has no such
 *   member, so Chromium drops it at the bindings layer before a capturer could
 *   ever see it; Gecko's `MediaTrackConstraintSet` and WebKit's are the same.
 *   WebKit was the one engine that would open a capture headlessly and it
 *   proved the shape of the failure: `getDisplayMedia({video:{cursor:"never"}})`
 *   succeeds, `track.getConstraints()` comes back `{}` with the member gone,
 *   and `applyConstraints({cursor:"never"})` RESOLVES and changes nothing.
 *   A promise that resolves is the worst possible answer, because it is
 *   indistinguishable from one that was kept.
 *
 * - Chromium composites the pointer unconditionally. `DesktopCaptureDevice`
 *   wraps every screen and every window capturer in a `DesktopAndCursorComposer`
 *   with no flag between it and the page, so a monitor or window share on
 *   Chrome, Edge or the Electron shell always carries the cursor. There is no
 *   route to it from JavaScript and none from Electron's
 *   `setDisplayMediaRequestHandler` either: the callback names a source, not a
 *   capture option, so the desktop app is in exactly the same position as the
 *   browser and needs no separate treatment.
 *
 * - A TAB capture carries no pointer at all. Chromium renders a tab share off
 *   the tab's own compositor rather than off the desktop, so the OS cursor is
 *   never drawn into it. This is not a workaround we invented, it is the one
 *   surface where "no cursor" is already true, and it is the surface watch
 *   party already asks for (`ScreenCaptureIntent.preferBrowserTab`).
 *
 * SO WHAT IS HONEST TO SHIP. Three parts, and the third is the one that
 * reaches the person who reported it today:
 *
 * 1. Ask. `screenCaptureOptions` puts the spec constraint on the video
 *    request, always, because an unknown constraint is specified to be
 *    ignored and this costs nothing. The day any engine implements it, every
 *    pqp client already asks for the right thing with no new build.
 * 2. Promise only where the engine says it can answer. `canControlShareCursor`
 *    reads `getSupportedConstraints().cursor`, which is false everywhere
 *    today. That is what gates a *live* change of the preference mid-share:
 *    `applyConstraints` on a running track is the right call and we will make
 *    it, but only when the answer means something, because WebKit showed that
 *    the call resolving proves nothing.
 * 3. Tell the truth against the surface that was actually picked. That is
 *    `cursorRidesAlong`, below, and it is what the presenter sees.
 *
 * WHY THE DEFAULT CANNOT DEPEND ON SCREEN VS WINDOW, which is the first thing
 * you want to do here: a window share really is the watch-together case far
 * more often than a whole-screen share is. But `getDisplayMedia` takes its
 * constraints BEFORE the picker opens and the surface is only known after it
 * closes, so "windows default to hidden" is not expressible as a default. It
 * is only expressible after the fact, which is where it lives: the notice
 * fires on a monitor or a window and never on a tab.
 */

/**
 * `show` and `hide`, not the spec's three.
 *
 * `"motion"` is a real value and it is the nicest of the three in principle,
 * the pointer visible while you are pointing and gone while you are not. It is
 * also a third state in a control that a person reads in half a second, for a
 * behaviour no engine performs, and telling somebody in the QG the difference
 * between "motion" and "always" costs more than it is worth. Two states map
 * onto the two things people are actually doing.
 */
export const SHARE_CURSORS = ["show", "hide"] as const;

export type ShareCursor = (typeof SHARE_CURSORS)[number];

/** The spec's `CursorCaptureConstraint`, as sent on the video request. */
export type CursorCaptureConstraint = "always" | "motion" | "never";

const STORAGE_KEY = "pqp:share-cursor";

/**
 * Shown, until somebody says otherwise.
 *
 * Presenting is the case where being wrong is expensive: a person walking
 * somebody through a settings page, pointing at a button, with no pointer, has
 * lost the share's whole point and has no idea why. Hiding it is the case
 * where being wrong is cheap, because the film plays either way. And today
 * `hide` cannot be delivered on the surfaces most people pick, so shipping it
 * as the default would be shipping a default that mostly does not happen.
 */
export const DEFAULT_SHARE_CURSOR: ShareCursor = "show";

/** Storage hands back `unknown`; this is the only door in. */
export function parseShareCursor(raw: unknown): ShareCursor | null {
  return SHARE_CURSORS.includes(raw as ShareCursor)
    ? (raw as ShareCursor)
    : null;
}

/** What goes on the video request for a given preference. */
export function cursorConstraintFor(
  preference: ShareCursor,
): CursorCaptureConstraint {
  return preference === "hide" ? "never" : "always";
}

/**
 * Does this engine claim it can honour the cursor constraint?
 *
 * False in every browser and in the Electron shell as of 7 Sep 2026 (see the
 * header). It gates the one thing that must not be offered on a guess:
 * changing the preference DURING a live share and having the picture change.
 * The preference itself is still offered, because it is a statement about what
 * the person wants and the app answers it either by asking the engine or by
 * saying it could not.
 */
export function canControlShareCursor(
  supported: MediaTrackSupportedConstraints & { cursor?: boolean } = readSupportedConstraints(),
): boolean {
  return supported.cursor === true;
}

function readSupportedConstraints(): MediaTrackSupportedConstraints & {
  cursor?: boolean;
} {
  try {
    return navigator.mediaDevices.getSupportedConstraints();
  } catch {
    // No `mediaDevices` at all. The caller is about to fail for a much larger
    // reason than a missing constraint; answering "no" is the safe shape.
    return {};
  }
}

/**
 * Is the pointer in THIS capture despite the person asking for it not to be?
 *
 * Answered from the surface the picker returned, not from what was asked for,
 * which is the same rule `capturesSystemAudio` follows and for the same
 * reason: it is the difference between a guess and a fact, and it is decided
 * at the one moment the presenter can still do something about it.
 *
 * `browser` is a tab and carries no pointer, so it is never a problem.
 * `monitor` and `window` always carry one on every engine that has no cursor
 * constraint. An ABSENT `displaySurface` counts as no on purpose: the engines
 * that omit it are not the ones this fires for, and a notice that cries wolf
 * on a share that is fine is a notice people stop reading.
 */
export function cursorRidesAlong(input: {
  /** `videoTrack.getSettings().displaySurface`, absent where the engine omits it. */
  displaySurface?: string | null;
  /** Whether the person asked for the pointer to be left out. */
  hideCursor: boolean;
  /** Whether the engine says it can honour the constraint. */
  canControl: boolean;
}): boolean {
  if (!input.hideCursor || input.canControl) {
    return false;
  }
  return input.displaySurface === "monitor" || input.displaySurface === "window";
}

let current: ShareCursor | null = null;
const listeners = new Set<(value: ShareCursor) => void>();

function ensureLoaded(): ShareCursor {
  if (current === null) {
    current = readStoredShareCursor() ?? DEFAULT_SHARE_CURSOR;
  }
  return current;
}

/** The choice remembered on this device, if the person ever made one. */
export function readStoredShareCursor(): ShareCursor | null {
  try {
    return parseShareCursor(localStorage.getItem(STORAGE_KEY));
  } catch {
    // Storage denied (privacy mode, an Electron partition without quota):
    // the default is the app working.
    return null;
  }
}

export function getShareCursor(): ShareCursor {
  return ensureLoaded();
}

/**
 * REMEMBERED, unlike the system-audio opt-in next to it.
 *
 * That one is session state on purpose because arming it can hurt the whole
 * room, and a preference set once for one game and forgotten costs everybody
 * else. This one cannot hurt anybody: the worst a remembered `hide` can do is
 * make a presenter point with words. And the person it is for shares a film
 * every night, so re-arming it every night is most of the complaint.
 */
export function setShareCursor(value: ShareCursor): void {
  const changed = ensureLoaded() !== value;
  current = value;
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // Not stored is still set for this session.
  }
  if (!changed) {
    return;
  }
  for (const listener of listeners) {
    listener(value);
  }
}

export function subscribeShareCursor(
  listener: (value: ShareCursor) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam: forget the in-memory copy so the next read hits storage again. */
export function resetShareCursorForTests(): void {
  current = null;
  listeners.clear();
}

export function useShareCursor(): ShareCursor {
  return useSyncExternalStore(subscribeShareCursor, getShareCursor);
}
