"use strict";

/**
 * Everything about "which surface is being shared" that can be decided without
 * a display attached.
 *
 * The window that shows these to a human lives in `electron/picker/`; the code
 * that talks to `desktopCapturer` lives in `main.js`. This file is the part in
 * between, and it is here so it can be tested: CI has no screens, no windows
 * and no screen-recording permission, so any logic left inline in the handler
 * is logic nothing ever runs until a user runs it.
 */

/** Thumbnail size asked of `desktopCapturer`. */
const THUMBNAIL_SIZE = { width: 320, height: 200 };

/**
 * macOS Screen Recording pane, opened when permission is the thing standing in
 * the way. A URL rather than a sentence: "turn it on in System Settings" is
 * five clicks of hunting, and this is one.
 */
const MAC_SCREEN_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

/**
 * `desktopCapturer` ids are `screen:0:0` / `window:12345:0`. The prefix is the
 * only reliable way to tell a display from a window: names are localized by the
 * OS and a window can legitimately be called "Screen".
 */
function kindOf(id) {
  if (typeof id !== "string") {
    return null;
  }
  if (id.startsWith("screen:")) {
    return "screen";
  }
  if (id.startsWith("window:")) {
    return "window";
  }
  return null;
}

/**
 * A `NativeImage`, a data URL, or nothing.
 *
 * Images cannot cross IPC, so every thumbnail has to become a string before the
 * picker window can show it. An empty image is returned as `null` rather than
 * the 0x0 data URL Electron hands back, because the picker renders a labelled
 * placeholder for `null` and would otherwise render a broken `<img>`.
 */
function toDataUrl(image) {
  if (!image || typeof image.toDataURL !== "function") {
    return null;
  }
  let url;
  try {
    url = image.toDataURL();
  } catch {
    return null;
  }
  if (typeof url !== "string" || !url.startsWith("data:image/")) {
    return null;
  }
  // Electron's empty image serializes to a valid-but-blank PNG data URL. The
  // shortest real 320x200 thumbnail is far longer than this; anything at or
  // below it is the placeholder, not a picture.
  if (url.length < 64) {
    return null;
  }
  return url;
}

/**
 * Turn raw `desktopCapturer` sources into something the picker window can be
 * handed over IPC: plain data, screens before windows.
 *
 * Screens first because that is the thing most people mean, and the first tile
 * is the one pre-selected, so a one-monitor user presses Enter and shares the
 * only screen they have. Within each group the OS order is kept: on every
 * platform Electron lists the primary display first, and re-sorting would move
 * it.
 *
 * `name` is passed through as the OS gave it, including empty. `labelSources`
 * is what turns an empty one into something a person can read.
 */
function normalizeSources(sources) {
  const screens = [];
  const windows = [];
  for (const source of Array.isArray(sources) ? sources : []) {
    const kind = kindOf(source?.id);
    if (!kind) {
      continue;
    }
    const entry = {
      id: source.id,
      kind,
      name: typeof source.name === "string" ? source.name : "",
      thumbnail: toDataUrl(source.thumbnail),
      appIcon: kind === "window" ? toDataUrl(source.appIcon) : null,
    };
    (kind === "screen" ? screens : windows).push(entry);
  }
  return [...screens, ...windows];
}

/**
 * Give every surface the name it is shown under.
 *
 * Done here rather than in the picker window because naming needs i18next and
 * the picker window cannot have it: it is a `file://` page with no bundler,
 * and the web client's instance lives in a renderer it shares nothing with.
 * Building "Screen " + n in the picker instead would be a sentence assembled
 * from fragments, which is the one thing `docs/I18N.md` rules out.
 *
 * Screens are numbered within their own group: "Screen 2" has to mean the
 * second display, not the second tile on a page that also lists windows.
 *
 * `translate` is injected so this is testable without Electron on the path.
 */
function labelSources(normalized, translate) {
  let screenIndex = 0;
  return (Array.isArray(normalized) ? normalized : []).map((source) => {
    if (source.kind === "screen") {
      screenIndex += 1;
    }
    const given = typeof source.name === "string" ? source.name.trim() : "";
    if (given) {
      return { ...source, label: given };
    }
    const label =
      source.kind === "screen"
        ? translate("share.screenFallback", { index: screenIndex })
        : translate("share.windowFallback");
    return { ...source, label };
  });
}

/**
 * The one case where showing a picker is worse than not showing one.
 *
 * A list of exactly one surface offers no choice, so a dialog asking for one is
 * a click that can only ever produce the same answer. This is not the
 * single-monitor case (that machine still has windows). It is Wayland and the
 * portals that hand back one pre-picked surface, and the permission-less macOS
 * state where the only thing visible is our own window.
 */
function pickAutomatically(normalized) {
  if (!Array.isArray(normalized) || normalized.length !== 1) {
    return null;
  }
  return normalized[0].id;
}

/**
 * What macOS's screen-recording permission means for this attempt.
 *
 * `not-determined` is deliberately not "blocked": the first `getSources` call
 * is what makes macOS show its own permission prompt, so refusing before that
 * would mean the prompt never appears and the user can never grant it. Ask
 * first, then look again. `blocked` is only ever the answer we act on.
 *
 * Non-macOS platforms have no such gate. Windows and Linux either capture or
 * throw, and both of those are already handled where they happen.
 */
function screenPermission(platform, status) {
  if (platform !== "darwin") {
    return "ok";
  }
  if (status === "denied" || status === "restricted") {
    return "blocked";
  }
  if (status === "not-determined") {
    return "undetermined";
  }
  // "granted", "unknown", and anything a future macOS invents. `unknown` is
  // what older macOS reports for a capability it does not gate, and treating it
  // as blocked would take screen sharing away from people who have it.
  return "ok";
}

/**
 * The object Electron's display-media callback wants.
 *
 * Loopback audio is Windows-only in Chromium: asking for it anywhere else does
 * not degrade to a silent share, it fails the entire request, which is how a
 * share becomes "Could not start audio source" and hands over nothing at all.
 * It is also skipped when the page never asked for audio, so a video-only
 * request cannot be failed by an audio track nobody wanted.
 *
 * `audioRequested` is still the echo switch for *whether* Windows loopback
 * runs. This function must keep returning `"loopback"` when it is true, not a
 * homemade device id: that string is what Electron documents, and from 43.4.0
 * the embedder remaps it to `loopbackWithoutChrome` when the page asked
 * `getDisplayMedia({ audio: { restrictOwnAudio: true } })`. That device is
 * WASAPI process-loopback excluding this app's tree, which is the 23 Aug 2026
 * report (the call playing in this window, sent back into the call). Passing
 * `"loopbackWithoutChrome"` here is not a supported callback value.
 *
 * The renderer still sends `audio: false` unless the user opted in
 * (`client/src/lib/screen-capture-audio.ts`). A shell that never asked for
 * audio cannot be failed by an audio track, and a v0.1.3 install that has
 * not taken this binary still needs that off switch. This picker lists
 * screens and windows, never tabs, so there is no tab-audio path for
 * `audio: false` to take away.
 *
 * Do not "helpfully" default this to loopback. A true `audioRequested` is a
 * statement that a human ticked something, and it is the only such statement
 * this function will ever get. Keep macOS and Linux video-only: loopback
 * there still fails the whole request.
 */
function captureResponse(source, platform, audioRequested) {
  if (!source) {
    return null;
  }
  if (platform === "win32" && audioRequested) {
    return { video: source, audio: "loopback" };
  }
  return { video: source };
}

module.exports = {
  THUMBNAIL_SIZE,
  MAC_SCREEN_SETTINGS_URL,
  kindOf,
  toDataUrl,
  normalizeSources,
  labelSources,
  pickAutomatically,
  screenPermission,
  captureResponse,
};
