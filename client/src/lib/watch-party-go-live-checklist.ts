/**
 * The go-live checklist: everything that made a share fail on 2026-09-12,
 * said before it happens rather than diagnosed after the room is already
 * confused (postmortem B3).
 *
 * SEVEN ROWS, ONE WORTH SAYING BUT NEVER COMPUTING. "The film is playing"
 * has no signal this app can read — it is a reminder, drawn as plain copy by
 * the caller, never through this module. The five rows here (browser, tab
 * audio, quality, camera, mic) are the ones an actual state exists for, and
 * each maps to one failure:
 *
 *  - BROWSER. Firefox has neither `restrictOwnAudio` nor `preferCurrentTab`
 *    (`screen-capture-audio.ts`), so a Firefox share is a whole-screen share
 *    with no way to keep the call's own audio out of it and no way to steer
 *    the picker at a tab. There is no safe watch party on it, so this is the
 *    one row that BLOCKS. The desktop shell answers its own picker
 *    (`electron/lib/display-sources.js`) rather than the browser's, so it is
 *    judged on its own capability object — `canShareScreen` and
 *    `sharePickerOffersAudio` — instead of a user agent: an old binary
 *    predates the second flag and cannot promise tab audio, which is only a
 *    hint, not a block, because the host can still tick nothing and get a
 *    correct silent-film warning instead.
 *  - TAB AUDIO. The same fact `SetupStage`'s own "watch-party-no-audio"
 *    banner already shows once a capture is picked, folded into one row here
 *    so the checklist does not tell two different stories before and after
 *    the picker runs. `null` means nothing is picked yet: there is nothing to
 *    report, not a failure.
 *  - QUALITY. 1080p over a long, lossy path is what corrupted every viewer's
 *    picture the night this shipped (`watch-party-stream-quality.ts`); 720p
 *    is the row that needs nothing said about it.
 *  - CAMERA. A camera left on next to a tab share earns nothing from the
 *    audience (the transcode carries only the tab and its own audio) and
 *    spends uplink the tab share needed. `romulo910`-shaped confusion aside,
 *    it is a cost with no benefit, so it is a hint, not a block.
 *  - MIC (2026-09-13). A recording lost the host's voice for an hour because
 *    her mic stayed muted through the whole show; this is the same fact the
 *    checklist can already see (`micState`), stated as a real row instead of
 *    an unmuting reminder nobody could act on before the fact. A HARD row,
 *    not a soft one: always shown, an opinion rather than a maybe. Still a
 *    hint, not a block — a host who genuinely does not intend to talk (music
 *    only, reading chat) has done nothing wrong either.
 *
 * NON-BLOCKING EXCEPT ONE. `blocksGoLive` is true only when the browser row
 * is Firefox. Every other row may sit on "hint" for the whole show: a host
 * on 1080p who knows their uplink, one with the camera on for a
 * co-presenter the room can see, or one with the mic deliberately muted, has
 * not done anything wrong.
 */

import type { WatchPartyStreamQuality } from "./watch-party-stream-quality";

export type ChecklistTone = "ok" | "hint" | "block";

export type ChecklistItemId =
  | "browser"
  | "tabAudio"
  | "quality"
  | "camera"
  | "mic";

export interface ChecklistItem {
  id: ChecklistItemId;
  tone: ChecklistTone;
}

export interface GoLiveChecklistInput {
  isFirefox: boolean;
  isDesktopShell: boolean;
  /** The desktop shell's OWN capability object says it can do both. Irrelevant in a browser. */
  desktopSharesTabAudio: boolean;
  /** `null`: no capture picked yet, nothing to report. */
  hasAudioTrack: boolean | null;
  quality: WatchPartyStreamQuality;
  cameraOn: boolean;
  /** The ROOM microphone, not `hasAudioTrack` (the share's own audio). */
  micMuted: boolean;
}

export function goLiveChecklist(
  input: GoLiveChecklistInput,
): ChecklistItem[] {
  const items: ChecklistItem[] = [
    {
      id: "browser",
      tone: input.isFirefox
        ? "block"
        : input.isDesktopShell && !input.desktopSharesTabAudio
          ? "hint"
          : "ok",
    },
    {
      id: "quality",
      tone: input.quality === "1080p" ? "hint" : "ok",
    },
    {
      id: "camera",
      tone: input.cameraOn ? "hint" : "ok",
    },
    {
      id: "mic",
      tone: input.micMuted ? "hint" : "ok",
    },
  ];
  if (input.hasAudioTrack !== null) {
    items.splice(1, 0, {
      id: "tabAudio",
      tone: input.hasAudioTrack ? "ok" : "hint",
    });
  }
  return items;
}

/** Whether anything here should stop `onGoLive` from running at all. */
export function blocksGoLive(items: readonly ChecklistItem[]): boolean {
  return items.some((item) => item.tone === "block");
}

/**
 * Firefox, detected the way every other UA sniff in this codebase does it:
 * a substring match, guarded against SeaMonkey's UA also containing the
 * word (`Mozilla/5.0 ... Gecko/20100101 SeaMonkey/2.53 Firefox/102.0`-style
 * strings exist in the wild).
 */
export function isFirefoxUserAgent(userAgent: string): boolean {
  return /firefox\//i.test(userAgent) && !/seamonkey/i.test(userAgent);
}

/** The desktop shell's own capability object says both halves are covered. */
export function desktopSharesTabAudio(
  desktop:
    | { canShareScreen?: boolean; sharePickerOffersAudio?: boolean }
    | null
    | undefined,
): boolean {
  return (
    desktop?.canShareScreen === true && desktop?.sharePickerOffersAudio === true
  );
}
