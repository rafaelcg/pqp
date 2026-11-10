import type { JamTrack } from "@pqp/shared";
import { ChevronRight, Loader2, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { JamEngine } from "@/lib/jam";
import { useTranslation } from "@/lib/i18n";
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
import { EditFields } from "./jam-studio-parts";

/**
 * "Ajustar" on the author's own posted track: the same trim, nudge and volume the
 * review has, applied to a track that is already on the song (the contract lets
 * a track's author change its offset, trims and gain). Moving a slider is heard
 * at once through the engine; nothing is sent until "Guardar", and "Voltar" puts
 * the stored numbers back.
 */
export function TrackAdjust({
  track,
  engine,
  onSave,
}: {
  track: JamTrack;
  engine: JamEngine | null;
  onSave: (patch: TrackPatch) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [edits, setEdits] = useState<TakeEdits>(() => editsFromTrack(track));
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  // The stored numbers moved (a save landed, or a frame came): start from them.
  // Not while a save is out: the controls are locked then (`inert` below), and the
  // numbers that come back are the ones just saved; the effect runs again when the
  // save settles.
  useEffect(() => {
    if (!busy) {
      setEdits(editsFromTrack(track));
    }
  }, [busy, track.id, track.offsetMs, track.trimStartMs, track.trimEndMs, track.gain]); // eslint-disable-line react-hooks/exhaustive-deps -- the numbers ARE the dependency

  const recorded = { offsetMs: track.offsetMs, trimStartMs: 0, trimEndMs: track.trimEndMs, durationMs: track.durationMs };
  const patch = patchFor(track, edits);
  const dirty = Object.keys(patch).length > 0;

  function hear(next: TakeEdits) {
    setEdits(next);
    setFailed(false);
    engine?.player.updateStem(track.id, {
      offsetMs: track.offsetMs + next.nudgeMs,
      trimStartMs: next.trimStartMs,
      trimEndMs: next.trimEndMs,
      gain: next.gain,
    });
  }

  async function save() {
    setBusy(true);
    setFailed(false);
    try {
      await onSave(patch);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="group text-xs" data-jam-adjust={track.id}>
      <summary className="flex h-10 cursor-pointer list-none items-center gap-1.5 font-semibold text-text-secondary outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-focus-ring [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-3.5 w-3.5 transition-transform duration-[var(--duration-base)] group-open:rotate-90" aria-hidden />
        {t("jam.review.edit")}
      </summary>
      <div className="grid gap-4 pb-2 pt-1">
        <div inert={busy} aria-busy={busy} className={busy ? "opacity-60" : undefined}>
        <EditFields
          take={recorded}
          edits={edits}
          onTrimStart={(ms) => hear(withTrimStart(recorded, edits, ms))}
          onTrimEnd={(ms) => hear(withTrimEnd(recorded, edits, ms))}
          onNudge={(ms) => hear(withNudge(edits, ms))}
          onGain={(gain) => hear(withGain(edits, gain))}
        />
        </div>
        {failed && (
          <p role="alert" className="rounded-[var(--radius-control)] bg-danger-soft px-2.5 py-2 text-on-danger-soft">
            {t("jam.error.other")}
          </p>
        )}
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" className="gap-1.5" disabled={!dirty || busy} onClick={() => hear(editsFromTrack(track))}>
            <RotateCcw className="h-3.5 w-3.5" aria-hidden />
            {t("jam.take.adjustBack")}
          </Button>
          <Button size="sm" disabled={!dirty || busy} onClick={() => void save()} data-jam-adjust-save="" className="gap-1.5">
            {busy && <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden />}
            {t("jam.take.adjustSave")}
          </Button>
        </div>
      </div>
    </details>
  );
}
