import type { DmSummary, PublicUser } from "@pqp/shared";
import { Ban, Copy, Pin, PinOff, UserRound, X } from "lucide-react";
import type { RefObject } from "react";
import type { ContextMenuItemDef } from "@/components/ui/context-menu";
import { useProfilePopover } from "@/components/user/user-profile-popover";
import {
  notificationLevelItems,
  useChannelNotificationLevel,
} from "@/hooks/use-notifications";
import { conversationTitle } from "@/lib/conversations";
import { useTranslation } from "@/lib/i18n";

/**
 * A conversation row's right-click menu, and the facts the row draws from the
 * same reads (its notification level, title, the one other person of a 1:1
 * and whether they are blocked). Shared by the classic list and the Conversas
 * list so the two can never offer different things for the same row.
 */
export function useConversationRowMenu({
  conversation,
  blockedUserIds,
  rowRef,
  onHide,
  pinned,
  onTogglePin,
  onBlock,
  onUnblock,
}: {
  conversation: DmSummary;
  blockedUserIds: ReadonlySet<string>;
  /** What the profile card hangs off, since the trigger is a menu item. */
  rowRef: RefObject<HTMLElement | null>;
  onHide: () => void;
  pinned?: boolean;
  onTogglePin?: () => void;
  onBlock: (user: PublicUser) => void;
  onUnblock: (userId: string) => void;
}) {
  const { t } = useTranslation();
  const openProfile = useProfilePopover();
  // The same per-channel levels a server channel gets. Muting a conversation is
  // the same act as muting #general, and giving it its own store would be a
  // second place for "leave me alone" to be recorded and forgotten.
  const notifications = useChannelNotificationLevel({
    id: conversation.channelId,
    serverId: null,
  });
  const title = conversationTitle(conversation.participants);
  // Blocking is between two people. In a group there is no single "them" to
  // block, and blocking one member would leave you in a room reading around a
  // hole — so the row only offers it for a 1:1.
  const solo =
    conversation.participants.length === 1 ? conversation.participants[0]! : null;
  const blocked = solo ? blockedUserIds.has(solo.id) : false;

  const items: ContextMenuItemDef[] = [
    // The profile card is a menu item here rather than a click on the avatar,
    // which is the one place it does NOT drop in cleanly: a conversation row
    // is one big button whose entire job is opening the conversation, and
    // stealing part of it for a popover would break the row's own purpose.
    // A group row offers nothing — there is no single "them" to profile.
    ...(solo
      ? [
          {
            id: "profile",
            label: t("profile.viewProfile"),
            icon: UserRound,
            onSelect: () => {
              const anchor = rowRef.current;
              if (anchor) {
                openProfile(
                  {
                    id: solo.id,
                    displayName: solo.displayName,
                    tag: solo.tag ?? null,
                    avatarUrl: solo.avatarUrl ?? null,
                  },
                  anchor,
                );
              }
            },
          },
        ]
      : []),
    ...(onTogglePin
      ? [
          {
            id: "pin",
            label: pinned
              ? t("chrome.unpinConversation")
              : t("chrome.pinConversation"),
            icon: pinned ? PinOff : Pin,
            onSelect: onTogglePin,
          },
        ]
      : []),
    {
      id: "copy-id",
      label: t("dm.copyId"),
      icon: Copy,
      onSelect: () => void navigator.clipboard.writeText(conversation.channelId),
    },
    ...notificationLevelItems("notify", notifications, "account"),
    { id: "sep", label: "", separator: true },
    {
      id: "hide",
      label: t("dm.close"),
      icon: X,
      onSelect: onHide,
    },
  ];
  if (solo) {
    items.push(
      blocked
        ? {
            id: "unblock",
            label: t("profile.unblock"),
            icon: Ban,
            onSelect: () => onUnblock(solo.id),
          }
        : {
            id: "block",
            label: t("profile.block"),
            icon: Ban,
            danger: true,
            onSelect: () => onBlock(solo),
          },
    );
  }


  return { items, notifications, title, solo, blocked };
}
