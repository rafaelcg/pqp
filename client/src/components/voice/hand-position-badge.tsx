import { Hand } from "lucide-react";
import { raisedHandQueue, type RaisedHandPerson } from "@pqp/shared";
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
 */
export function HandPositionBadge({
  position,
  className,
}: {
  position: number;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <span
      role="img"
      aria-label={t("voice.hand.raisedAt", { position })}
      data-hand-position={position}
      className={cn(
        "flex shrink-0 items-center gap-0.5 font-semibold tabular-nums text-signal",
        className,
      )}
    >
      <Hand aria-hidden="true" className="h-3 w-3" />
      {position}
    </span>
  );
}
