import { Music2 } from "lucide-react";
import { isolate } from "@/lib/bidi";
import { useTranslation } from "@/lib/i18n";
import { useJamHandoverCover, type JamHandover } from "@/lib/jam-handover";
import { cn } from "@/lib/utils";

/**
 * What the screen shows while the app loads for somebody who came from the
 * public jam site (jam.pqp.gg): the age gate's backdrop, the seconds before the
 * studio opens, Clerk checking the session. It used to be black behind the age
 * sheet and, once the sheet was answered, a chat skeleton that said "Carregando
 * comunidades…" (finding M1 of the launch user test, round 2): the visitor had
 * come for a song and felt they had left it.
 *
 * Jam's own surface and word mark, the song's cover and title when the public
 * route has answered (the same read as the title on the first-run screens,
 * `resolveJamHandoverTitle`), and one plain line. Nothing about chat.
 *
 * `behindSheet` is the quiet form, for the age gate and the name step, which
 * already say "Tua jam tá esperando" and the title on their own card: only the
 * brand and the cover are drawn so the same words are not read twice.
 *
 * Motion is a slow pulse on the cover and is off for reduced motion.
 */
export function JamHoldingScreen({
  handover,
  behindSheet = false,
  className,
}: {
  handover: JamHandover;
  behindSheet?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const cover = useJamHandoverCover(handover.target === "new" ? null : handover.target);
  const label = t(handover.target === "new" ? "jam.handover.openingNew" : "jam.handover.opening");
  return (
    <div
      data-jam-holding=""
      role={behindSheet ? undefined : "status"}
      aria-live={behindSheet ? undefined : "polite"}
      aria-busy={behindSheet ? undefined : true}
      aria-label={behindSheet ? undefined : label}
      aria-hidden={behindSheet ? true : undefined}
      className={cn(
        "relative flex h-full min-h-dvh flex-col items-center justify-center gap-6 overflow-hidden bg-surface-0 px-6 text-center text-text",
        className,
      )}
    >
      {cover && (
        <img
          src={cover}
          alt=""
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 h-full w-full scale-110 object-cover opacity-25 blur-3xl"
        />
      )}
      <span className="relative font-brand text-[22px] leading-none tracking-tight">
        pqp <span className="text-accent">jam</span>
      </span>
      <div
        className={cn(
          "relative grid h-28 w-28 place-items-center overflow-hidden rounded-[var(--radius-panel)] bg-surface-2 text-text-secondary ring-1 ring-inset ring-border motion-safe:animate-pulse",
        )}
      >
        {cover ? (
          <img src={cover} alt="" className="h-full w-full object-cover" />
        ) : (
          <Music2 className="h-8 w-8" aria-hidden="true" />
        )}
      </div>
      {!behindSheet && (
        <div className="relative flex max-w-xs flex-col gap-1">
          {handover.title && (
            <p data-jam-holding-title="" className="truncate font-display text-xl font-extrabold">
              {isolate(handover.title)}
            </p>
          )}
          <p className="text-sm text-text-secondary">{label}</p>
        </div>
      )}
    </div>
  );
}
