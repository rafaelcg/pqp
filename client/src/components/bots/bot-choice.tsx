import { Check } from "lucide-react";
import { Check as CheckBold } from "@phosphor-icons/react";
import { IconSwap } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

/**
 * The bot pickers under the redesign: the settings kit's chosen card
 * (`settings/kit/choice-grid.tsx`), so a face and a colour are chosen the same
 * way as any other setting, in the wizard and in the overview. The overview's
 * persona presets are compact chips with the selected pill instead.
 */

/** A choice card at rest (its edge firms on hover), and chosen: the 2px accent edge (border plus inset ring), the row tint. */
export const BOT_CARD_REDESIGN =
  "redesign:relative redesign:border-[color:var(--card-border)] redesign:bg-[color:var(--card-bg)] redesign:hover:border-[color:color-mix(in_oklab,var(--color-text)_18%,transparent)]";
export const BOT_CARD_CHOSEN_REDESIGN =
  "redesign:relative redesign:border-accent redesign:bg-[color:var(--card-row-hover)] redesign:text-text redesign:shadow-[inset_0_0_0_1px_var(--color-accent)]";

/** A colour swatch chosen: the ring sits outside, so it never hugs a lime face. */
export const BOT_SWATCH_REDESIGN = "redesign:relative redesign:hover:bg-[color:var(--card-row-hover)]";
export const BOT_SWATCH_CHOSEN_REDESIGN =
  "redesign:border-transparent redesign:ring-2 redesign:ring-accent redesign:ring-offset-2 redesign:ring-offset-[color:var(--color-surface-1)]";

/** In the server settings pane the ring's offset is the pane, not the wizard's column. */
export const BOT_RING_OFFSET_PANE_REDESIGN =
  "redesign:ring-offset-[color:var(--settings-pane-bg)] redesign:focus-visible:ring-offset-[color:var(--settings-pane-bg)]";

/** Keyboard focus on a picker: an outer ring, apart from the chosen edge. */
export const BOT_CHOICE_FOCUS_REDESIGN =
  "redesign:focus-visible:ring-2 redesign:focus-visible:ring-text redesign:focus-visible:ring-offset-2 redesign:focus-visible:ring-offset-[color:var(--color-surface-1)]";

/** The check on a chosen card or swatch, drawn only under the redesign. */
export function ChosenCheck({ corner = "top" }: { corner?: "top" | "bottom" }) {
  return (
    <span
      aria-hidden
      className={cn(
        "hidden absolute h-4 w-4 items-center justify-center rounded-full bg-accent text-on-accent redesign:flex",
        corner === "top" ? "right-1.5 top-1.5" : "-bottom-0.5 -right-0.5 h-3.5 w-3.5",
      )}
    >
      <IconSwap off={Check} on={CheckBold} kind="symbol" offClassName="h-3 w-3" className={corner === "top" ? "h-3 w-3" : "h-2.5 w-2.5"} />
    </span>
  );
}
