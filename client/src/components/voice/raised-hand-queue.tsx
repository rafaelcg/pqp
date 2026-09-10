import { Hand, X } from "lucide-react";
import {
  RAISED_HAND_LIST_LIMIT,
  raisedHandQueue,
  type VoiceParticipant,
} from "@pqp/shared";
import { Tooltip } from "@/components/ui/tooltip";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * WHO IS WAITING TO TALK, IN THE ORDER THEY ASKED.
 *
 * Asked for in the QG: "levantar a mão e aí forma a fila de quem levantou
 * primeiro". The order is not this component's to decide: every entry carries
 * a server-stamped `handRaisedAt` and `raisedHandQueue` sorts on it, so this
 * list is the same list on every screen in the room, and adding or removing a
 * hand somewhere else in it never reshuffles the ones above.
 *
 * DELIBERATELY QUIET. No toast, no sound, no badge on the channel. A queue is
 * a thing people glance at between sentences; a queue that interrupts forty
 * people to announce the twelfth raise is a queue everybody turns off. The
 * hand appears here and on the person's row in the sidebar, and that is all
 * it does.
 *
 * THE LIST IS CAPPED AND THE QUEUE IS NOT (see `RAISED_HAND_LIST_LIMIT`).
 * Forty names is not a thing anyone reads mid-call, so the tail becomes a
 * count. Your own position is printed whatever it is, because "you are
 * eleventh" is exactly the fact that stops you asking again.
 *
 * TWO SHAPES, BECAUSE MOST CALLS HAVE NO PICTURE. A call with nobody's camera
 * on never gets an expanded stage at all (`shouldShowExpandedStage`): it is a
 * one-line strip above the chat, and a panel would not fit in it. That is the
 * ordinary case, not the corner case, so `compact` renders the same queue as
 * one line for that strip. Lowering somebody else's hand is not on the compact
 * line, and does not need to be: it is on their row in the sidebar, under the
 * same right-click as the mute.
 */
export function RaisedHandQueue({
  participants,
  selfUserId,
  canLowerHands = false,
  onLowerHand,
  compact = false,
  className,
}: {
  /** The room, as the roster describes it. Order here is ignored. */
  participants: VoiceParticipant[];
  selfUserId: string | null;
  /**
   * `Permission.MUTE_MEMBERS` in this channel: the bit the other voice
   * moderation actions already use. Lowering someone else's hand is what
   * "you're up" looks like, so it is the person running the room who has it.
   */
  canLowerHands?: boolean;
  onLowerHand?: (userId: string) => void;
  /** One line for the collapsed call strip instead of a panel. */
  compact?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const queue = raisedHandQueue(participants);
  if (queue.length === 0) {
    return null;
  }
  const shown = queue.slice(0, RAISED_HAND_LIST_LIMIT);
  const overflow = queue.length - shown.length;
  const selfIndex = selfUserId
    ? queue.findIndex((person) => person.userId === selfUserId)
    : -1;
  const selfLine =
    selfIndex === 0
      ? t("voice.hand.next")
      : selfIndex > 0
        ? t("voice.hand.position", { position: selfIndex + 1 })
        : null;

  if (compact) {
    return (
      <p
        data-hand-queue="compact"
        className={cn(
          "flex shrink-0 items-center gap-1.5 text-[11px] text-paper-muted",
          className,
        )}
      >
        <Hand className="h-3 w-3 shrink-0 text-signal" aria-hidden="true" />
        <span className="sr-only">{t("voice.hand.queue")}</span>
        <span
          data-hand-queue-entry={queue[0]!.userId}
          className="max-w-[8rem] truncate"
        >
          {queue[0]!.displayName}
        </span>
        {/* One name and a count: the strip is a line, and the whole list is
            one click away on the person's row in the sidebar. */}
        {queue.length > 1 && (
          <span className="tabular-nums">
            {t("voice.hand.more", { count: queue.length - 1 })}
          </span>
        )}
        {selfLine && (
          <span
            aria-live="polite"
            data-hand-position={selfIndex + 1}
            className="font-medium text-signal"
          >
            {selfLine}
          </span>
        )}
      </p>
    );
  }

  return (
    <div
      data-hand-queue=""
      className={cn(
        "pointer-events-auto w-full max-w-xs rounded-lg bg-ink-2/90 px-2.5 py-2 text-xs shadow-lg ring-1 ring-ink-4/60 backdrop-blur",
        className,
      )}
    >
      <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-paper-muted">
        <Hand className="h-3 w-3 text-signal" aria-hidden="true" />
        {t("voice.hand.queue")}
      </p>
      <ol className="mt-1 space-y-0.5">
        {shown.map((person, index) => (
          <li
            key={person.userId}
            data-hand-queue-entry={person.userId}
            className={cn(
              "flex items-center gap-1.5",
              person.userId === selfUserId ? "text-paper" : "text-paper-muted",
            )}
          >
            {/* Tabular so the numbers line up under each other as the queue
                moves, instead of the names jittering left and right. */}
            <span className="w-3 shrink-0 text-right tabular-nums text-paper-muted">
              {index + 1}
            </span>
            <span className="min-w-0 flex-1 truncate">{person.displayName}</span>
            {canLowerHands && onLowerHand && person.userId !== selfUserId && (
              <Tooltip
                label={t("voice.hand.lowerFor", { name: person.displayName })}
              >
                <button
                  type="button"
                  aria-label={t("voice.hand.lowerFor", {
                    name: person.displayName,
                  })}
                  data-hand-lower={person.userId}
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-paper-muted hover:bg-ink-4 hover:text-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/60"
                  onClick={() => onLowerHand(person.userId)}
                >
                  <X className="h-3 w-3" />
                </button>
              </Tooltip>
            )}
          </li>
        ))}
      </ol>
      {overflow > 0 && (
        <p className="mt-1 pl-[1.125rem] text-[11px] text-paper-muted">
          {t("voice.hand.more", { count: overflow })}
        </p>
      )}
      {selfLine && (
        // `aria-live` because this is news that arrives without the person
        // doing anything: the queue moved and they are closer to the front.
        <p
          aria-live="polite"
          data-hand-position={selfIndex + 1}
          className="mt-1 border-t border-ink-4/60 pt-1 text-[11px] font-medium text-signal"
        >
          {selfLine}
        </p>
      )}
    </div>
  );
}
