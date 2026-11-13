import { Gem } from "lucide-react";
import { ServerIcon } from "@/components/layout/server-identity";
import { cn } from "@/lib/utils";

/**
 * The VIP seal: the creator's own icon with a small gem medallion on its
 * corner. It is the one mark Baú+ uses for "tu é VIP daqui", on the pay
 * sheet's confirmation, the strip at the top of the Baú and every box in
 * Configurações, Assinaturas, so being a member looks the same everywhere.
 *
 * `tone`:
 *   vip     the medallion in the accent (access is on)
 *   muted   the medallion greyed (grace, ended, refunded: the seal is
 *           remembered, not worn)
 *
 * `celebrate` plays the arrival once: the tile settles, one sheen crosses
 * it, the medallion lands. Off under reduced motion (`index.css`).
 *
 * `ringClass` is the colour of the gap around the medallion, which has to be
 * whatever the seal sits on (a card, the strip's tint).
 */
const SIZE = {
  sm: {
    tile: "h-9 w-9 text-xs",
    medal: "h-4 w-4 -bottom-1 -right-1",
    gem: "h-2.5 w-2.5",
  },
  md: {
    tile: "h-11 w-11 text-sm",
    medal: "h-5 w-5 -bottom-1 -right-1",
    gem: "h-3 w-3",
  },
  lg: {
    tile: "h-[4.5rem] w-[4.5rem] text-xl",
    medal: "h-7 w-7 -bottom-1.5 -right-1.5",
    gem: "h-4 w-4",
  },
} as const;

export function VipSeal({
  name,
  iconUrl,
  size = "md",
  tone = "vip",
  celebrate = false,
  ringClass = "ring-surface-card",
  className,
}: {
  name: string;
  iconUrl: string | null;
  size?: keyof typeof SIZE;
  tone?: "vip" | "muted";
  celebrate?: boolean;
  ringClass?: string;
  className?: string;
}) {
  const s = SIZE[size];
  return (
    <span
      className={cn("relative inline-grid shrink-0", className)}
      data-bau-seal={tone}
    >
      <span
        className={cn(
          "relative grid place-items-center overflow-hidden rounded-[var(--radius-card)] bg-surface-3 font-semibold text-text-secondary",
          s.tile,
          celebrate && "bau-seal-in",
        )}
      >
        <ServerIcon name={name} iconUrl={iconUrl} />
        {celebrate && <span aria-hidden className="bau-seal-sheen" />}
      </span>
      <span
        aria-hidden
        className={cn(
          "absolute grid place-items-center rounded-full ring-2",
          s.medal,
          ringClass,
          tone === "vip"
            ? "bg-accent text-on-accent"
            : "bg-surface-3 text-text-tertiary",
          celebrate && "bau-medal-in",
        )}
      >
        <Gem className={s.gem} strokeWidth={2.5} />
      </span>
    </span>
  );
}

/**
 * A thin bar for how much of the paid month is still ahead. Decorative: the
 * sentence beside it says the same in words.
 */
export function BauMonthMeter({
  remaining,
  tone = "vip",
  className,
}: {
  remaining: number;
  tone?: "vip" | "warning" | "muted";
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "block h-1 overflow-hidden rounded-full bg-surface-3",
        className,
      )}
      data-bau-meter
    >
      <span
        className={cn(
          "bau-meter-fill block h-full rounded-full",
          tone === "vip"
            ? "bg-accent"
            : tone === "warning"
              ? "bg-warning"
              : "bg-text-tertiary",
        )}
        style={{ width: `${Math.round(remaining * 1000) / 10}%` }}
      />
    </span>
  );
}
