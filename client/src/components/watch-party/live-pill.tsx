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
/**
 * `recovering` is the presenter's own truthful state: their screen-share
 * publish dropped (a reconnect) and the client is putting it back. It is NOT
 * "AO VIVO" — saying so is the 35-minute lie this variant exists to stop — so
 * it borrows the badge's shape but not its word or its red: amber, "RECONECTANDO",
 * and still the dot that carries the pulse (never the text; see the note above).
 * Only the presenter's surfaces ever pass it; a viewer keeps the live badge.
 */
export function LivePill({
  className,
  variant = "live",
}: {
  className?: string;
  variant?: "live" | "recovering";
}) {
  const { t } = useTranslation();
  const recovering = variant === "recovering";
  return (
    <span
      data-watch-party-live-pill={recovering ? "recovering" : ""}
      className={cn(
        "flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider",
        recovering
          ? "bg-warning/15 text-warning"
          : "bg-danger/15 text-danger",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "h-1.5 w-1.5 rounded-full motion-safe:animate-pulse",
          recovering ? "bg-warning" : "bg-danger",
        )}
      />
      {recovering
        ? t("watchParty.live.recovering")
        : t("watchParty.live.badge")}
    </span>
  );
}
