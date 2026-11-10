import type { JamInstrument, JamSongSummary, JamTrack } from "@pqp/shared";
import { JAM_INSTRUMENT_ORDER } from "@/lib/jam-instruments";
import { songNeed } from "@/lib/jam-wall";

/**
 * What the studio pre-selects: the instrument the song is asking for, so the
 * common case is no choice at all. Never an instrument the viewer may not add
 * (`addable`, from `viewer.addableInstruments`), never one they have already
 * got a take of if something else is open to them.
 */
export function pickInstrument(
  song: Pick<JamSongSummary, "joinMode" | "wantedInstruments" | "instruments" | "trackCount">,
  addable: readonly JamInstrument[],
  mine: readonly Pick<JamTrack, "instrument">[] = [],
): JamInstrument | null {
  if (addable.length === 0) {
    return null;
  }
  const allowed = new Set(addable);
  const need = songNeed(song);
  if (need.kind === "missing") {
    const wanted = need.instruments.find((instrument) => allowed.has(instrument));
    if (wanted) {
      return wanted;
    }
  }
  const mineSet = new Set(mine.map((track) => track.instrument));
  const onSong = new Set(song.instruments);
  const ordered = JAM_INSTRUMENT_ORDER.filter((instrument) => allowed.has(instrument));
  return (
    ordered.find((instrument) => !onSong.has(instrument) && !mineSet.has(instrument)) ??
    ordered.find((instrument) => !mineSet.has(instrument)) ??
    ordered[0] ??
    null
  );
}

/** Why a viewer who may not record sees no button, in the order the reasons are checked. */
export type JamCannotRecordReason = "off" | "uploadsOff" | "closed" | "other";

export function cannotRecordReason(input: {
  enabled: boolean;
  uploads: boolean;
  addable: readonly JamInstrument[];
  joinMode: JamSongSummary["joinMode"];
}): JamCannotRecordReason | null {
  if (!input.enabled) {
    return "off";
  }
  if (!input.uploads) {
    return "uploadsOff";
  }
  if (input.addable.length === 0) {
    return input.joinMode === "closed" ? "closed" : "other";
  }
  return null;
}
