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
 * Adjusting the author's own posted track: the same clip editor the studio has,
 * on a track that is already on the song (the contract lets a track's author
 * change its offset, trims and gain). Every drag is heard at once through the
 * engine; nothing is sent until "Guardar", and "Desfazer" puts the stored
 * numbers back.
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
  /** Which track this is, said in the box itself ("Ajustando tua guitarra"). */
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
        engine?.player.updateStem(stored.id, {
          offsetMs: stored.offsetMs,
          trimStartMs: stored.trimStartMs,
          trimEndMs: stored.trimEndMs,
        });
      }
    },
    [engine],
  );

  // Opened below the lanes: brought into view with its buttons, not left under the dock.
  const box = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    box.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
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

  return (
    <div
      ref={box}
      className="jam-drop-in flex flex-col gap-3 rounded-[var(--radius-card)] bg-surface-2 p-3.5 ring-1 ring-inset ring-border"
      data-jam-adjust={track.id}
      onKeyDown={(event) => {
        // Escape closes the editor (putting back what is stored), never the song under it.
        if (event.key === "Escape") {
          event.stopPropagation();
          if (dirty) {
            hear(editsFromTrack(track));
          }
          onDone();
        }
      }}
    >
      <div className="flex items-center justify-end gap-2 border-b border-border pb-3">
        <p className="mr-auto min-w-0 truncate text-sm font-bold text-text" data-jam-adjust-title="">
          {title}
        </p>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            if (dirty) {
              hear(editsFromTrack(track));
            }
            onDone();
          }}
          disabled={busy}
          data-jam-adjust-close=""
        >
          {dirty ? t("jam.take.adjustBack") : t("jam.song.close")}
        </Button>
        <Button size="sm" disabled={!dirty || busy} onClick={() => void save()} data-jam-adjust-save="" className="gap-1.5 rounded-full px-4">
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden />
          ) : saved ? (
            <Check className="h-3.5 w-3.5" aria-hidden />
          ) : null}
          {t("jam.take.adjustSave")}
        </Button>
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
