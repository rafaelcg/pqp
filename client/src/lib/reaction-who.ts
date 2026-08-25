import type { MessageKey, MessageVars } from "@/lib/i18n";

/** How many names the tooltip lists before "and N more". */
export const REACTION_WHO_NAMED = 8;

export interface ReactionWhoUser {
  id: string;
  displayName: string;
}

type Translate = (key: MessageKey, vars?: MessageVars) => string;

function labelFor(
  user: ReactionWhoUser,
  currentUserId: string | null,
  t: Translate,
): string {
  if (user.id === currentUserId) {
    return t("chat.you");
  }
  const name = user.displayName.trim();
  return name.length > 0 ? name : t("chat.reaction.someone");
}

/**
 * "You, Alice and Bob" or "Alice, Bob and 3 more". Empty when the payload
 * has no names yet (an old server, or a count-only row).
 */
export function formatReactionWho(
  users: readonly ReactionWhoUser[] | undefined,
  count: number,
  currentUserId: string | null,
  t: Translate,
): string {
  if (!users?.length) {
    return "";
  }

  const ordered = [...users].sort((a, b) => {
    const aMe = a.id === currentUserId ? 0 : 1;
    const bMe = b.id === currentUserId ? 0 : 1;
    return aMe - bMe;
  });
  const named = ordered.slice(0, REACTION_WHO_NAMED);
  const labels = named.map((user) => labelFor(user, currentUserId, t));
  const overflow = Math.max(0, count - labels.length);

  if (overflow > 0) {
    return t("chat.reaction.overflow", {
      list: labels.join(", "),
      count: overflow,
    });
  }
  if (labels.length === 1) {
    return labels[0]!;
  }
  if (labels.length === 2) {
    return t("chat.reaction.names.two", { a: labels[0], b: labels[1] });
  }
  return t("chat.reaction.names.many", {
    list: labels.slice(0, -1).join(", "),
    last: labels[labels.length - 1],
  });
}
