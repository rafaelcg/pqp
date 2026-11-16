/**
 * "Invalid capture constraints" in the desktop app is the shell saying no.
 *
 * The string is Chromium's: `INVALID_DISPLAY_CAPTURE_CONSTRAINTS` in
 * `user_media_processor.cc`. Electron 44 answers EVERY `callback(null)` from
 * `setDisplayMediaRequestHandler` with that code (`electron_browser_context.cc`,
 * `DisplayMediaDeviceChosen`; reproduced on 44.9.1: null, undefined and `{}`
 * all reject as `AbortError: Invalid capture constraints`). So a Cancel in the
 * shell's picker, a picker that never loaded (0.2.8), a second request while
 * the picker is open, a window that closed before it could be handed over and
 * an error inside the handler all reach the page as one AbortError with one
 * English sentence, and nothing about the page's constraints is involved:
 * the page asks for `ideal` and `max` only, which cannot fail this way.
 *
 * `startScreenShare` printed that sentence as the error, because its message
 * table had no AbortError branch. Each earlier fix removed one cause (the tab
 * steer on 13 Sep 2026, the asar fuse on 27 Oct 2026) and left the sentence,
 * so the next cause, or a plain Cancel, showed it again to a Windows 11
 * desktop user on 16 Nov 2026.
 *
 * A shell with `capabilities.shareRefusalReason` says which refusal it was
 * (`electron/lib/share-refusal.js`). An older one cannot, and then the page
 * says plainly that the share did not start. Retrying with smaller
 * constraints would not help (they were never the cause) and would put a
 * second picker in front of somebody who may just have cancelled the first.
 */

import type { PqpDesktop } from "./desktop";
import { reportFaroEvent } from "./faro";
import type { MessageKey } from "./i18n";
import type { ScreenCaptureOptions } from "./screen-capture-audio";

/** What the shell can say (`SHARE_REFUSAL_REASONS` in `electron/lib/share-refusal.js`). */
export const SHELL_REFUSAL_REASONS = [
  "cancelled",
  "busy",
  "picker-failed",
  "no-sources",
  "permission",
  "source-gone",
  "origin",
  "error",
] as const;

/** A shell reason, or `unknown` for a shell too old to give one. */
export type ShellRefusal = (typeof SHELL_REFUSAL_REASONS)[number] | "unknown";

const INVALID_CAPTURE_CONSTRAINTS = /invalid capture constraints/i;

/**
 * The refusal behind a failed desktop `getDisplayMedia`, or null when the
 * failure is not one (a browser, or any error but the shell's AbortError).
 * Asks the shell once, which also spends its answer.
 */
export async function readShellRefusal(
  err: unknown,
  isDesktopShell: boolean,
  desktop: Pick<PqpDesktop, "capabilities" | "shareRefusalReason"> | null | undefined,
): Promise<ShellRefusal | null> {
  // By shape, not `instanceof Error`: the rejection is a DOMException, and
  // whether that passes `instanceof Error` is the engine's business.
  const shaped =
    typeof err === "object" && err !== null
      ? (err as { name?: unknown; message?: unknown })
      : null;
  if (!isDesktopShell || shaped?.name !== "AbortError") {
    return null;
  }
  const message = typeof shaped.message === "string" ? shaped.message : "";
  let reason: unknown = null;
  if (
    desktop?.capabilities?.shareRefusalReason === true &&
    typeof desktop.shareRefusalReason === "function"
  ) {
    try {
      reason = await desktop.shareRefusalReason();
    } catch {
      reason = null;
    }
  }
  if (typeof reason === "string") {
    return (SHELL_REFUSAL_REASONS as readonly string[]).includes(reason)
      ? (reason as ShellRefusal)
      : "error";
  }
  return INVALID_CAPTURE_CONSTRAINTS.test(message) ? "unknown" : null;
}

/**
 * The sentence for a refusal, or null for the person closing the picker,
 * which is their answer and not a failure. `no-sources` and `permission`
 * get the short line because the shell already put a dialog up saying why.
 */
export function shellRefusalMessageKey(refusal: ShellRefusal): MessageKey | null {
  switch (refusal) {
    case "cancelled":
      return null;
    case "busy":
      return "voice.error.sharePickerBusy";
    case "picker-failed":
      return "voice.error.sharePickerFailed";
    case "source-gone":
      return "voice.error.shareSourceGone";
    case "unknown":
      return "voice.error.shareShellRefused";
    default:
      return "voice.error.shareFailed";
  }
}

/** The request, reduced to what decides a capture, for the log line. */
export function describeCaptureRequest(options: ScreenCaptureOptions): string {
  const video = typeof options.video === "object" && options.video !== null ? options.video : null;
  const range = (value: unknown): string => {
    if (typeof value !== "object" || value === null) {
      return String(value ?? "-");
    }
    const { ideal, max } = value as { ideal?: unknown; max?: unknown };
    return `${ideal ?? "-"}/${max ?? "-"}`;
  };
  return [
    `video=${video ? "constrained" : String(options.video)}`,
    `fps=${range(video?.frameRate)}`,
    `w=${range(video?.width)}`,
    `h=${range(video?.height)}`,
    `audio=${options.audio === false ? "no" : "yes"}`,
    `systemAudio=${options.systemAudio ?? "-"}`,
  ].join(" ");
}

/**
 * Say it out loud, every time: the console (the desktop app's own log) and a
 * Faro event, so the next "Invalid capture constraints" report arrives with
 * which refusal it was, which shell and what was asked. Never the message
 * text of anything but Chromium's own error, never who.
 */
export function reportShellRefusal(
  refusal: ShellRefusal,
  context: {
    options: ScreenCaptureOptions;
    shellVersion: string | null | undefined;
    platform: string | null | undefined;
    surface: "call" | "watch-party";
  },
): void {
  const request = describeCaptureRequest(context.options);
  const line = {
    refusal,
    shellVersion: context.shellVersion ?? "unknown",
    platform: context.platform ?? "unknown",
    surface: context.surface,
    request,
  };
  console.warn(
    refusal === "cancelled"
      ? "[share] the desktop picker was closed without a choice"
      : "[share] the desktop shell refused the capture",
    line,
  );
  reportFaroEvent("share_shell_refused", line);
}
