import type { DmSummary, Friend } from "@pqp/shared";
import { Ban, Pin, PinOff, UserMinus, UserRound } from "lucide-react";
import type { ContextMenuItemDef } from "@/components/ui/context-menu";
import type { ProfileSubject } from "@/components/user/profile-relations";
import type { MessageKey } from "@/lib/i18n";

/**
 * The person a friend row opens the profile card on. Every field the row knows
 * rides along, so the card shows the same thing it shows from the member list,
 * including "Ver perfil" and the public address when a handle is claimed.
 */
export function friendProfileSubject(friend: Friend): ProfileSubject {
  return {
    id: friend.id,
    displayName: friend.displayName,
    tag: friend.tag ?? null,
    avatarUrl: friend.avatarUrl ?? null,
    status: friend.status,
    username: friend.username ?? null,
    handle: friend.handle ?? null,
    customStatus: friend.customStatus ?? null,
  };
}

/**
 * The 1:1 conversation with this friend, if the account already has one.
 * A group never counts: pinning a group is not pinning this person.
 */
export function directConversationWith(
  conversations: readonly DmSummary[] | undefined,
  friendId: string,
): DmSummary | null {
  return (
    conversations?.find(
      (conversation) =>
        conversation.participants.length === 1 &&
        conversation.participants[0]!.id === friendId,
    ) ?? null
  );
}

/**
 * A friend row's right-click and long-press menu: the DM list row's menu for
 * the same person (Ver perfil, Fixar, Bloquear), with "Remover amigo" at the
 * end because the row is where the friendship lives.
 *
 * "Fixar" needs a conversation to pin, so it is offered only once a 1:1 with
 * this friend exists. Everything else works from the friendship alone.
 */
export function friendRowMenuItems({
  t,
  friend,
  conversation,
  pinned,
  onOpenProfile,
  onTogglePin,
  onBlock,
  onRemove,
}: {
  t: (key: MessageKey) => string;
  friend: Friend;
  conversation: DmSummary | null;
  pinned: boolean;
  onOpenProfile: () => void;
  onTogglePin?: (channelId: string) => void;
  onBlock?: (user: Friend) => void;
  onRemove: (friend: Friend) => void;
}): ContextMenuItemDef[] {
  const items: ContextMenuItemDef[] = [
    {
      id: "profile",
      label: t("profile.viewProfile"),
      icon: UserRound,
      onSelect: onOpenProfile,
    },
  ];
  if (conversation && onTogglePin) {
    items.push({
      id: "pin",
      label: pinned
        ? t("chrome.unpinConversation")
        : t("chrome.pinConversation"),
      icon: pinned ? PinOff : Pin,
      onSelect: () => onTogglePin(conversation.channelId),
    });
  }
  items.push({ id: "sep", label: "", separator: true });
  if (onBlock) {
    items.push({
      id: "block",
      label: t("profile.block"),
      icon: Ban,
      danger: true,
      onSelect: () => onBlock(friend),
    });
  }
  items.push({
    id: "remove",
    label: t("friends.remove"),
    icon: UserMinus,
    danger: true,
    onSelect: () => onRemove(friend),
  });
  return items;
}
