import type { JamPublicConsent, JamTrack } from "@pqp/shared";
import { Ear, Pause } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { JAM_INSTRUMENT_LOOK } from "@/lib/jam-instruments";
import { jamPublicErrorKind } from "@/lib/jam-public-api";
import { cn } from "@/lib/utils";

/**
 * The small pieces of public jams that more than one screen draws: the three
 * answers a person gives for their parts, and the starter's list of outside
 * takes. Plain rows of text and buttons; the lanes above and below carry the
 * colour.
 */

/**
 * "Pode ir", "Só o áudio", "Não". One answer for every part the person has in
 * the song; it can be changed later, so none of them is a trap.
 */
export function JamConsentChoices({
  onChoose,
  busy = false,
  className,
  current,
}: {
  onChoose: (choice: JamPublicConsent) => void;
  busy?: boolean;
  className?: string;
  /** The answer given already: it is the pressed one, so changing it is a plain choice among three. */
  current?: JamPublicConsent;
}) {
  const pick = (value: JamPublicConsent) => (current === undefined ? undefined : current === value);
  const { t } = useTranslation();
  return (
    <div role="group" aria-label={t("jam.public.consent.legend")} className={cn("flex flex-wrap items-center gap-2", className)}>
      <Button size="sm" className="pointer-coarse:h-11" variant={current === "yes" ? "default" : "secondary"} aria-pressed={pick("yes")} disabled={busy} onClick={() => onChoose("yes")} data-jam-consent="yes">
        {t("jam.public.consent.yes")}
      </Button>
      <Button size="sm" className="pointer-coarse:h-11" variant={current === "audio_only" ? "default" : "secondary"} aria-pressed={pick("audio_only")} disabled={busy} onClick={() => onChoose("audio_only")} data-jam-consent="audio_only">
        {t("jam.public.consent.audioOnly")}
      </Button>
      <Button size="sm" className="pointer-coarse:h-11" variant={current === "no" ? "default" : "secondary"} aria-pressed={pick("no")} disabled={busy} onClick={() => onChoose("no")} data-jam-consent="no">
        {t("jam.public.consent.no")}
      </Button>
    </div>
  );
}

/** Answer and say so when it fails; shared by the strip and the dialog. */
export function useConsentAnswer(answer: (songId: string, choice: JamPublicConsent) => Promise<void>) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function choose(songId: string, choice: JamPublicConsent) {
    setBusy(true);
    setError(null);
    try {
      await answer(songId, choice);
    } catch (failure) {
      setError(t(`jam.public.error.${jamPublicErrorKind(failure)}` as MessageKey));
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, choose };
}

/**
 * Takes from outside the song, waiting for the starter. Each is heard in
 * context (in place of the same instrument, with the rest of the band playing),
 * then put in the mix or declined. They sit in their own section instead of the
 * band's lanes because they are a question, not part of the song yet.
 */
export function JamPublicRequests({
  takes,
  auditioning,
  playing,
  busyId,
  onListen,
  onAccept,
  onDecline,
}: {
  takes: readonly JamTrack[];
  auditioning: string | null;
  playing: boolean;
  busyId: string | null;
  onListen: (track: JamTrack) => void;
  onAccept: (track: JamTrack) => void;
  onDecline: (track: JamTrack) => void;
}) {
  const { t } = useTranslation();
  if (takes.length === 0) {
    return null;
  }
  return (
    <section aria-labelledby="jam-requests" data-jam-requests="" className="mt-3 flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <h3 id="jam-requests" className="font-display text-lg font-extrabold text-text">
          {t("jam.public.requests.title")}
        </h3>
        <span className="text-[13px] font-semibold text-text-secondary">
          {t("jam.public.requests.count", { count: takes.length, countLabel: takes.length })}
        </span>
      </div>
      <p className="text-[13px] leading-snug text-text-secondary">{t("jam.public.requests.hint")}</p>
      <ul className="flex flex-col divide-y divide-border rounded-[var(--radius-card)] bg-surface-2">
        {takes.map((track) => {
          const look = JAM_INSTRUMENT_LOOK[track.instrument];
          const Icon = look.icon;
          const heard = auditioning === track.id;
          const busy = busyId === track.id;
          return (
            <li
              key={track.id}
              data-jam-request={track.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5"
            >
              <span className={cn("grid h-9 w-9 shrink-0 place-items-center rounded-[var(--radius-control)]", look.fill)}>
                <Icon className="h-4 w-4" aria-hidden />
              </span>
              <span className="flex min-w-0 flex-1 basis-40 flex-col leading-tight">
                <span className="truncate text-sm font-bold text-text">{t(look.nameKey as MessageKey)}</span>
                <span className="truncate text-[13px] font-semibold text-text-secondary">
                  {track.authorName ?? t("jam.tile.anonymous")}
                </span>
              </span>
              <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                <Button
                  size="sm"
                  variant="secondary"
                  aria-pressed={heard}
                  onClick={() => onListen(track)}
                  className="gap-1.5 pointer-coarse:h-11"
                  data-jam-request-listen=""
                >
                  {heard && playing ? <Pause className="h-3.5 w-3.5" aria-hidden /> : <Ear className="h-3.5 w-3.5" aria-hidden />}
                  {heard && playing ? t("jam.public.requests.stop") : t("jam.public.requests.listen")}
                </Button>
                <Button size="sm" className="pointer-coarse:h-11" disabled={busy} onClick={() => onAccept(track)} data-jam-request-accept="">
                  {t("jam.public.requests.accept")}
                </Button>
                <Button size="sm" variant="secondary" className="pointer-coarse:h-11" disabled={busy} onClick={() => onDecline(track)} data-jam-request-decline="">
                  {t("jam.public.requests.decline")}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
