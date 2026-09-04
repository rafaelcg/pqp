import type { Message } from "@pqp/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChatController } from "./use-chat";
import type { RealtimeTransport } from "@/lib/realtime";

const notifyOpenChannelMessage = vi.fn();

vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(),
  editMessage: vi.fn(),
  deleteMessage: vi.fn(),
}));

vi.mock("@/lib/notifications", () => ({
  notifyOpenChannelMessage: (...args: unknown[]) =>
    notifyOpenChannelMessage(...args),
}));

const api = await import("@/lib/api");

interface HistoryPage {
  messages: Message[];
  hasMore: boolean;
  hasNewer: boolean;
}

/** The controller talks to the endpoint directly, so pages arrive as URLs. */
function mockPage(page: Partial<HistoryPage>) {
  vi.mocked(api.apiFetch).mockResolvedValueOnce({
    messages: [],
    hasMore: false,
    hasNewer: false,
    ...page,
  });
}

function requestedUrl(call = 0): string {
  return vi.mocked(api.apiFetch).mock.calls[call]![0];
}

function createTransport() {
  const sent: unknown[] = [];
  const state = { connected: true };
  const transport: RealtimeTransport = {
    connect: () => {},
    disconnect: () => {},
    sendChat: (message) => sent.push(message),
    sendVoice: (message) => sent.push(message),
    onMessage: () => {},
    onReady: () => {},
    onError: () => {},
    onClose: () => {},
    onAuthUnavailable: () => {},
    onStatusChange: () => {},
    getStatus: () => (state.connected ? "online" : "reconnecting"),
    isConnected: () => state.connected,
    retryNow: () => {},
    getLastClose: () => null,
    getUnauthorizedStreak: () => 0,
  };
  return { transport, sent, state };
}

const ME = {
  id: "00000000-0000-4000-8000-000000000001",
  displayName: "Me",
  avatarUrl: null,
  tag: "me#0001",
  username: "me",
};

function serverMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "00000000-0000-4000-8000-00000000000a",
    channelId: "c0000000-0000-4000-8000-000000000001",
    authorId: ME.id,
    authorName: "Me",
    authorTag: "me#0001",
    authorAvatarUrl: null,
    body: "hello",
    createdAt: new Date(0).toISOString(),
    editedAt: null,
    reactions: [],
    replyTo: null,
    attachments: [],
    pinnedAt: null,
    pinnedBy: null,
    embeds: [],
    isWebhook: false,
    webhookEmbeds: [],
    mentionEveryone: false,
    mentionHere: false,
    thread: null,
    chance: null,
    poll: null,
    ...overrides,
  };
}

const CHANNEL = "c0000000-0000-4000-8000-000000000001";

function setup() {
  const { transport, sent, state } = createTransport();
  const chat = createChatController(transport);
  chat.setCurrentUser(ME);
  chat.joinChannel(CHANNEL);
  return { chat, sent, transport: state };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  notifyOpenChannelMessage.mockReset();
});

describe("optimistic sending", () => {
  it("shows the message immediately as pending and sends a nonce", () => {
    const { chat, sent } = setup();
    chat.sendMessage("hi there");

    const [message] = chat.getMessages();
    expect(message?.body).toBe("hi there");
    expect(message?.pending).toBe(true);

    const outgoing = sent.at(-1) as { type: string; nonce?: string };
    expect(outgoing.type).toBe("message-create");
    expect(outgoing.nonce).toBe(message?.nonce);
  });

  it("replaces the optimistic bubble in place when the broadcast returns", () => {
    const { chat } = setup();
    chat.sendMessage("hi there");
    const nonce = chat.getMessages()[0]!.nonce!;

    chat.handleServerMessage({
      type: "message-broadcast",
      message: serverMessage({ body: "hi there" }),
      nonce,
    } as never);

    const messages = chat.getMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0]!.pending).toBeFalsy();
    expect(messages[0]!.id).not.toContain("pending:");
  });

  it("does not duplicate a broadcast that arrives twice", () => {
    const { chat } = setup();
    const message = serverMessage({ authorId: "someone-else" });

    chat.handleServerMessage({ type: "message-broadcast", message } as never);
    chat.handleServerMessage({ type: "message-broadcast", message } as never);

    expect(chat.getMessages()).toHaveLength(1);
  });

  it("marks a message failed when no broadcast arrives, and retries on demand", () => {
    const { chat, sent } = setup();
    chat.sendMessage("hi");
    const nonce = chat.getMessages()[0]!.nonce!;

    vi.advanceTimersByTime(11_000);
    expect(chat.getMessages()[0]!.failed).toBe(true);
    expect(chat.getMessages()[0]!.pending).toBe(false);

    const before = sent.length;
    chat.retryMessage(nonce);
    expect(sent.length).toBe(before + 1);
    expect(chat.getMessages()[0]!.pending).toBe(true);
    expect(chat.getMessages()[0]!.failed).toBe(false);
  });

  it("discards a failed message on request", () => {
    const { chat } = setup();
    chat.sendMessage("hi");
    const nonce = chat.getMessages()[0]!.nonce!;
    vi.advanceTimersByTime(11_000);

    chat.discardMessage(nonce);
    expect(chat.getMessages()).toHaveLength(0);
  });

  it("marks a message failed with the server's reason, not the send timer", () => {
    const { chat } = setup();
    chat.sendMessage("hi");
    const nonce = chat.getMessages()[0]!.nonce!;

    chat.handleServerMessage({
      type: "message-rejected",
      channelId: CHANNEL,
      nonce,
      reason: "undeliverable",
    });

    const message = chat.getMessages()[0]!;
    expect(message.failed).toBe(true);
    expect(message.pending).toBe(false);
    expect(message.rejectReason).toBe("undeliverable");

    vi.advanceTimersByTime(11_000);
    expect(chat.getMessages()[0]!.rejectReason).toBe("undeliverable");
  });

  it("writes the server reason onto a bubble the send timer already failed", () => {
    const { chat } = setup();
    chat.sendMessage("hi");
    const nonce = chat.getMessages()[0]!.nonce!;
    vi.advanceTimersByTime(11_000);
    expect(chat.getMessages()[0]!.failed).toBe(true);
    expect(chat.getMessages()[0]!.rejectReason).toBeUndefined();

    chat.handleServerMessage({
      type: "message-rejected",
      channelId: CHANNEL,
      nonce,
      reason: "cannot-send",
    });

    expect(chat.getMessages()[0]!.rejectReason).toBe("cannot-send");
    expect(chat.getMessages()[0]!.failed).toBe(true);
  });

  it("holds retry until retryAfterMs has elapsed", () => {
    const { chat, sent } = setup();
    chat.sendMessage("hi");
    const nonce = chat.getMessages()[0]!.nonce!;

    chat.handleServerMessage({
      type: "message-rejected",
      channelId: CHANNEL,
      nonce,
      reason: "rate-limited",
      retryAfterMs: 2000,
    });

    const before = sent.length;
    chat.retryMessage(nonce);
    expect(sent.length).toBe(before);
    expect(chat.getMessages()[0]!.failed).toBe(true);

    vi.advanceTimersByTime(2000);
    chat.retryMessage(nonce);
    expect(sent.length).toBe(before + 1);
    expect(chat.getMessages()[0]!.pending).toBe(true);
    expect(chat.getMessages()[0]!.rejectReason).toBeUndefined();
  });

  it("ignores a rejection for another channel", () => {
    const { chat } = setup();
    chat.sendMessage("hi");

    chat.handleServerMessage({
      type: "message-rejected",
      channelId: "c0000000-0000-4000-8000-000000000099",
      nonce: chat.getMessages()[0]!.nonce!,
      reason: "no-access",
    });

    expect(chat.getMessages()[0]!.pending).toBe(true);
    expect(chat.getMessages()[0]!.failed).toBeFalsy();
  });

  it("keeps a message pending while offline instead of failing it", () => {
    // The transport queues and delivers on reconnect, so failing the bubble
    // would invite a retry that sends the same message twice.
    const { chat, transport } = setup();
    transport.connected = false;
    chat.sendMessage("queued while offline");

    vi.advanceTimersByTime(30_000);
    expect(chat.getMessages()[0]!.pending).toBe(true);
    expect(chat.getMessages()[0]!.failed).toBeFalsy();
  });

  it("keeps an in-flight message through a history re-sync", () => {
    // The reconnect path re-fetches history; without this a message typed as
    // the socket dropped would vanish from the UI with no trace.
    const { chat } = setup();
    chat.sendMessage("typed as the socket dropped");
    expect(chat.getMessages()).toHaveLength(1);

    chat.setMessages([serverMessage({ body: "from the server" })], false);

    const bodies = chat.getMessages().map((m) => m.body);
    expect(bodies).toEqual(["from the server", "typed as the socket dropped"]);
    expect(chat.getMessages()[1]!.pending).toBe(true);
  });

  it("keeps a message the broadcast confirmed while the page was in flight", () => {
    // The window that made "start a thread and say something" lose the message
    // on iOS: a thread is opened *in order to type into it*, so the send lands
    // between the history request and its answer — and by the time the page
    // arrives the broadcast has already retired the optimistic row, leaving an
    // ordinary stored message that the page (which predates it) cannot contain.
    const { chat } = setup();
    chat.sendMessage("first thing said in the thread");
    const nonce = chat.getMessages()[0]!.nonce!;
    const confirmed = serverMessage({
      id: "00000000-0000-4000-8000-0000000000aa",
      body: "first thing said in the thread",
    });
    chat.handleServerMessage({
      type: "message-broadcast",
      message: confirmed,
      nonce,
    } as never);
    expect(chat.getMessages()[0]!.pending).toBeFalsy();

    // The page that was already in flight when the thread opened: empty, and
    // the tail (`hasNewer` false), because nothing had been said yet.
    chat.setMessages([], false, false);

    expect(chat.getMessages().map((m) => m.body)).toEqual([
      "first thing said in the thread",
    ]);
  });

  it("does not append live traffic onto a jumped-to window of older history", () => {
    // A page that stops short of the newest message is a jump, not a re-sync;
    // hanging live messages off the end of it would show them an hour early.
    const { chat } = setup();
    chat.handleServerMessage({
      type: "message-broadcast",
      message: serverMessage({
        id: "00000000-0000-4000-8000-0000000000bb",
        body: "live",
      }),
    } as never);

    chat.setMessages([serverMessage({ body: "old" })], true, true);

    expect(chat.getMessages().map((m) => m.body)).toEqual(["old"]);
  });

  it("drops an optimistic message the re-sync already contains", () => {
    const { chat } = setup();
    chat.sendMessage("hello");
    const nonce = chat.getMessages()[0]!.nonce!;
    chat.handleServerMessage({
      type: "message-broadcast",
      message: serverMessage({ body: "hello" }),
      nonce,
    } as never);

    chat.setMessages([serverMessage({ body: "hello" })], false);
    expect(chat.getMessages()).toHaveLength(1);
  });

  it("ignores broadcasts for a different channel", () => {
    const { chat } = setup();
    chat.handleServerMessage({
      type: "message-broadcast",
      message: serverMessage({
        channelId: "c0000000-0000-4000-8000-0000000000ff",
      }),
    } as never);
    expect(chat.getMessages()).toHaveLength(0);
  });
});

describe("reactions", () => {
  it("adds, increments and removes a reaction", () => {
    const { chat } = setup();
    chat.setMessages([serverMessage()]);
    const messageId = chat.getMessages()[0]!.id;

    chat.handleServerMessage({
      type: "reaction-broadcast",
      channelId: CHANNEL,
      messageId,
      emoji: "🔥",
      userId: ME.id,
      added: true,
      displayName: "Me",
    } as never);
    expect(chat.getMessages()[0]!.reactions).toEqual([
      {
        emoji: "🔥",
        count: 1,
        me: true,
        users: [{ id: ME.id, displayName: "Me" }],
      },
    ]);

    chat.handleServerMessage({
      type: "reaction-broadcast",
      channelId: CHANNEL,
      messageId,
      emoji: "🔥",
      userId: "someone-else",
      added: true,
      displayName: "Alice",
    } as never);
    expect(chat.getMessages()[0]!.reactions[0]).toMatchObject({
      count: 2,
      me: true,
      users: [
        { id: ME.id, displayName: "Me" },
        { id: "someone-else", displayName: "Alice" },
      ],
    });

    chat.handleServerMessage({
      type: "reaction-broadcast",
      channelId: CHANNEL,
      messageId,
      emoji: "🔥",
      userId: ME.id,
      added: false,
    } as never);
    expect(chat.getMessages()[0]!.reactions[0]).toMatchObject({
      count: 1,
      me: false,
      users: [{ id: "someone-else", displayName: "Alice" }],
    });

    chat.handleServerMessage({
      type: "reaction-broadcast",
      channelId: CHANNEL,
      messageId,
      emoji: "🔥",
      userId: "someone-else",
      added: false,
    } as never);
    expect(chat.getMessages()[0]!.reactions).toEqual([]);
  });

  it("refuses to react to a message that has not been stored yet", () => {
    const { chat, sent } = setup();
    chat.sendMessage("hi");
    const before = sent.length;
    chat.toggleReaction(chat.getMessages()[0]!.id, "🔥");
    expect(sent.length).toBe(before);
  });
});

describe("edit and delete", () => {
  it("applies an edit optimistically and rolls back on failure", async () => {
    const { chat } = setup();
    chat.setMessages([serverMessage({ body: "before" })]);
    const messageId = chat.getMessages()[0]!.id;

    vi.mocked(api.editMessage).mockRejectedValueOnce(new Error("nope"));
    await expect(chat.editMessage(messageId, "after")).rejects.toThrow("nope");
    expect(chat.getMessages()[0]!.body).toBe("before");

    vi.mocked(api.editMessage).mockResolvedValueOnce({
      message: serverMessage({ body: "after" }),
    });
    await chat.editMessage(messageId, "after");
    expect(chat.getMessages()[0]!.body).toBe("after");
  });

  it("removes a message optimistically and restores it on failure", async () => {
    const { chat } = setup();
    chat.setMessages([serverMessage()]);
    const messageId = chat.getMessages()[0]!.id;

    vi.mocked(api.deleteMessage).mockRejectedValueOnce(new Error("nope"));
    await expect(chat.deleteMessage(messageId)).rejects.toThrow("nope");
    expect(chat.getMessages()).toHaveLength(1);

    vi.mocked(api.deleteMessage).mockResolvedValueOnce({ ok: true });
    await chat.deleteMessage(messageId);
    expect(chat.getMessages()).toHaveLength(0);
  });

  it("applies update and delete broadcasts", () => {
    const { chat } = setup();
    chat.setMessages([serverMessage({ body: "before" })]);
    const messageId = chat.getMessages()[0]!.id;

    chat.handleServerMessage({
      type: "message-update",
      message: serverMessage({ body: "after", editedAt: new Date(1).toISOString() }),
    } as never);
    expect(chat.getMessages()[0]!.body).toBe("after");
    expect(chat.getMessages()[0]!.editedAt).not.toBeNull();

    chat.handleServerMessage({
      type: "message-delete",
      channelId: CHANNEL,
      messageId,
    } as never);
    expect(chat.getMessages()).toHaveLength(0);
  });
});

describe("replies", () => {
  const PARENT = {
    id: "00000000-0000-4000-8000-0000000000aa",
    authorId: "00000000-0000-4000-8000-0000000000bb",
    authorName: "Ana",
    body: "the original question",
  };

  it("quotes the parent optimistically and tells the server which one", () => {
    const { chat, sent } = setup();
    chat.sendMessage("the answer", PARENT);

    expect(chat.getMessages()[0]!.replyTo).toEqual({
      id: PARENT.id,
      authorId: PARENT.authorId,
      authorName: "Ana",
      excerpt: "the original question",
      deleted: false,
    });
    expect(sent.at(-1)).toMatchObject({ replyToId: PARENT.id });
  });

  it("omits replyToId entirely for an ordinary message", () => {
    const { chat, sent } = setup();
    chat.sendMessage("just talking");

    expect(chat.getMessages()[0]!.replyTo).toBeNull();
    expect(sent.at(-1)).not.toHaveProperty("replyToId");
  });

  it("still replies to the same message on retry", () => {
    const { chat, sent } = setup();
    chat.sendMessage("the answer", PARENT);
    const nonce = chat.getMessages()[0]!.nonce!;

    vi.advanceTimersByTime(10_000);
    expect(chat.getMessages()[0]!.failed).toBe(true);

    chat.retryMessage(nonce);
    expect(sent.at(-1)).toMatchObject({ replyToId: PARENT.id });
  });

  it("marks a quote as deleted when its parent is removed live", () => {
    const { chat } = setup();
    chat.setMessages([
      serverMessage({
        id: "00000000-0000-4000-8000-00000000000b",
        body: "the answer",
        replyTo: {
          id: PARENT.id,
          authorId: PARENT.authorId,
          authorName: "Ana",
          excerpt: "the original question",
          deleted: false,
        },
      }),
    ]);

    chat.handleServerMessage({
      type: "message-delete",
      channelId: CHANNEL,
      messageId: PARENT.id,
    } as never);

    // The reply itself must survive — only the quote loses its target.
    const [reply] = chat.getMessages();
    expect(reply!.body).toBe("the answer");
    expect(reply!.replyTo).toEqual({
      id: PARENT.id,
      authorId: null,
      authorName: null,
      excerpt: "",
      deleted: true,
    });
  });
});

describe("typing indicators", () => {
  it("throttles outbound typing notices", () => {
    const { chat, sent } = setup();
    chat.notifyTyping();
    chat.notifyTyping();
    chat.notifyTyping();
    expect(sent.filter((m) => (m as { type: string }).type === "typing")).toHaveLength(
      1,
    );
  });

  it("tracks other users and expires them", () => {
    const { chat } = setup();
    chat.handleServerMessage({
      type: "typing-broadcast",
      channelId: CHANNEL,
      userId: "u1",
      displayName: "Ana",
    } as never);
    expect(chat.getTypingUsers()).toEqual([
      { userId: "u1", displayName: "Ana" },
    ]);

    vi.advanceTimersByTime(6_000);
    expect(chat.getTypingUsers()).toEqual([]);
  });

  it("ignores its own typing echo", () => {
    const { chat } = setup();
    chat.handleServerMessage({
      type: "typing-broadcast",
      channelId: CHANNEL,
      userId: ME.id,
      displayName: "Me",
    } as never);
    expect(chat.getTypingUsers()).toEqual([]);
  });
});

describe("history pagination", () => {
  it("prepends older messages and reports how many arrived", async () => {
    const { chat } = setup();
    chat.setMessages([serverMessage({ id: "00000000-0000-4000-8000-00000000000b" })], true);

    mockPage({
      messages: [serverMessage({ id: "00000000-0000-4000-8000-00000000000c" })],
    });

    const added = await chat.loadOlder();
    expect(added).toBe(1);
    expect(chat.getMessages().map((m) => m.id)).toEqual([
      "00000000-0000-4000-8000-00000000000c",
      "00000000-0000-4000-8000-00000000000b",
    ]);
    expect(chat.hasMoreHistory()).toBe(false);
  });

  it("does nothing when there is no more history", async () => {
    const { chat } = setup();
    chat.setMessages([serverMessage()], false);
    expect(await chat.loadOlder()).toBe(0);
    expect(api.apiFetch).not.toHaveBeenCalled();
  });

  it("stops offering history when the server rejects the cursor", async () => {
    const { chat } = setup();
    chat.setMessages([serverMessage()], true);

    const rejected = Object.assign(new Error("Unknown cursor"), { status: 400 });
    vi.mocked(api.apiFetch).mockRejectedValueOnce(rejected);

    expect(await chat.loadOlder()).toBe(0);
    expect(chat.hasMoreHistory()).toBe(false);
  });

  it("keeps history available when a load fails transiently", async () => {
    const { chat } = setup();
    chat.setMessages([serverMessage()], true);

    const offline = Object.assign(new Error("Network error"), { status: 0 });
    vi.mocked(api.apiFetch).mockRejectedValueOnce(offline);

    expect(await chat.loadOlder()).toBe(0);
    expect(chat.hasMoreHistory()).toBe(true);
  });

  it("drops a page that arrives after the channel changed", async () => {
    const { chat } = setup();
    chat.setMessages([serverMessage()], true);

    let resolvePage: (value: HistoryPage) => void = () => {};
    vi.mocked(api.apiFetch).mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePage = resolve as (value: HistoryPage) => void;
      }),
    );

    const pending = chat.loadOlder();
    chat.joinChannel("c0000000-0000-4000-8000-0000000000ff");
    resolvePage({ messages: [serverMessage()], hasMore: false, hasNewer: false });

    expect(await pending).toBe(0);
    expect(chat.getMessages()).toHaveLength(0);
  });
});

/** Ascending ids so a merged window can be checked by order alone. */
function history(count: number, from = 0): Message[] {
  return Array.from({ length: count }, (_, index) => {
    const n = from + index;
    return serverMessage({
      id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
      body: `m${n}`,
      createdAt: new Date(n * 1000).toISOString(),
    });
  });
}

describe("jumping into history", () => {
  it("fetches a page around a message that is not loaded", async () => {
    const { chat } = setup();
    chat.setMessages(history(2, 8), true);

    mockPage({ messages: history(4), hasMore: true, hasNewer: true });

    expect(await chat.jumpTo("00000000-0000-4000-8000-000000000002")).toBe(true);
    expect(requestedUrl()).toContain(
      "around=00000000-0000-4000-8000-000000000002",
    );
    expect(chat.getMessages().map((m) => m.body)).toEqual([
      "m0",
      "m1",
      "m2",
      "m3",
    ]);
    expect(chat.hasNewerHistory()).toBe(true);
  });

  it("scrolls to a loaded message without asking the server", async () => {
    const { chat } = setup();
    const loaded = history(3);
    chat.setMessages(loaded, true);

    expect(await chat.jumpTo(loaded[1]!.id)).toBe(true);
    expect(api.apiFetch).not.toHaveBeenCalled();
  });

  it("reports a message it cannot reach instead of emptying the channel", async () => {
    const { chat } = setup();
    chat.setMessages(history(2), true);

    const deleted = Object.assign(new Error("Unknown cursor"), { status: 400 });
    vi.mocked(api.apiFetch).mockRejectedValueOnce(deleted);

    expect(await chat.jumpTo("00000000-0000-4000-8000-00000000ffff")).toBe(
      false,
    );
    expect(chat.getMessages()).toHaveLength(2);
  });

  it("pages forward from the newest loaded message and stops at the present", async () => {
    const { chat } = setup();
    chat.setMessages(history(2), true, true);

    mockPage({ messages: history(2, 2), hasMore: true, hasNewer: false });
    const added = await chat.loadNewer();

    expect(added).toBe(2);
    expect(requestedUrl()).toContain(
      "after=00000000-0000-4000-8000-000000000001",
    );
    expect(chat.getMessages().map((m) => m.body)).toEqual([
      "m0",
      "m1",
      "m2",
      "m3",
    ]);
    expect(chat.hasNewerHistory()).toBe(false);

    expect(await chat.loadNewer()).toBe(0);
    expect(api.apiFetch).toHaveBeenCalledTimes(1);
  });

  it("ignores a live message while the window stops short of the present", () => {
    const { chat } = setup();
    chat.setMessages(history(2), true, true);

    chat.handleServerMessage({
      type: "message-broadcast",
      message: serverMessage({ id: "00000000-0000-4000-8000-0000000000ff" }),
    } as never);

    expect(chat.getMessages()).toHaveLength(2);
  });

  it("keeps a page it already holds out of the next one", async () => {
    const { chat } = setup();
    chat.setMessages(history(3), true, true);

    // The server pages from the cursor, but an overlapping page must not double
    // rows the window is already showing.
    mockPage({ messages: history(3, 2), hasNewer: false });
    const added = await chat.loadNewer();

    expect(added).toBe(2);
    expect(chat.getMessages().map((m) => m.body)).toEqual([
      "m0",
      "m1",
      "m2",
      "m3",
      "m4",
    ]);
  });

  it("returns to the newest page when the reader jumps to the present", async () => {
    const { chat } = setup();
    chat.setMessages(history(2), true, true);

    mockPage({ messages: history(2, 8), hasMore: true, hasNewer: false });
    expect(await chat.resetToTail()).toBe(true);

    expect(requestedUrl()).not.toContain("around=");
    expect(requestedUrl()).not.toContain("after=");
    expect(chat.getMessages().map((m) => m.body)).toEqual(["m8", "m9"]);
    expect(chat.hasNewerHistory()).toBe(false);
  });

  it("moves the forward cursor off a message that was deleted", async () => {
    const { chat } = setup();
    const loaded = history(2);
    chat.setMessages(loaded, true, true);

    chat.handleServerMessage({
      type: "message-delete",
      channelId: CHANNEL,
      messageId: loaded[1]!.id,
    } as never);

    mockPage({ messages: history(1, 2), hasNewer: false });
    await chat.loadNewer();

    expect(requestedUrl()).toContain(`after=${loaded[0]!.id}`);
  });
});

describe("channel switching", () => {
  it("clears messages and presence when joining a different channel", () => {
    const { chat } = setup();
    chat.setMessages([serverMessage()]);
    chat.joinChannel("c0000000-0000-4000-8000-0000000000ff");
    expect(chat.getMessages()).toHaveLength(0);
  });

  it("is a no-op when re-joining the channel already open", () => {
    const { chat, sent } = setup();
    chat.setMessages([serverMessage()]);
    const before = sent.length;
    chat.joinChannel(CHANNEL);
    expect(sent.length).toBe(before);
    expect(chat.getMessages()).toHaveLength(1);
  });

  it("resubscribes without wiping what is on screen", () => {
    const { chat, sent } = setup();
    chat.setMessages([serverMessage()]);
    chat.resubscribe();
    expect(chat.getMessages()).toHaveLength(1);
    expect((sent.at(-1) as { type: string }).type).toBe("join-channel");
  });
});

describe("applyProfileUpdate", () => {
  const OTHER = "00000000-0000-4000-8000-000000000002";

  it("repaints every message that author already has on screen", () => {
    // The author's name and picture are denormalised onto each row when it is
    // read — one query for a transcript instead of one per distinct author —
    // so a profile change is invisible to loaded history until this rewrites it.
    const { chat } = setup();
    chat.setMessages([
      serverMessage({ id: "a", authorId: OTHER, authorName: "Old" }),
      serverMessage({ id: "b", authorId: OTHER, authorName: "Old" }),
      serverMessage({ id: "c", authorId: ME.id, authorName: "Me" }),
    ]);

    chat.applyProfileUpdate({
      userId: OTHER,
      displayName: "New",
      avatarUrl: "/api/avatars/x?v=1",
    });

    const messages = chat.getMessages();
    expect(messages.map((one) => one.authorName)).toEqual(["New", "New", "Me"]);
    expect(messages[0]!.authorAvatarUrl).toBe("/api/avatars/x?v=1");
    // Somebody else's rows are untouched, including their null avatar.
    expect(messages[2]!.authorAvatarUrl).toBeNull();
  });

  it("leaves a webhook's name and picture alone", () => {
    // A webhook's author row *is* the webhook, and the name shown is the
    // webhook's — overwriting it would rename a bot to whoever last edited
    // their own profile.
    const { chat } = setup();
    chat.setMessages([
      serverMessage({
        id: "a",
        authorId: OTHER,
        authorName: "deploy-bot",
        isWebhook: true,
      }),
    ]);

    chat.applyProfileUpdate({
      userId: OTHER,
      displayName: "New",
      avatarUrl: null,
    });

    expect(chat.getMessages()[0]!.authorName).toBe("deploy-bot");
  });

  it("does nothing for somebody with nothing on screen", () => {
    const { chat } = setup();
    chat.setMessages([serverMessage({ id: "a" })]);
    chat.applyProfileUpdate({
      userId: "00000000-0000-4000-8000-0000000000ff",
      displayName: "Nobody",
      avatarUrl: null,
    });
    expect(chat.getMessages()[0]!.authorName).toBe("Me");
  });
});

describe("open-channel sounds", () => {
  const OTHER = "00000000-0000-4000-8000-000000000002";

  it("does not ping when you send a message, even a self-mention", () => {
    const { chat } = setup();
    chat.sendMessage("hello");
    expect(notifyOpenChannelMessage).not.toHaveBeenCalled();
    chat.sendMessage("ping @me");
    expect(notifyOpenChannelMessage).not.toHaveBeenCalled();
  });

  it("plays once for an incoming message, not again on the echo of your own send", () => {
    const { chat } = setup();
    chat.sendMessage("hello");
    const nonce = chat.getMessages()[0]!.nonce!;
    notifyOpenChannelMessage.mockClear();

    chat.handleServerMessage({
      type: "message-broadcast",
      message: serverMessage({ body: "hello" }),
      nonce,
    } as never);
    expect(notifyOpenChannelMessage).not.toHaveBeenCalled();

    chat.handleServerMessage({
      type: "message-broadcast",
      message: serverMessage({
        id: "00000000-0000-4000-8000-00000000000b",
        authorId: OTHER,
        body: "hey",
      }),
    } as never);
    expect(notifyOpenChannelMessage).toHaveBeenCalledWith(CHANNEL, false);
  });

  it("plays the mention cue when someone else tags you in the open channel", () => {
    const { chat } = setup();
    chat.handleServerMessage({
      type: "message-broadcast",
      message: serverMessage({
        authorId: OTHER,
        body: "hey @me",
      }),
    } as never);
    expect(notifyOpenChannelMessage).toHaveBeenCalledWith(CHANNEL, true);
  });

  it("plays the mention cue when someone else fires @everyone or @here", () => {
    const { chat } = setup();
    chat.handleServerMessage({
      type: "message-broadcast",
      message: serverMessage({
        id: "00000000-0000-4000-8000-00000000000c",
        authorId: OTHER,
        body: "hey @everyone",
        mentionEveryone: true,
      }),
    } as never);
    expect(notifyOpenChannelMessage).toHaveBeenCalledWith(CHANNEL, true);

    notifyOpenChannelMessage.mockClear();
    chat.handleServerMessage({
      type: "message-broadcast",
      message: serverMessage({
        id: "00000000-0000-4000-8000-00000000000d",
        authorId: OTHER,
        body: "hey @here",
        mentionHere: true,
      }),
    } as never);
    expect(notifyOpenChannelMessage).toHaveBeenCalledWith(CHANNEL, true);
  });

  it("stays silent for a typed @everyone that was not allowed to fire", () => {
    const { chat } = setup();
    chat.handleServerMessage({
      type: "message-broadcast",
      message: serverMessage({
        authorId: OTHER,
        body: "hey @everyone",
        mentionEveryone: false,
      }),
    } as never);
    expect(notifyOpenChannelMessage).toHaveBeenCalledWith(CHANNEL, false);
  });
});

describe("chance and polls", () => {
  it("sends a roll request without inventing a total", () => {
    const { chat, sent } = setup();
    chat.sendChance({ type: "roll", notation: "2d6+3" });
    expect(chat.getMessages()).toHaveLength(0);
    expect(sent.at(-1)).toMatchObject({
      type: "message-create",
      body: "",
      chance: { type: "roll", notation: "2d6+3" },
    });
  });

  it("merges a poll-update count and this viewer's vote", () => {
    const optionA = "a0000000-0000-4000-8000-000000000001";
    const optionB = "b0000000-0000-4000-8000-000000000002";
    const { chat } = setup();
    chat.setMessages([
      serverMessage({
        poll: {
          question: "Who is in?",
          allowMultiselect: false,
          closesAt: new Date(Date.now() + 86_400_000).toISOString(),
          closedAt: null,
          totalVotes: 0,
          canClose: true,
          options: [
            { id: optionA, label: "Yes", votes: 0, voted: false, voters: [] },
            { id: optionB, label: "No", votes: 0, voted: false, voters: [] },
          ],
        },
      }),
    ]);
    chat.handleServerMessage({
      type: "poll-update",
      channelId: CHANNEL,
      messageId: chat.getMessages()[0]!.id,
      voterId: ME.id,
      optionId: optionA,
      added: true,
      poll: {
        question: "Who is in?",
        allowMultiselect: false,
        closesAt: new Date(Date.now() + 86_400_000).toISOString(),
        closedAt: null,
        totalVotes: 1,
        canClose: false,
        options: [
          {
            id: optionA,
            label: "Yes",
            votes: 1,
            voted: false,
            voters: [{ userId: ME.id, displayName: "Me", avatarUrl: null }],
          },
          { id: optionB, label: "No", votes: 0, voted: false, voters: [] },
        ],
      },
    } as never);
    const poll = chat.getMessages()[0]!.poll;
    expect(poll?.options[0]?.votes).toBe(1);
    expect(poll?.options[0]?.voted).toBe(true);
    expect(poll?.options[0]?.voters).toEqual([
      { userId: ME.id, displayName: "Me", avatarUrl: null },
    ]);
    expect(poll?.canClose).toBe(true);
  });

  it("ignores a second tap on the same poll until the server update lands", () => {
    const optionA = "a0000000-0000-4000-8000-000000000001";
    const optionB = "b0000000-0000-4000-8000-000000000002";
    const { chat, sent } = setup();
    chat.setMessages([
      serverMessage({
        poll: {
          question: "Who is in?",
          allowMultiselect: false,
          closesAt: new Date(Date.now() + 86_400_000).toISOString(),
          closedAt: null,
          totalVotes: 0,
          canClose: true,
          options: [
            { id: optionA, label: "Yes", votes: 0, voted: false, voters: [] },
            { id: optionB, label: "No", votes: 0, voted: false, voters: [] },
          ],
        },
      }),
    ]);
    const messageId = chat.getMessages()[0]!.id;
    chat.votePoll(messageId, optionA);
    chat.votePoll(messageId, optionB);
    const votes = sent.filter((frame) => (frame as { type: string }).type === "poll-vote");
    expect(votes).toHaveLength(1);
    expect(chat.getMessages()[0]!.poll?.options[0]?.votes).toBe(1);
    expect(chat.getMessages()[0]!.poll?.options[1]?.votes).toBe(0);
    expect(chat.getMessages()[0]!.poll?.options[0]?.voters).toEqual([
      { userId: ME.id, displayName: "Me", avatarUrl: null },
    ]);
  });
});
