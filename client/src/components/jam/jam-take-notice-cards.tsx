import type { JamInstrument, JamTakeNotice } from "@pqp/shared";
import { Check, Ear, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { isolate } from "@/lib/bidi";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { JAM_INSTRUMENT_LOOK } from "@/lib/jam-instruments";
import { cn } from "@/lib/utils";
import { formatList } from "./jam-need";

/**
 * The durable item of "somebody sent a part" (to the song's starter) and "the
 * starter answered" (to whoever sent it): `GET /api/jam-public/notices`, read at
 * boot and after every live nudge by `lib/jam-public-store.ts`. It stays until
 * it is answered, the way the watch party's "liberada" card does, because it is
 * the one thing this person is waiting to hear. The take card's count and
 * instruments are the takes still waiting, so answering them empties it.
 *
 * Tapping the main button spends the item on the server and opens the song,
 * where the waiting parts are the first thing on the page (`jam-song-panel.tsx`).
 * The X spends it without opening: the persistent markers (the wall's row and
 * tile, the song's own banner) are what stays.
 */

export function takeNoticeText(
  notice: Pick<JamTakeNotice, "kind" | "title" | "instruments" | "count">,
  t: (key: MessageKey, values?: Record<string, string | number>) => string,
  locale: string,
): string {
  const names = notice.instruments.map((instrument: JamInstrument) =>
    instrument === "other"
      ? t("jam.public.card.otherInstrument")
      : t(JAM_INSTRUMENT_LOOK[instrument].nameKey as MessageKey).toLowerCase(),
  );
  return t(`jam.public.card.${notice.kind}` as MessageKey, {
    title: isolate(notice.title),
    instruments: formatList(names, locale),
    count: notice.count,
    countLabel: notice.count,
  });
}

export function JamTakeNoticeCards({
  notice,
  more = 0,
  placement = "overlay",
  onOpen,
  onDismiss,
}: {
  /** The ONE notice to draw (`jamNoticeQueue`): they are a queue, never a stack. */
  notice: JamTakeNotice | null;
  /** How many more wait behind it. */
  more?: number;
  /**
   * `overlay` floats over the app (never over a song or the studio: `jam-notice-placement.ts`).
   * `inline` sits in the flow at the top of a public view, so it moves the song down instead of covering it.
   */
  placement?: "overlay" | "inline";
  onOpen: (notice: JamTakeNotice) => void;
  onDismiss: (notice: JamTakeNotice) => void;
}) {
  const { t, locale } = useTranslation();
  if (!notice) {
    return null;
  }
  const take = notice.kind === "take";
  const Icon = take ? Ear : notice.kind === "accepted" ? Check : X;
  const inline = placement === "inline";
  return (
    <div
      data-jam-take-notices=""
      data-placement={placement}
      className={cn(
        inline
          ? "shrink-0 border-b border-border bg-surface-1 px-3 py-2 sm:px-5"
          : // Bottom right on a desktop, where the corner cards live and yield to it; above the bar on a phone.
            "pointer-events-none fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+72px)] z-40 flex flex-col gap-2 sm:inset-x-auto sm:bottom-4 sm:right-4 sm:w-96",
      )}
    >
      <div
        key={notice.id}
        role="status"
        aria-live="polite"
        data-jam-take-notice={notice.kind}
        data-song-id={notice.songId}
        className={cn(
          "pointer-events-auto flex items-start gap-3 rounded-[var(--radius-card)] bg-surface-2 p-3",
          inline ? "mx-auto max-w-[62rem] border border-border" : "elevation-3 animate-toast-in",
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            "mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full",
            take ? "bg-accent-soft text-on-accent-soft" : "bg-surface-3 text-text-secondary",
          )}
        >
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold leading-snug text-text [overflow-wrap:anywhere] [text-wrap:pretty]">
            {takeNoticeText(notice, t, locale)}
          </p>
          {more > 0 && (
            <p className="mt-0.5 text-[13px] text-text-secondary" data-jam-take-notice-more={more}>
              {t("jam.public.card.more", { count: more, countLabel: more })}
            </p>
          )}
          <div className="mt-2">
            <Button size="sm" variant={take ? "default" : "secondary"} className="pointer-coarse:h-11" onClick={() => onOpen(notice)} data-jam-take-notice-open="">
              {take ? t("jam.public.card.reply") : t("jam.public.card.open")}
            </Button>
          </div>
        </div>
        <button
          type="button"
          onClick={() => onDismiss(notice)}
          aria-label={t("common.close")}
          data-jam-take-notice-dismiss=""
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-text-secondary outline-none hover:bg-surface-3 hover:text-text focus-visible:ring-2 focus-visible:ring-focus-ring pointer-coarse:h-11 pointer-coarse:w-11"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}
