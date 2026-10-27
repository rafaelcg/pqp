import type { APP_ICON_IDS } from "@pqp/shared";
import {
  ChartColumn,
  Dices,
  FlaskConical,
  Gamepad2,
  Layers,
  Music,
  Pencil,
  Puzzle,
  Sparkles,
  Trophy,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

type AppIconId = (typeof APP_ICON_IDS)[number];

/**
 * An app's icon is one of a fixed set the manifest names, never an upload and
 * never a URL (RFC: the icon is the platform's, so an app cannot draw outside
 * its tile). Each id is a lucide glyph.
 */
const ICONS: Record<AppIconId, LucideIcon> = {
  gamepad: Gamepad2,
  poll: ChartColumn,
  pencil: Pencil,
  music: Music,
  dice: Dices,
  cards: Layers,
  puzzle: Puzzle,
  trophy: Trophy,
  sparkles: Sparkles,
  flask: FlaskConical,
};

export function appIconFor(id: string): LucideIcon {
  return (ICONS as Record<string, LucideIcon>)[id] ?? Sparkles;
}

/** The rounded tile an app wears everywhere: 40px (44px on a phone), icon 20px. */
export function AppIconTile({
  icon,
  className,
  dimmed = false,
}: {
  icon: string;
  className?: string;
  dimmed?: boolean;
}) {
  const Icon = appIconFor(icon);
  return (
    <span
      aria-hidden
      className={cn(
        "flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-accent-soft text-on-accent-soft sm:h-10 sm:w-10 redesign:rounded-[var(--radius-card)]",
        dimmed && "bg-surface-2 text-text-tertiary",
        className,
      )}
    >
      <Icon className="h-5 w-5" />
    </span>
  );
}
