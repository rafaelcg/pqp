import type { MessageReaction } from "@pqp/shared";
import { useState } from "react";
import { UserAvatar } from "@/components/user/user-avatar";
import { Dialog } from "@/components/ui/dialog";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * Who reacted, as a phone sheet (the text channels canvas, "Celular", board
 * 4): one tab per emoji, then the people. Opened by holding a reaction under
 * the redesign at phone width, where there is no hover tip to read. Your own
 * row says so and taking it off is one tap.
 *
 * `users` is the server's capped list, so a reaction with more people than
 * that ends in "e mais N" instead of pretending the list is whole.
 */
export function ReactionWhoSheet({
  reactions,
  initialEmoji,
  currentUserId,
  avatarFor,
  onToggle,
  onClose,
}: {
  reactions: readonly MessageReaction[];
  initialEmoji: string;
  currentUserId: string | null;
  avatarFor: (userId: string) => string | null;
  onToggle: (emoji: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [picked, setPicked] = useState(initialEmoji);
  // A reaction that went to zero (yours, just taken off) leaves its tab: the
  // sheet moves to the first one left, and closes when none is.
  const active = reactions.find((reaction) => reaction.emoji === picked) ?? reactions[0];

  return (
    <Dialog
      open={active !== undefined}
      title={t("chat.reaction.whoTitle")}
      onClose={onClose}
      // On a phone the board draws a grab handle and no title band: the title
      // stays for screen readers, and the backdrop or Escape closes it.
      headerClassName="redesign:max-sm:sr-only"
    >
      {active && (
        <div data-reaction-who-sheet="" className="flex flex-col pb-2 pt-3">
          <span
            aria-hidden
            data-sheet-grabber=""
            className="mx-auto mb-3 hidden h-1 w-9 rounded-full bg-[color:var(--color-border-strong)] redesign:max-sm:block"
          />
          <div
            role="tablist"
            aria-label={t("chat.reaction.whoTitle")}
            className="flex gap-1.5 overflow-x-auto px-3 pb-2.5"
          >
            {reactions.map((reaction) => {
              const selected = reaction.emoji === active.emoji;
              return (
                <button
                  key={reaction.emoji}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => setPicked(reaction.emoji)}
                  className={cn(
                    "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-sm font-semibold text-text shadow-[inset_0_0_0_1px_var(--color-border)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                    selected && "bg-surface-3",
                  )}
                >
                  <span aria-hidden>{reaction.emoji}</span>
                  <span className="tabular-nums">{reaction.count}</span>
                </button>
              );
            })}
          </div>
          <ul role="tabpanel" className="flex flex-col">
            {[...active.users]
              // Yours first, as on the board: it is the one row that does something.
              .sort((a, b) => Number(b.id === currentUserId) - Number(a.id === currentUserId))
              .map((user) => {
                const mine = user.id === currentUserId;
                const avatar = (
                  <UserAvatar
                    name={user.displayName}
                    avatarUrl={avatarFor(user.id)}
                    className="h-9 w-9"
                    rounded="full"
                  />
                );
                const name = mine
                  ? t("chat.reaction.whoYou", { name: user.displayName })
                  : user.displayName;
                return (
                  <li key={user.id}>
                    {mine ? (
                      <button
                        type="button"
                        data-reaction-who-mine=""
                        onClick={() => onToggle(active.emoji)}
                        aria-label={t("chat.removeReaction", { emoji: active.emoji })}
                        className="flex h-[52px] w-full items-center gap-3 px-4 text-left hover:bg-surface-3 focus-visible:bg-surface-3 focus-visible:outline-none"
                      >
                        {avatar}
                        <span className="min-w-0 flex-1 truncate text-base font-medium text-text">{name}</span>
                        <span className="shrink-0 text-xs text-text-tertiary">{t("chat.reaction.tapToRemove")}</span>
                      </button>
                    ) : (
                      <div className="flex h-[52px] items-center gap-3 px-4">
                        {avatar}
                        <span className="min-w-0 flex-1 truncate text-base font-medium text-text">{name}</span>
                      </div>
                    )}
                  </li>
                );
              })}
            {active.count > active.users.length && (
              <li className="flex h-11 items-center px-4 text-sm text-text-tertiary">
                {t("chat.reaction.whoMore", { count: active.count - active.users.length })}
              </li>
            )}
          </ul>
        </div>
      )}
    </Dialog>
  );
}
