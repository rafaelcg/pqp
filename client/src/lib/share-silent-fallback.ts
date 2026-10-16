/**
 * PQP-31: when a desktop share fails because its computer sound would not
 * open, share the same surface without sound instead of sharing nothing.
 *
 * Chromium rejects the WHOLE capture when the loopback device fails
 * (`NotReadableError`, "Could not start audio source"), picture included,
 * and it does so after the shell has already answered with a surface. A shell
 * with `capabilities.silentRetry` remembered that surface; arming it makes the
 * next video-only request reuse it, so no second picker opens
 * (`electron/lib/share-silent-retry.js`).
 *
 * Desktop only. In a browser a retry opens the picker again after the first
 * one spent the click's activation, so the browser keeps the explicit
 * "Compartilhar sem som" button, and so does a shell built before this.
 */

import type { PqpDesktop } from "./desktop";
import type { ScreenCaptureEnvironment, ScreenCaptureOptions } from "./screen-capture-audio";

export interface SilentShareRetryInput {
  err: unknown;
  /** What the failed request asked for. */
  options: ScreenCaptureOptions;
  env: Pick<ScreenCaptureEnvironment, "isDesktopShell">;
  desktop: Pick<PqpDesktop, "capabilities" | "shareSilentRetryArm"> | null | undefined;
  getDisplayMedia: (options: ScreenCaptureOptions) => Promise<MediaStream>;
}

/**
 * Streams this module opened after the sound failed. The watch party preview
 * opens its capture itself and hands it to the call at go-live, so the call
 * learns from the stream, not from a flag threaded through both surfaces.
 */
const lostSound = new WeakSet<MediaStream>();

/** Whether `stream` is a capture that went out silent because its sound failed. */
export function lostSoundToFailure(stream: MediaStream | null | undefined): boolean {
  return stream ? lostSound.has(stream) : false;
}

/** The same request with every way of asking for sound taken out. */
export function silentRetryOptions(options: ScreenCaptureOptions): ScreenCaptureOptions {
  return { ...options, audio: false, systemAudio: "exclude" };
}

/**
 * Whether this failure is one the shell can take back silently. Only
 * `NotReadableError`, the name Chromium gives a source that would not start
 * after the shell answered. Anything else (a cancelled picker, a refused
 * shape, a capture aborted) is not a sound failure and keeps its own path,
 * and a request that asked for no audio cannot have failed on it.
 */
export function canRetryShareWithoutSound(
  input: Pick<SilentShareRetryInput, "err" | "options" | "env" | "desktop">,
): boolean {
  return (
    input.env.isDesktopShell &&
    input.options.audio !== false &&
    input.err instanceof Error &&
    input.err.name === "NotReadableError" &&
    input.desktop?.capabilities?.silentRetry === true &&
    typeof input.desktop.shareSilentRetryArm === "function"
  );
}

/**
 * The silent stream, or null when there is nothing to retry (old shell, the
 * failed request did not carry loopback, or the retry failed too). Null
 * leaves the caller on its existing error path.
 */
export async function retryShareWithoutSound(
  input: SilentShareRetryInput,
): Promise<MediaStream | null> {
  if (!canRetryShareWithoutSound(input)) {
    return null;
  }
  let armed = false;
  try {
    armed = (await input.desktop?.shareSilentRetryArm?.()) === true;
  } catch {
    return null;
  }
  if (!armed) {
    return null;
  }
  try {
    const stream = await input.getDisplayMedia(silentRetryOptions(input.options));
    if (typeof stream === "object" && stream !== null) {
      lostSound.add(stream);
    }
    return stream;
  } catch (retryErr) {
    console.warn("[share] silent retry failed", retryErr);
    return null;
  }
}
