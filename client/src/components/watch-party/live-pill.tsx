import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * The AO VIVO badge, in one place, for every surface that says a watch party
 * is on air.
 *
 * THE RULE IT ENFORCES, which predates this component and is why it exists:
 * THE PULSE IS ON THE DOT, NEVER ON THE TEXT, AND ONLY UNDER `motion-safe`.
 * With reduced motion the badge simply sits there red and still reads as
 * live, because the colour and the word are doing the work and the movement
 * is a garnish. Pulsing the text would make a label somebody reads flicker,
 * which is the version that gets turned off rather than enjoyed.
 *
 * `animate-pulse` is a two second opacity fade, which is the gentlest thing
 * in the vocabulary this codebase already uses for exactly this badge. It is
 * deliberately not a new keyframe: a sidebar block is looked at for hours,
 * and a second animation vocabulary invented for one badge is how a room
 * ends up with three different ideas of what "live" looks like.
 *
 * EXACTLY ONE THING PULSES PER SURFACE. The block used to pulse a dot on the
 * host's avatar as well as carrying this badge, which is two heartbeats out
 * of step in a card the size of a postage stamp. The avatar's dot is static
 * now; this is the one that moves.
 */
export function LivePill({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <span
      data-watch-party-live-pill=""
      className={cn(
        "flex shrink-0 items-center gap-1 rounded-full bg-danger/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-danger",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="h-1.5 w-1.5 rounded-full bg-danger motion-safe:animate-pulse"
      />
      {t("watchParty.live.badge")}
    </span>
  );
}
