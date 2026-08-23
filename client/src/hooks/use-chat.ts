import type {
  Attachment,
  ChatClientMessage,
  ChatServerMessage,
  Message,
  MessageBroadcast,
  MessageReaction,
  PresenceUpdate,
  ReactionBroadcast,
  ThreadSummary,
} from "@pqp/shared";
import {
  buildReplyExcerpt,
  extractMentionUsernames,
  MESSAGE_PAGE_SIZE,
} from "@pqp/shared";
import { notifyOpenChannelMessage } from "@/lib/notifications";
import {
  apiFetch,
  deleteMessage as deleteMessageRequest,
  editMessage as editMessageRequest,
  pinMessage as pinMessageRequest,
  unpinMessage as unpinMessageRequest,
} from "@/lib/api";
import { revokePreviewUrl, type OutgoingAttachment } from "@/lib/attachments";
import type { RealtimeTransport } from "@/lib/realtime";

function messageNamesUser(
  body: string,
  username: string | null,
  replyAuthorId: string | null | undefined,
  readerId: string | null,
): boolean {
  if (readerId && replyAuthorId === readerId) {
    return true;
  }
  if (!username) {
    return false;
  }
  return extractMentionUsernames(body).includes(username.toLowerCase());
}

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

/** What the composer needs to hand back when sending a reply. */
export interface ReplyTargetMessage {
  id: string;
  authorId: string;
  authorName: string;
  body: string;
}

/** One page of history plus the overflow flag for each end of it. */
interface HistoryPage {
  messages: Message[];
  hasMore: boolean;
  hasNewer: boolean;
}

/**
 * Reads history in either direction. The endpoint is called directly because
 * this is the only caller that needs the forward cursors, and a page fetched
 * here is the only thing that may move the window off the newest message.
 */
function fetchHistory(
  channelId: string,
  params: { limit: number; before?: string; after?: string; around?: string },
): Promise<HistoryPage> {
  const query = new URLSearchParams({ limit: String(params.limit) });
  if (params.before) {
    query.set("before", params.before);
  }
  if (params.after) {
    query.set("after", params.after);
  }
  if (params.around) {
    query.set("around", params.around);
  }
  return apiFetch<HistoryPage>(
    `/api/channels/${channelId}/messages?${query.toString()}`,
  );
}

/**
 * A cursor the server no longer recognises (the message was deleted) can never
 * succeed, so the direction it points in has to stop offering itself.
 */
function isUnknownCursor(error: unknown): boolean {
  return (
    error instanceof Error &&
    "status" in error &&
    (error as { status?: number }).status === 400
  );
}

/** Server payloads leave reactions and replyTo optional; the UI type does not. */
function toStoredMessage(message: Message): ChatMessage {
  return {
    ...message,
    reactions: message.reactions ?? [],
    replyTo: message.replyTo ?? null,
    attachments: message.attachments ?? [],
  };
}

function isOptimistic(message: ChatMessage): boolean {
  return Boolean(message.pending || message.failed);
}

/**
 * Release the `blob:` URLs an optimistic bubble was rendering.
 *
 * Each one pins the whole uploaded file in memory for as long as the document
 * lives — a session that posts a dozen screenshots would otherwise still be
 * holding every one of them — so the moment the bubble is replaced by the real
 * message, which carries real storage URLs, they have to go. Only ever called
 * on a message that is leaving: a retry keeps rendering these.
 */
function revokeLocalPreviews(message: ChatMessage): void {
  if (!isOptimistic(message)) {
    return;
  }
  for (const attachment of message.attachments ?? []) {
    revokePreviewUrl(attachment.url);
  }
}

/** The order the server pages on, so a merged page reads the same either way. */
function byPosition(a: ChatMessage, b: ChatMessage): number {
  if (a.createdAt !== b.createdAt) {
    return a.createdAt < b.createdAt ? -1 : 1;
  }
  return a.id < b.id ? -1 : 1;
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
    replyTo: message.replyTo ?? null,
    attachments: message.attachments ?? [],
  };
}

let nonceCounter = 0;
function createNonce(): string {
  nonceCounter += 1;
  return `${Date.now().toString(36)}-${nonceCounter}`;
}

// --- threads ---
/**
 * Which WS frames subscribe and unsubscribe this controller's channel. The
 * default is the primary view (`join-channel`, which the server treats as
 * exclusive); the thread panel passes the `thread-join` pair instead, which
 * targets the server's secondary view slot — so a thread controller can run
 * beside the main one without stealing its live delivery.
 */
export interface ChannelFrames {
  join: (channelId: string) => ChatClientMessage;
  leave: () => ChatClientMessage;
}

const PRIMARY_CHANNEL_FRAMES: ChannelFrames = {
  join: (channelId) => ({ type: "join-channel", channelId }),
  leave: () => ({ type: "leave-channel" }),
};

export const THREAD_CHANNEL_FRAMES: ChannelFrames = {
  join: (channelId) => ({ type: "thread-join", channelId }),
  leave: () => ({ type: "thread-leave" }),
};

export function createChatController(
  transport: RealtimeTransport,
  frames: ChannelFrames = PRIMARY_CHANNEL_FRAMES,
) {
  let messages: ChatMessage[] = [];
  let presence: PresenceUpdate["users"] = [];
  let channelId: string | null = null;
  let currentUserId: string | null = null;
  let currentUsername: string | null = null;
  let currentUser: { displayName: string; avatarUrl: string | null; tag: string | null } | null =
    null;
  let listener: (() => void) | null = null;
  let hasMore = false;
  let hasNewer = false;
  let loadingOlder = false;
  let loadingNewer = false;
  /**
   * Newest message the window was actually paged up to. Distinct from the last
   * row on screen: one sent while parked in history sits at the end without
   * closing the gap the forward cursor still has to walk.
   */
  let newestLoadedId: string | null = null;

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

  function transmit(
    nonce: string,
    body: string,
    targetChannelId: string,
    replyToId?: string,
    attachmentIds: string[] = [],
  ) {
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
      ...(replyToId ? { replyToId } : {}),
      ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
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
    for (const message of messages) {
      revokeLocalPreviews(message);
    }
    messages = [];
    presence = [];
    hasMore = false;
    hasNewer = false;
    newestLoadedId = null;
  }

  /**
   * Replace the window with a fetched page. A history re-sync (channel open, a
   * resync after reconnect, a jump) must not throw away a message the user is
   * still sending — the reconnect path would otherwise silently swallow
   * anything typed as the socket dropped.
   */
  function applyPage(
    next: Message[],
    moreAvailable: boolean,
    newerAvailable: boolean,
  ) {
    const stored = new Set(next.map((message) => message.id));
    // Keeping only the *optimistic* rows was one beat short. A page requested
    // when a channel opened and answered a moment later has a window in it, and
    // a message sent into that window is usually confirmed by its broadcast
    // before the page lands — at which point it is an ordinary stored message,
    // and it was dropped, having never been in a page that predates it. That is
    // the iOS "started a thread and sent a message but that failed" report: a
    // thread is opened in order to type into it, so the send is always inside
    // that window.
    //
    // Live traffic is only carried across when BOTH windows are the tail. The
    // old window being the tail is what makes a surviving row newer than the
    // page rather than left over from somewhere else in history, and the new
    // page being the tail is what gives it a place to sit — `resetToTail` and
    // a jump both replace the window outright, and hanging live messages off
    // the end of an older one would show them an hour early.
    const carryLive = !hasNewer && !newerAvailable;
    const inFlight = messages.filter(
      (message) => !stored.has(message.id) && (carryLive || isOptimistic(message)),
    );

    messages = [...next.map(toStoredMessage), ...inFlight];
    hasMore = moreAvailable;
    hasNewer = newerAvailable;
    newestLoadedId = next[next.length - 1]?.id ?? null;
    emit();
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
      username?: string | null;
    } | null) {
      currentUserId = user?.id ?? null;
      currentUsername = user?.username ?? null;
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

    /** True while the window stops short of the newest message in the channel. */
    hasNewerHistory() {
      return hasNewer;
    },

    isLoadingOlder() {
      return loadingOlder;
    },

    isLoadingNewer() {
      return loadingNewer;
    },

    setMessages(next: Message[], moreAvailable = false, newerAvailable = false) {
      applyPage(next, moreAvailable, newerAvailable);
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
        const page = await fetchHistory(target, {
          before: oldest.id,
          limit: MESSAGE_PAGE_SIZE,
        });
        if (channelId !== target) {
          return 0;
        }
        const known = new Set(messages.map((message) => message.id));
        const older = page.messages
          .filter((message) => !known.has(message.id))
          .map(toStoredMessage);
        messages = [...older, ...messages];
        hasMore = page.hasMore;
        return older.length;
      } catch (error) {
        if (isUnknownCursor(error)) {
          hasMore = false;
        }
        return 0;
      } finally {
        loadingOlder = false;
        emit();
      }
    },

    /**
     * Append one page of newer history. Returns how many messages were added so
     * the caller can tell fetched history apart from live traffic.
     */
    async loadNewer(): Promise<number> {
      const target = channelId;
      if (!target || !newestLoadedId || !hasNewer || loadingNewer) {
        return 0;
      }
      loadingNewer = true;
      emit();
      try {
        const page = await fetchHistory(target, {
          after: newestLoadedId,
          limit: MESSAGE_PAGE_SIZE,
        });
        if (channelId !== target) {
          return 0;
        }
        const known = new Set(messages.map((message) => message.id));
        const newer = page.messages
          .filter((message) => !known.has(message.id))
          .map(toStoredMessage);
        // Sorted rather than appended: anything sent from inside the window is
        // newer than every message this page just closed the gap with.
        messages = [
          ...[...messages.filter((message) => !isOptimistic(message)), ...newer].sort(
            byPosition,
          ),
          ...messages.filter(isOptimistic),
        ];
        hasNewer = page.hasNewer;
        newestLoadedId = newer[newer.length - 1]?.id ?? newestLoadedId;
        return newer.length;
      } catch (error) {
        if (isUnknownCursor(error)) {
          hasNewer = false;
        }
        return 0;
      } finally {
        loadingNewer = false;
        emit();
      }
    },

    /**
     * Bring a message into the window, fetching history around it when it is not
     * already loaded. False means it cannot be reached at all: deleted, or in a
     * channel this window is not showing.
     */
    async jumpTo(messageId: string): Promise<boolean> {
      const target = channelId;
      if (!target) {
        return false;
      }
      if (messages.some((message) => message.id === messageId)) {
        return true;
      }
      try {
        const page = await fetchHistory(target, {
          around: messageId,
          limit: MESSAGE_PAGE_SIZE,
        });
        if (channelId !== target) {
          return false;
        }
        applyPage(page.messages, page.hasMore, page.hasNewer);
        return true;
      } catch {
        return false;
      }
    },

    /** Leave a history window behind and reload the newest page. */
    async resetToTail(): Promise<boolean> {
      const target = channelId;
      if (!target) {
        return false;
      }
      try {
        const page = await fetchHistory(target, { limit: MESSAGE_PAGE_SIZE });
        if (channelId !== target) {
          return false;
        }
        applyPage(page.messages, page.hasMore, page.hasNewer);
        return true;
      } catch {
        return false;
      }
    },

    joinChannel(nextChannelId: string) {
      if (channelId === nextChannelId) {
        return;
      }
      if (channelId) {
        transport.sendChat(frames.leave());
      }
      channelId = nextChannelId;
      resetChannelState();
      transport.sendChat(frames.join(nextChannelId));
      emit();
    },

    /** Re-subscribe after a reconnect without clearing what is on screen. */
    resubscribe() {
      if (channelId) {
        transport.sendChat(frames.join(channelId));
      }
    },

    leaveChannel() {
      if (channelId) {
        transport.sendChat(frames.leave());
      }
      channelId = null;
      resetChannelState();
      emit();
    },

    sendMessage(
      body: string,
      replyTo?: ReplyTargetMessage | null,
      attachments: OutgoingAttachment[] = [],
    ) {
      if (!channelId || !currentUserId) {
        return;
      }
      const nonce = createNonce();
      /**
       * The local files, so an image is on screen the instant Enter is pressed
       * rather than after a round trip plus a fetch from storage. `url` is a
       * `blob:` URL here and a presigned one on the message that replaces this;
       * nothing downstream has to know which, and `revokeLocalPreviews` is what
       * keeps the difference from leaking.
       */
      const optimisticAttachments: Attachment[] = attachments.map((item) => ({
        id: item.attachmentId,
        filename: item.filename,
        contentType: item.contentType,
        byteSize: item.byteSize,
        width: item.width,
        height: item.height,
        url: item.previewUrl,
      }));
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
        attachments: optimisticAttachments,
        // A message is never born pinned — only ever pinned after the fact by
        // someone reacting to it once it exists.
        pinnedAt: null,
        pinnedBy: null,
        // Same reasoning as pins: unfurling happens after the message exists,
        // via the message-update broadcast the server sends once it resolves.
        embeds: [],
        // The composer only ever sends as the signed-in user, never as a
        // webhook — an optimistic bubble is never one.
        isWebhook: false,
        webhookEmbeds: [],
        // A message is never born with a thread either.
        thread: null,
        // Built with the same helper the server uses, so the bubble does not
        // visibly rewrite itself when the broadcast comes back.
        replyTo: replyTo
          ? {
              id: replyTo.id,
              authorId: replyTo.authorId,
              authorName: replyTo.authorName,
              excerpt: buildReplyExcerpt(replyTo.body),
              deleted: false,
            }
          : null,
        pending: true,
        nonce,
      };
      messages = [...messages, optimistic];
      emit();
      transmit(
        nonce,
        body,
        channelId,
        replyTo?.id,
        optimisticAttachments.map((attachment) => attachment.id),
      );
      notifyOpenChannelMessage(
        channelId,
        messageNamesUser(body, currentUsername, replyTo?.authorId, currentUserId),
      );
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
      // The rows are still unclaimed — a claim only happens on a message that
      // was actually stored — so the same ids are still the right ones to send.
      transmit(
        nonce,
        failed.body,
        channelId,
        failed.replyTo?.id,
        (failed.attachments ?? []).map((attachment) => attachment.id),
      );
    },

    discardMessage(nonce: string) {
      clearSendTimer(nonce);
      for (const message of messages) {
        if (message.nonce === nonce) {
          revokeLocalPreviews(message);
        }
      }
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

    // Optimistic pinnedAt only — pinnedBy is left for the response/broadcast to
    // fill in, since the local session does not have its own display name to
    // hand without a round trip, and the server is about to send the real row
    // either way.
    async pinMessage(messageId: string) {
      const previous = messages;
      const optimisticPinnedAt = new Date().toISOString();
      messages = messages.map((message) =>
        message.id === messageId && !message.pinnedAt
          ? { ...message, pinnedAt: optimisticPinnedAt }
          : message,
      );
      emit();
      try {
        const { message } = await pinMessageRequest(messageId);
        messages = messages.map((entry) =>
          entry.id === messageId ? { ...entry, ...toChatMessage(message) } : entry,
        );
        emit();
      } catch (error) {
        messages = previous;
        emit();
        throw error;
      }
    },

    async unpinMessage(messageId: string) {
      const previous = messages;
      messages = messages.map((message) =>
        message.id === messageId
          ? { ...message, pinnedAt: null, pinnedBy: null }
          : message,
      );
      emit();
      try {
        await unpinMessageRequest(messageId);
      } catch (error) {
        messages = previous;
        emit();
        throw error;
      }
    },

    // --- threads ---
    /**
     * A `thread-update` frame, or the response to starting a thread: attach
     * the fresh chip summary to the origin message if it is on screen. The
     * shell owns routing the frame here because the frame names the parent
     * channel, and this controller may be showing some other channel — in
     * which case there is nothing to update and nothing to remember.
     */
    applyThreadUpdate(messageId: string, thread: ThreadSummary) {
      let changed = false;
      messages = messages.map((message) => {
        if (message.id !== messageId) {
          return message;
        }
        changed = true;
        return { ...message, thread };
      });
      if (changed) {
        emit();
      }
    },

    /**
     * Somebody changed their name or picture; repaint every message of theirs
     * that is already on screen.
     *
     * The author's name and avatar are denormalised onto each message row when
     * it is read, which is what makes a transcript one query instead of one per
     * distinct author. The cost is exactly this: a profile change is invisible
     * to already-loaded history until something rewrites it. A webhook message
     * is skipped — its author *is* the row, and its name and picture are the
     * webhook's, not the account's, so overwriting them would rename a bot to
     * whoever last edited their profile.
     */
    applyProfileUpdate(update: {
      userId: string;
      displayName: string;
      avatarUrl: string | null;
    }) {
      let changed = false;
      messages = messages.map((message) => {
        if (message.authorId !== update.userId || message.isWebhook) {
          return message;
        }
        changed = true;
        return {
          ...message,
          authorName: update.displayName,
          authorAvatarUrl: update.avatarUrl,
        };
      });
      if (changed) {
        emit();
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
              revokeLocalPreviews(messages[index]!);
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
          // The window stops short of the present, so appending here would fake
          // a continuity that paging forward then has to unpick. Returning to
          // the tail fetches this message along with everything it skipped.
          if (hasNewer) {
            return;
          }
          messages = [...messages, incoming];
          newestLoadedId = incoming.id;
          emit();
          if (incoming.authorId !== currentUserId) {
            notifyOpenChannelMessage(
              channelId,
              messageNamesUser(
                incoming.body,
                currentUsername,
                incoming.replyTo?.authorId,
                currentUserId,
              ),
            );
          }
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

        case "message-delete":
        case "message-deleted": {
          if (message.channelId !== channelId) {
            return;
          }
          messages = messages
            .filter((entry) => entry.id !== message.messageId)
            // The parent column is nulled server-side, so nothing will ever
            // re-tell us this. Marking it here is what keeps a reply from
            // pointing at a row that is no longer on screen.
            .map((entry) =>
              entry.replyTo && entry.replyTo.id === message.messageId
                ? {
                    ...entry,
                    replyTo: {
                      ...entry.replyTo,
                      authorId: null,
                      authorName: null,
                      excerpt: "",
                      deleted: true,
                    },
                  }
                : entry,
            );
          // The forward cursor cannot point at a row the server has forgotten:
          // paging from it would 400 and strand the reader in history.
          if (newestLoadedId === message.messageId) {
            newestLoadedId =
              [...messages].reverse().find((entry) => !isOptimistic(entry))
                ?.id ?? null;
          }
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
