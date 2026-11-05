"use strict";

/**
 * The computer's sound on a screen share from the macOS desktop app.
 *
 * WHAT IS ACTUALLY DOING THE WORK. Nothing in this file touches audio. Since
 * Electron 39 Chromium captures macOS system audio through Apple's CoreAudio
 * Tap (`audio: "loopback"` in the display-media callback), on macOS 14.2 and
 * newer. This shell asks for it only when the page has asked with
 * `restrictOwnAudio: true`, and Electron then remaps the request to
 * `loopbackWithoutChrome` (`electron_browser_context.cc`, the `IS_MAC`
 * branch). Chromium's tap for that device is built with
 * `initStereoGlobalTapButExcludeProcesses:` over the audio objects of ITS OWN
 * audio-service process (`catap_audio_input_stream.mm`,
 * `ExcludeChromeLoopback`), and every sound this app plays (the call, the
 * notification chime) is rendered by that process. So the call stays out of
 * the share without the shell doing any routing, unlike Linux.
 *
 * What this file owns is the small contract around it, the same shape as
 * `linux-share-audio.js`:
 *
 * - `supported()`: this is macOS and new enough. Below 14.2 Chromium has no
 *   tap and a loopback request fails the WHOLE capture, picture included, so
 *   the answer decides whether the page may ask at all.
 * - `arm()` / `consumeArm()`: the page arms right before a share it has asked
 *   the person about, with the runtime flag on. A request that merely carries
 *   `audioRequested` (a console probe, a page from before this) is never
 *   answered with loopback, so a stale or hostile frame cannot make the
 *   shell tap the machine's sound. One arm is good for the next request
 *   only, and expires, so an arm that never got its request (the page threw
 *   in between) cannot leak into a share five minutes later.
 *
 * THE FAILURE THIS CANNOT SEE, AND WHERE IT IS HANDLED. The tap is gated by
 * the "System Audio Recording" privacy permission, which Electron cannot
 * query. Chromium probes the tap when it opens it; a denied or still
 * undecided grant either fails the open (the whole capture rejects with
 * `NotReadableError`, which `share-silent-retry.js` already turns into the
 * same share without sound) or leaves a track that is created `ended` and
 * never delivers samples (Electron's own docs). The page watches for both
 * and tells the presenter, with a button that opens the right Settings pane
 * (`MAC_AUDIO_SETTINGS_URL`).
 */

const { macVersionAllowsSystemAudio } = require("./display-sources");

/**
 * How long an arm waits for its display request. The page arms and calls
 * `getDisplayMedia` in the same tick of work; this is only the bound on a
 * dangling arm.
 */
const ARM_WINDOW_MS = 30_000;

function createMacShareAudio({
  platform = process.platform,
  getSystemVersion = () => process.getSystemVersion?.() ?? "",
  now = Date.now,
  armWindowMs = ARM_WINDOW_MS,
} = {}) {
  let armedAt = null;

  function version() {
    try {
      return String(getSystemVersion() ?? "");
    } catch {
      return "";
    }
  }

  function supported() {
    return platform === "darwin" && macVersionAllowsSystemAudio(version());
  }

  return {
    supported,
    /** `{ supported, version }` for the page's one pre-share question. */
    status() {
      return { supported: supported(), version: platform === "darwin" ? version() : null };
    },
    /** The page is about to ask for sound. False off macOS or below 14.2. */
    arm() {
      if (!supported()) {
        armedAt = null;
        return false;
      }
      armedAt = now();
      return true;
    },
    /** One-shot: true only for the request that follows a fresh arm. */
    consumeArm() {
      const fresh = armedAt !== null && now() - armedAt <= armWindowMs;
      armedAt = null;
      return fresh && supported();
    },
  };
}

module.exports = { createMacShareAudio, ARM_WINDOW_MS };
