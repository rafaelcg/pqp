import type {
  Message,
  MessageReaction,
  PresenceUpdate,
  ReactionBroadcast,
} from "@pqp/shared";
import type { RealtimeTransport } from "@/lib/realtime";

function applyReactionBroadcast(
  reactions: MessageReaction[],
  broadcast: ReactionBroadcast,
  currentUserId: string | null,
): MessageReaction[] {
  const existing = reactions.find((r) => r.emoji === broadcast.emoji);
  const isMe = broadcast.userId === currentUserId;

  if (broadcast.added) {
    if (!existing) {
      return [
        ...reactions,
        { emoji: broadcast.emoji, count: 1, me: isMe },
      ];
    }
    return reactions.map((r) =>
      r.emoji === broadcast.emoji
        ? {
            ...r,
            count: r.count + 1,
            me: r.me || isMe,
          }
        : r,
    );
  }

  if (!existing) {
    return reactions;
  }

  if (existing.count <= 1) {
    return reactions.filter((r) => r.emoji !== broadcast.emoji);
  }

  return reactions.map((r) =>
    r.emoji === broadcast.emoji
      ? {
          ...r,
          count: r.count - 1,
          me: isMe ? false : r.me,
        }
      : r,
  );
}

export function createChatController(transport: RealtimeTransport) {
  let messages: Message[] = [];
  let presence: PresenceUpdate["users"] = [];
  let channelId: string | null = null;
  let currentUserId: string | null = null;
  let listener: (() => void) | null = null;

  function emit() {
    listener?.();
  }

  return {
    onChange(cb: () => void) {
      listener = cb;
    },

    setCurrentUserId(userId: string | null) {
      currentUserId = userId;
    },

    getMessages() {
      return messages;
    },

    getPresence() {
      return presence;
    },

    getChannelId() {
      return channelId;
    },

    setMessages(next: Message[]) {
      messages = next.map((message) => ({
        ...message,
        reactions: message.reactions ?? [],
      }));
      emit();
    },

    joinChannel(nextChannelId: string) {
      if (channelId) {
        transport.sendChat({ type: "leave-channel" });
      }
      channelId = nextChannelId;
      messages = [];
      presence = [];
      transport.sendChat({ type: "join-channel", channelId: nextChannelId });
      emit();
    },

    leaveChannel() {
      if (channelId) {
        transport.sendChat({ type: "leave-channel" });
      }
      channelId = null;
      messages = [];
      presence = [];
      emit();
    },

    sendMessage(body: string) {
      if (!channelId) {
        return;
      }
      transport.sendChat({
        type: "message-create",
        channelId,
        body,
      });
    },

    toggleReaction(messageId: string, emoji: string) {
      if (!channelId) {
        return;
      }
      transport.sendChat({
        type: "reaction-toggle",
        channelId,
        messageId,
        emoji,
      });
    },

    handleServerMessage(message: { type: string }) {
      if (message.type === "message-broadcast") {
        const broadcast = message as {
          type: "message-broadcast";
          message: Message;
        };
        if (broadcast.message.channelId === channelId) {
          messages = [
            ...messages,
            {
              ...broadcast.message,
              reactions: broadcast.message.reactions ?? [],
            },
          ];
          emit();
        }
        return;
      }

      if (message.type === "reaction-broadcast") {
        const broadcast = message as ReactionBroadcast;
        if (broadcast.channelId !== channelId) {
          return;
        }
        messages = messages.map((entry) => {
          if (entry.id !== broadcast.messageId) {
            return entry;
          }
          return {
            ...entry,
            reactions: applyReactionBroadcast(
              entry.reactions ?? [],
              broadcast,
              currentUserId,
            ),
          };
        });
        emit();
        return;
      }

      if (message.type === "message-deleted") {
        const broadcast = message as {
          type: "message-deleted";
          channelId: string;
          messageId: string;
        };
        if (broadcast.channelId === channelId) {
          messages = messages.filter((m) => m.id !== broadcast.messageId);
          emit();
        }
        return;
      }

      if (message.type === "presence-update") {
        const update = message as PresenceUpdate;
        if (update.channelId === channelId) {
          presence = update.users;
          emit();
        }
      }
    },
  };
}
