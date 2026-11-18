import type { JamTrack } from "@pqp/shared";
import { Check, Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { JamClock } from "@/hooks/use-jam-playback";
import type { JamEngine } from "@/lib/jam";
import { useTranslation } from "@/lib/i18n";
import type { BandLane, ClipSource } from "@/lib/jam-clip";
import {
  editsFromTrack,
  patchFor,
  withGain,
  withNudge,
  withTrimEnd,
  withTrimStart,
  type TakeEdits,
  type TrackPatch,
} from "@/lib/jam-take-edit";
import { JamClipEditor } from "./jam-clip-editor";

/**
 * Adjusting the author's own posted recording: the same clip editor the studio
 * has, on a recording that is already on the song (the contract lets its author
 * change its offset, trims and gain). It is drawn right under the lane it edits.
 * Every drag is heard at once through the engine; NOTHING is sent until
 * "Guardar", and the box says so. Save and close live in a footer that sticks to
 * the bottom of the scroll area, so they are in reach however tall the editor is.
 */
export function TrackAdjust({
  track,
  title,
  band,
  engine,
  clock,
  previewGain,
  onSave,
  onDone,
}: {
  track: JamTrack;
  /** Which recording this is, said in the box itself ("Ajustando tua gravação de guitarra"). */
  title: string;
  /** The other in-mix lanes, drawn behind. */
  band: readonly BandLane[];
  engine: JamEngine | null;
  clock?: JamClock;
  /** Hears the volume before it is stored (see `useJamPlayback`); `null` puts the stored one back. */
  previewGain: (trackId: string, gain: number | null) => void;
  onSave: (patch: TrackPatch) => Promise<void>;
  /** Close the editor (after a save, or "Fechar"). */
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [edits, setEdits] = useState<TakeEdits>(() => editsFromTrack(track));
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [saved, setSaved] = useState(false);

  // The stored numbers moved (a save landed, or a frame came): start from them.
  // Not while a save is out, and only when they really moved: a save that FAILED
  // leaves them as they were, and the person's edits stay for another try.
  const stored = [track.id, track.offsetMs, track.trimStartMs, track.trimEndMs, track.gain].join(":");
  const shown = useRef(stored);
  useEffect(() => {
    if (!busy && shown.current !== stored) {
      shown.current = stored;
      setEdits(editsFromTrack(track));
      previewGain(track.id, null);
    }
  }, [busy, stored]); // eslint-disable-line react-hooks/exhaustive-deps -- `stored` carries the track's numbers

  // The recorded head is not known for a posted track, so a cut may go back to 0.
  const source: ClipSource = useMemo(
    () => ({ baseOffsetMs: track.offsetMs, durationMs: track.durationMs, minTrimStartMs: 0 }),
    [track.offsetMs, track.durationMs],
  );
  const recorded = { offsetMs: track.offsetMs, trimStartMs: 0, trimEndMs: track.trimEndMs, durationMs: track.durationMs };
  const patch = patchFor(track, edits);
  const dirty = Object.keys(patch).length > 0;

  function hear(next: TakeEdits) {
    setEdits(next);
    setFailed(false);
    setSaved(false);
    engine?.player.updateStem(track.id, {
      offsetMs: track.offsetMs + next.nudgeMs,
      trimStartMs: next.trimStartMs,
      trimEndMs: next.trimEndMs,
    });
    // The volume goes through the mix the playback hook owns, not straight to the
    // engine: a mute or a frame arriving mid-drag rewrites every stem's volume.
    previewGain(track.id, next.gain);
  }

  // Leaving with unsaved edits puts what is stored back in the engine.
  const latest = useRef({ dirty, track });
  /** A save landed: what the engine plays IS what is stored now, so closing restores nothing. */
  const committed = useRef(false);
  latest.current = { dirty, track };
  const preview = useRef(previewGain);
  preview.current = previewGain;
  useEffect(
    () => () => {
      const { dirty: unsaved, track: stored } = latest.current;
      // The preview is dropped either way: after a save the stored volume IS it.
      preview.current(stored.id, null);
      if (unsaved && !committed.current) {
        // The gain is put back here too, and synchronously: the playback hook's own mix
        // effect writes it on the next render, but when the whole panel goes away under a
        // studio (the song was deleted mid-recording) the engine's stems stay and that
        // effect does not, so an unsaved preview would otherwise stay on the stem.
        engine?.player.updateStem(stored.id, {
          offsetMs: stored.offsetMs,
          trimStartMs: stored.trimStartMs,
          trimEndMs: stored.trimEndMs,
          gain: stored.gain,
        });
      }
    },
    [engine],
  );

  // Opened under its lane: brought into view once the lane has finished growing (it
  // starts at no height), with margins that clear the sticky transport above and the dock below.
  const box = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const calm = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const timer = window.setTimeout(
      // The top of the editor goes just under the sticky transport: its Save and Close live in its header.
      () => box.current?.scrollIntoView?.({ block: "start", behavior: calm ? "auto" : "smooth" }),
      calm ? 0 : 300,
    );
    return () => window.clearTimeout(timer);
  }, []);

  async function save() {
    setBusy(true);
    setFailed(false);
    try {
      await onSave(patch);
      committed.current = true;
      setSaved(true);
      onDone();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  const close = () => {
    if (dirty) {
      hear(editsFromTrack(track));
    }
    onDone();
  };

  return (
    <div
      ref={box}
      className="flex scroll-mt-[6.75rem] flex-col gap-3 rounded-[var(--radius-card)] bg-surface-2 p-3.5 ring-1 ring-inset ring-border"
      data-jam-adjust={track.id}
      onKeyDown={(event) => {
        // Escape closes the editor (putting back what is stored), never the song under it.
        if (event.key === "Escape") {
          event.stopPropagation();
          close();
        }
      }}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2" data-jam-adjust-header="">
        <div className="flex min-w-0 flex-1 basis-[12rem] flex-col gap-0.5">
          <p className="min-w-0 text-sm font-bold text-text [text-wrap:balance]" data-jam-adjust-title="">
            {title}
          </p>
          <p className="text-xs text-text-secondary [text-wrap:pretty]" data-jam-adjust-note="">
            {t("jam.take.adjustNote")}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="sm" className="pointer-coarse:h-11" onClick={close} disabled={busy} data-jam-adjust-close="">
            {dirty ? t("jam.take.adjustBack") : t("jam.song.close")}
          </Button>
          <Button
            size="sm"
            disabled={!dirty || busy}
            onClick={() => void save()}
            data-jam-adjust-save=""
            className="gap-1.5 rounded-full px-4 pointer-coarse:h-11 disabled:bg-surface-3 disabled:text-text-tertiary disabled:opacity-100"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden />
            ) : saved ? (
              <Check className="h-3.5 w-3.5" aria-hidden />
            ) : null}
            {t("jam.take.adjustSave")}
          </Button>
        </div>
      </div>
      <div inert={busy} aria-busy={busy} className={busy ? "opacity-60" : undefined}>
        <JamClipEditor
          instrument={track.instrument}
          peaks={track.peaks}
          source={source}
          edits={edits}
          band={band}
          clock={clock}
          onTrimStart={(ms) => hear(withTrimStart(recorded, edits, ms))}
          onTrimEnd={(ms) => hear(withTrimEnd(recorded, edits, ms))}
          onNudge={(ms) => hear(withNudge(edits, ms))}
          onGain={(gain) => hear(withGain(edits, gain))}
          onReset={() => hear(editsFromTrack(track))}
          edited={dirty}
        />
      </div>
      {failed && (
        <p role="alert" className="rounded-[var(--radius-control)] bg-danger-soft px-2.5 py-2 text-xs text-on-danger-soft">
          {t("jam.error.other")}
        </p>
      )}
    </div>
  );
}
