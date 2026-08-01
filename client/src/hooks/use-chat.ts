import type {
  ChatServerMessage,
  Message,
  MessageBroadcast,
  MessageReaction,
  PresenceUpdate,
  ReactionBroadcast,
} from "@pqp/shared";
import { MESSAGE_PAGE_SIZE } from "@pqp/shared";
import {
  deleteMessage as deleteMessageRequest,
  editMessage as editMessageRequest,
  fetchMessages,
} from "@/lib/api";
import type { RealtimeTransport } from "@/lib/realtime";

/** A message plus the client-only state an optimistic bubble needs. */
export interface ChatMessage extends Message {
  pending?: boolean;
  failed?: boolean;
  /** Correlates the optimistic bubble with the server's broadcast. */
  nonce?: string;
}

export interface TypingUser {
  userId: string;
  displayName: string;
}

/** How long a typing indicator survives without a refresh. */
const TYPING_TTL_MS = 5_000;
/** Do not tell the server about every keystroke. */
const TYPING_THROTTLE_MS = 2_500;
/** A send with no broadcast back within this window is treated as failed. */
const SEND_TIMEOUT_MS = 10_000;

function applyReactionBroadcast(
  reactions: MessageReaction[],
  broadcast: ReactionBroadcast,
  currentUserId: string | null,
): MessageReaction[] {
  const existing = reactions.find((r) => r.emoji === broadcast.emoji);
  const isMe = broadcast.userId === currentUserId;

  if (broadcast.added) {
    if (!existing) {
      return [...reactions, { emoji: broadcast.emoji, count: 1, me: isMe }];
    }
    return reactions.map((r) =>
      r.emoji === broadcast.emoji
        ? { ...r, count: r.count + 1, me: r.me || isMe }
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
      ? { ...r, count: r.count - 1, me: isMe ? false : r.me }
      : r,
  );
}

/** The broadcast schema leaves authorTag optional; the UI type does not. */
function toChatMessage(message: MessageBroadcast["message"]): ChatMessage {
  return {
    ...message,
    authorTag: message.authorTag ?? null,
    reactions: message.reactions ?? [],
  };
}

let nonceCounter = 0;
function createNonce(): string {
  nonceCounter += 1;
  return `${Date.now().toString(36)}-${nonceCounter}`;
}

export function createChatController(transport: RealtimeTransport) {
  let messages: ChatMessage[] = [];
  let presence: PresenceUpdate["users"] = [];
  let channelId: string | null = null;
  let currentUserId: string | null = null;
  let currentUser: { displayName: string; avatarUrl: string | null; tag: string | null } | null =
    null;
  let listener: (() => void) | null = null;
  let hasMore = false;
  let loadingOlder = false;

  const typing = new Map<string, { displayName: string; expiresAt: number }>();
  const sendTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let lastTypingSentAt = 0;
  let typingSweep: ReturnType<typeof setInterval> | null = null;

  function emit() {
    listener?.();
  }

  function clearSendTimer(nonce: string) {
    const timer = sendTimers.get(nonce);
    if (timer) {
      clearTimeout(timer);
      sendTimers.delete(nonce);
    }
  }

  function markFailed(nonce: string) {
    let changed = false;
    messages = messages.map((message) => {
      if (message.nonce !== nonce || !message.pending) {
        return message;
      }
      changed = true;
      return { ...message, pending: false, failed: true };
    });
    if (changed) {
      emit();
    }
  }

  function transmit(nonce: string, body: string, targetChannelId: string) {
    clearSendTimer(nonce);
    // Only start the failure clock once the message is actually on the wire.
    // While offline the transport queues it and delivers it on reconnect, so
    // failing it here would invite a retry that sends the same message twice.
    if (transport.isConnected()) {
      sendTimers.set(
        nonce,
        setTimeout(() => markFailed(nonce), SEND_TIMEOUT_MS),
      );
    }
    transport.sendChat({
      type: "message-create",
      channelId: targetChannelId,
      body,
      nonce,
    });
  }

  function startTypingSweep() {
    if (typingSweep) {
      return;
    }
    typingSweep = setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const [userId, entry] of typing) {
        if (entry.expiresAt <= now) {
          typing.delete(userId);
          changed = true;
        }
      }
      if (typing.size === 0 && typingSweep) {
        clearInterval(typingSweep);
        typingSweep = null;
      }
      if (changed) {
        emit();
      }
    }, 1_000);
  }

  function resetChannelState() {
    for (const timer of sendTimers.values()) {
      clearTimeout(timer);
    }
    sendTimers.clear();
    typing.clear();
    messages = [];
    presence = [];
    hasMore = false;
  }

  return {
    onChange(cb: () => void) {
      listener = cb;
    },

    setCurrentUser(user: {
      id: string;
      displayName: string;
      avatarUrl: string | null;
      tag: string | null;
    } | null) {
      currentUserId = user?.id ?? null;
      currentUser = user
        ? {
            displayName: user.displayName,
            avatarUrl: user.avatarUrl,
            tag: user.tag,
          }
        : null;
    },

    getMessages() {
      return messages;
    },

    getPresence() {
      return presence;
    },

    getTypingUsers(): TypingUser[] {
      const now = Date.now();
      return [...typing.entries()]
        .filter(([, entry]) => entry.expiresAt > now)
        .map(([userId, entry]) => ({ userId, displayName: entry.displayName }));
    },

    getChannelId() {
      return channelId;
    },

    hasMoreHistory() {
      return hasMore;
    },

    isLoadingOlder() {
      return loadingOlder;
    },

    setMessages(next: Message[], moreAvailable = false) {
      // A history re-sync (channel open, or a resync after reconnect) must not
      // throw away a message the user is still sending — the reconnect path
      // would otherwise silently swallow anything typed as the socket dropped.
      const stored = new Set(next.map((message) => message.id));
      const inFlight = messages.filter(
        (message) =>
          (message.pending || message.failed) && !stored.has(message.id),
      );

      messages = [
        ...next.map((message) => ({
          ...message,
          reactions: message.reactions ?? [],
        })),
        ...inFlight,
      ];
      hasMore = moreAvailable;
      emit();
    },

    /**
     * Prepend one page of older history. Returns how many messages were added so
     * the caller can restore scroll position.
     */
    async loadOlder(): Promise<number> {
      const target = channelId;
      const oldest = messages.find((message) => !message.pending);
      if (!target || !oldest || !hasMore || loadingOlder) {
        return 0;
      }
      loadingOlder = true;
      emit();
      try {
        const page = await fetchMessages(target, {
          before: oldest.id,
          limit: MESSAGE_PAGE_SIZE,
        });
        if (channelId !== target) {
          return 0;
        }
        const known = new Set(messages.map((message) => message.id));
        const older = page.messages.filter(
          (message) => !known.has(message.id),
        );
        messages = [...older, ...messages];
        hasMore = page.hasMore;
        return older.length;
      } catch (error) {
        // A cursor the server no longer recognises (the message was deleted)
        // can never succeed — stop offering to load more rather than looping.
        if (
          error instanceof Error &&
          "status" in error &&
          (error as { status?: number }).status === 400
        ) {
          hasMore = false;
        }
        return 0;
      } finally {
        loadingOlder = false;
        emit();
      }
    },

    joinChannel(nextChannelId: string) {
      if (channelId === nextChannelId) {
        return;
      }
      if (channelId) {
        transport.sendChat({ type: "leave-channel" });
      }
      channelId = nextChannelId;
      resetChannelState();
      transport.sendChat({ type: "join-channel", channelId: nextChannelId });
      emit();
    },

    /** Re-subscribe after a reconnect without clearing what is on screen. */
    resubscribe() {
      if (channelId) {
        transport.sendChat({ type: "join-channel", channelId });
      }
    },

    leaveChannel() {
      if (channelId) {
        transport.sendChat({ type: "leave-channel" });
      }
      channelId = null;
      resetChannelState();
      emit();
    },

    sendMessage(body: string) {
      if (!channelId || !currentUserId) {
        return;
      }
      const nonce = createNonce();
      const optimistic: ChatMessage = {
        id: `pending:${nonce}`,
        channelId,
        authorId: currentUserId,
        authorName: currentUser?.displayName ?? "You",
        authorTag: currentUser?.tag ?? null,
        authorAvatarUrl: currentUser?.avatarUrl ?? null,
        body,
        createdAt: new Date().toISOString(),
        editedAt: null,
        reactions: [],
        pending: true,
        nonce,
      };
      messages = [...messages, optimistic];
      emit();
      transmit(nonce, body, channelId);
    },

    retryMessage(nonce: string) {
      const failed = messages.find((message) => message.nonce === nonce);
      if (!failed || !channelId) {
        return;
      }
      messages = messages.map((message) =>
        message.nonce === nonce
          ? { ...message, pending: true, failed: false }
          : message,
      );
      emit();
      transmit(nonce, failed.body, channelId);
    },

    discardMessage(nonce: string) {
      clearSendTimer(nonce);
      messages = messages.filter((message) => message.nonce !== nonce);
      emit();
    },

    async editMessage(messageId: string, body: string) {
      const previous = messages;
      messages = messages.map((message) =>
        message.id === messageId
          ? { ...message, body, editedAt: new Date().toISOString() }
          : message,
      );
      emit();
      try {
        await editMessageRequest(messageId, body);
      } catch (error) {
        messages = previous;
        emit();
        throw error;
      }
    },

    async deleteMessage(messageId: string) {
      const previous = messages;
      messages = messages.filter((message) => message.id !== messageId);
      emit();
      try {
        await deleteMessageRequest(messageId);
      } catch (error) {
        messages = previous;
        emit();
        throw error;
      }
    },

    notifyTyping() {
      const now = Date.now();
      if (!channelId || now - lastTypingSentAt < TYPING_THROTTLE_MS) {
        return;
      }
      lastTypingSentAt = now;
      transport.sendChat({ type: "typing", channelId });
    },

    toggleReaction(messageId: string, emoji: string) {
      if (!channelId || messageId.startsWith("pending:")) {
        return;
      }
      transport.sendChat({
        type: "reaction-toggle",
        channelId,
        messageId,
        emoji,
      });
    },

    handleServerMessage(message: ChatServerMessage) {
      switch (message.type) {
        case "message-broadcast": {
          if (message.message.channelId !== channelId) {
            return;
          }

          const incoming = toChatMessage(message.message);

          // Our own message coming back: swap the optimistic bubble in place so
          // it does not appear twice and does not jump position.
          if (message.nonce) {
            clearSendTimer(message.nonce);
            const index = messages.findIndex(
              (entry) => entry.nonce === message.nonce,
            );
            if (index >= 0) {
              messages = [
                ...messages.slice(0, index),
                incoming,
                ...messages.slice(index + 1),
              ];
              emit();
              return;
            }
          }

          if (messages.some((entry) => entry.id === incoming.id)) {
            return;
          }
          messages = [...messages, incoming];
          emit();
          return;
        }

        case "message-update": {
          if (message.message.channelId !== channelId) {
            return;
          }
          const updated = toChatMessage(message.message);
          messages = messages.map((entry) =>
            entry.id === updated.id ? { ...entry, ...updated } : entry,
          );
          emit();
          return;
        }

        case "message-delete": {
          if (message.channelId !== channelId) {
            return;
          }
          messages = messages.filter((entry) => entry.id !== message.messageId);
          emit();
          return;
        }

        case "reaction-broadcast": {
          if (message.channelId !== channelId) {
            return;
          }
          messages = messages.map((entry) =>
            entry.id === message.messageId
              ? {
                  ...entry,
                  reactions: applyReactionBroadcast(
                    entry.reactions ?? [],
                    message,
                    currentUserId,
                  ),
                }
              : entry,
          );
          emit();
          return;
        }

        case "typing-broadcast": {
          if (
            message.channelId !== channelId ||
            message.userId === currentUserId
          ) {
            return;
          }
          typing.set(message.userId, {
            displayName: message.displayName,
            expiresAt: Date.now() + TYPING_TTL_MS,
          });
          startTypingSweep();
          emit();
          return;
        }

        case "presence-update": {
          if (message.channelId === channelId) {
            presence = message.users;
            emit();
          }
          return;
        }

        // Unread badges are owned by the app shell, not the channel view.
        case "channel-activity":
          return;
      }
    },

    dispose() {
      resetChannelState();
      if (typingSweep) {
        clearInterval(typingSweep);
        typingSweep = null;
      }
      listener = null;
    },
  };
}

export type ChatController = ReturnType<typeof createChatController>;
