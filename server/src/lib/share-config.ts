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
 * `serverId` is the server the call is in, absent for a DM call. A value that
 * is not a uuid is read as absent rather than refused: the answer is one
 * boolean the global flag already gives anybody, and a malformed id must not
 * cost somebody their share.
 */
export interface ShareConfig {
  desktopShareAudioNative: boolean;
}

const serverIdSchema = z.string().uuid();

export function shareConfigForServer(rawServerId: string | null): ShareConfig {
  const parsed = serverIdSchema.safeParse(rawServerId);
  return {
    desktopShareAudioNative: isEnabled("desktop_share_audio_native", {
      serverId: parsed.success ? parsed.data : null,
    }),
  };
}
