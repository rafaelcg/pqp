import { createContext, useContext } from "react";
import { Hand as HandFill } from "@phosphor-icons/react";
import { Hand } from "lucide-react";
import { raisedHandQueue, type RaisedHandPerson } from "@pqp/shared";
import { IconSwap } from "@/components/ui/icon";
import { Tooltip } from "@/components/ui/tooltip";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * Each raised hand's place in the room's queue, keyed by userId.
 *
 * One pass over the roster, so a sidebar row or a tile can look its number up
 * without sorting the room again per person. The order is `raisedHandQueue`'s,
 * the same one the queue panel prints, so "2" on a tile and "2" in the panel
 * are always the same person.
 */
export function raisedHandPositions(
  participants: readonly RaisedHandPerson[],
): Map<string, number> {
  const positions = new Map<string, number>();
  raisedHandQueue(participants).forEach((person, index) => {
    positions.set(person.userId, index + 1);
  });
  return positions;
}

/**
 * The hand with its number next to it: "✋ 2" is the second hand that went up.
 *
 * Asked for by a table that ran RPG initiative over calls: as people raised
 * their hands, each one showed with its number in the order, so the room
 * could read the turn order off the faces without opening a list.
 *
 * With `onLower` (sticky hands, `raised_hand_sticky`) the badge is the control
 * that takes the hand down: your own, or anybody's for a moderator. A hand
 * that stays up until somebody lowers it has to be lowerable from where it is
 * drawn, not only from a button across the screen.
 */
export function HandPositionBadge({
  position,
  className,
  onLower,
  lowerLabel,
}: {
  position: number;
  className?: string;
  onLower?: () => void;
  /** What the button says and the screen reader reads, when `onLower` is set. */
  lowerLabel?: string;
}) {
  const { t } = useTranslation();
  const classes = cn(
    "flex shrink-0 items-center gap-0.5 font-semibold tabular-nums text-signal",
    className,
    // Lime is too light for a mark on the light pane: the accent's text step.
    "redesign:text-accent-text",
  );
  if (onLower) {
    const label = lowerLabel ?? t("voice.hand.lower");
    return (
      <Tooltip label={label}>
        <button
          type="button"
          aria-label={`${t("voice.hand.raisedAt", { position })}. ${label}`}
          data-hand-position={position}
          data-hand-lower-badge=""
          className={cn(
            classes,
            // `pointer-events-auto`: on a tile the badge sits in a row that
            // lets clicks through to the picture, and a button that cannot
            // be clicked is a number nobody can lower.
            "pointer-events-auto rounded px-0.5 hover:bg-ink-4/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/60 motion-safe:transition-colors",
          )}
          onClick={(event) => {
            event.stopPropagation();
            onLower();
          }}
        >
          <IconSwap off={Hand} on={HandFill} offClassName="h-3 w-3" className="h-3.5 w-3.5" />
          {position}
        </button>
      </Tooltip>
    );
  }
  return (
    <span
      role="img"
      aria-label={t("voice.hand.raisedAt", { position })}
      data-hand-position={position}
      className={classes}
    >
      <IconSwap off={Hand} on={HandFill} offClassName="h-3 w-3" className="h-3.5 w-3.5" />
      {position}
    </span>
  );
}

/**
 * Who may lower which hand, for the badges drawn on the call's tiles.
 *
 * A context rather than a prop because the badge is drawn several components
 * below the stage that knows (a tile inside a grid inside an overlay), and
 * every one of those would carry two callbacks it never uses. Absent (no
 * provider, or sticky hands off) means a hand badge is only a picture, which
 * is how it always was.
 */
export interface HandBadgeActions {
  selfUserId: string | null;
  /** Lower our own hand. */
  lowerSelf?: () => void;
  /** Lower somebody else's: a moderator's "you're up". */
  lowerOther?: (userId: string) => void;
  /** Lower every hand in the room: a moderator's "next round". */
  lowerAll?: () => void;
}

export const HandBadgeActionsContext = createContext<HandBadgeActions | null>(
  null,
);

/** The badge's `onLower` for this person on a tile, or undefined. */
export function useHandLowerFor(
  userId: string | undefined,
): (() => void) | undefined {
  const actions = useContext(HandBadgeActionsContext);
  if (!actions || !userId) {
    return undefined;
  }
  if (userId === actions.selfUserId) {
    return actions.lowerSelf;
  }
  const lowerOther = actions.lowerOther;
  return lowerOther ? () => lowerOther(userId) : undefined;
}
