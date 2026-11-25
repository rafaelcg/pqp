import { Music2 } from "lucide-react";
import { isolate } from "@/lib/bidi";
import { useTranslation } from "@/lib/i18n";
import type { JamHandover } from "@/lib/jam-handover";
import { cn } from "@/lib/utils";

/**
 * "Tua jam tá esperando", on the first-run screens shown to somebody who came
 * from the public jam site: the age gate and, when the account has no name yet,
 * the name step. One light line of context so the sign-up still reads as a step
 * toward the song and not as a different product (finding M1 of the launch
 * user test: "Jam branding becomes plain pqp").
 *
 * It says nothing the person did not choose and asks for nothing: the title is
 * the song they pressed Gravar on, or nothing while it loads or for a new jam.
 * Same quiet card as the invite path's `ArrivalCard`, no motion of its own.
 */
export function JamArrivalCard({
  handover,
  className,
}: {
  handover: JamHandover;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <div
      data-jam-arrival=""
      className={cn(
        "flex items-center gap-3 rounded-[var(--radius-card)] bg-accent-soft px-3 py-2.5",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent"
      >
        <Music2 className="h-4 w-4" />
      </span>
      <div className="min-w-0">
        <p className="text-sm font-semibold text-on-accent-soft">
          {t("jam.handover.waiting")}
        </p>
        {handover.title ? (
          <p
            data-jam-arrival-title=""
            className="truncate text-sm text-on-accent-soft/80"
          >
            {isolate(handover.title)}
          </p>
        ) : null}
      </div>
    </div>
  );
}
