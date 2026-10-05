import { z } from "zod";
import { isEnabled } from "./flags.js";

/**
 * What the client needs to know before it opens a screen-share picker, and
 * that the operator can change without a deploy. Served by
 * `GET /api/share/config`, read per request.
 *
 * `desktopShareAudioNative`: the Windows desktop app may capture a share's
 * sound per process (WASAPI process loopback, `electron/lib/win-share-audio.js`)
 * instead of through Chromium's loopback, which is what gives Windows 10 sound
 * without the call. Runtime flag `desktop_share_audio_native`, default off,
 * `DESKTOP_SHARE_AUDIO_NATIVE` as its environment default, with a per-server
 * override so it can go on for one server at a time. The shell still has to
 * say it can (`capabilities.nativeShareAudio` plus its own self-test), so this
 * switch does nothing in a browser or in an older desktop build.
 *
 * `shareHighMotionGuard`: the presenter's client watches its own screen-share
 * encoder and steps the capture down (one resolution rung, then the frame rate,
 * then more resolution) when a game at a very high frame rate starves it, and the desktop app
 * raises the priority of its processes while a share is live. Runtime flag
 * `share_high_motion_guard`, default off, `SHARE_HIGH_MOTION_GUARD` as its
 * environment default, per-server override. Nothing else reads it: with it off
 * the client behaves exactly as before.
 *
 * `shareGameCaptureHint`: on the Windows desktop app, the presenter's client
 * samples its own share for the first minute and, when the picture is black
 * or no frames arrive (or the capture ends by itself) while Windows says a
 * Direct3D app holds the display in exclusive fullscreen, shows one card with
 * the fix (the game's "Fullscreen Windowed" / borderless mode). Runtime flag
 * `share_game_capture_hint`, default off, `SHARE_GAME_CAPTURE_HINT` as its
 * environment default, per-server override. Off, the client samples nothing
 * and asks the shell nothing. docs/DESKTOP.md §"Sharing a game: Fullscreen vs
 * Fullscreen Windowed".
 *
 * `linuxDesktopSystemAudio`: the Linux desktop app may carry the computer's
 * sound (minus the call) on a share. The shell builds the audio bus
 * (`electron/lib/linux-share-audio.js`) and this is the switch that lets the
 * page ask for it. Runtime flag `linux_desktop_system_audio`, default off,
 * `LINUX_DESKTOP_SYSTEM_AUDIO` as its environment default, GLOBAL only: the
 * client asks without a server and keeps one answer per page, so a per-server
 * override would never be read. The shell still has to say it can
 * (`capabilities.linuxShareAudio`) and the machine needs PulseAudio or
 * PipeWire, so this does nothing in a browser, on macOS or Windows, or in an
 * older desktop build.
 *
 * `serverId` is the server the call is in, absent for a DM call. A value that
 * is not a uuid is read as absent rather than refused: the answer is one
 * boolean the global flag already gives anybody, and a malformed id must not
 * cost somebody their share.
 */
export interface ShareConfig {
  desktopShareAudioNative: boolean;
  shareHighMotionGuard: boolean;
  shareGameCaptureHint: boolean;
  linuxDesktopSystemAudio: boolean;
}

const serverIdSchema = z.string().uuid();

export function shareConfigForServer(rawServerId: string | null): ShareConfig {
  const parsed = serverIdSchema.safeParse(rawServerId);
  const serverId = parsed.success ? parsed.data : null;
  return {
    desktopShareAudioNative: isEnabled("desktop_share_audio_native", { serverId }),
    shareHighMotionGuard: isEnabled("share_high_motion_guard", { serverId }),
    shareGameCaptureHint: isEnabled("share_game_capture_hint", { serverId }),
    linuxDesktopSystemAudio: isEnabled("linux_desktop_system_audio"),
  };
}
