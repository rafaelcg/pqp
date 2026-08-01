import type { Message } from "@pqp/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChatController } from "./use-chat";
import type { RealtimeTransport } from "@/lib/realtime";

vi.mock("@/lib/api", () => ({
  fetchMessages: vi.fn(),
  editMessage: vi.fn(),
  deleteMessage: vi.fn(),
}));

const api = await import("@/lib/api");

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
    onStatusChange: () => {},
    getStatus: () => (state.connected ? "online" : "reconnecting"),
    isConnected: () => state.connected,
  };
  return { transport, sent, state };
}

const ME = {
  id: "00000000-0000-4000-8000-000000000001",
  displayName: "Me",
  avatarUrl: null,
  tag: "me#0001",
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
    } as never);
    expect(chat.getMessages()[0]!.reactions).toEqual([
      { emoji: "🔥", count: 1, me: true },
    ]);

    chat.handleServerMessage({
      type: "reaction-broadcast",
      channelId: CHANNEL,
      messageId,
      emoji: "🔥",
      userId: "someone-else",
      added: true,
    } as never);
    expect(chat.getMessages()[0]!.reactions[0]).toMatchObject({
      count: 2,
      me: true,
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

    vi.mocked(api.fetchMessages).mockResolvedValueOnce({
      messages: [serverMessage({ id: "00000000-0000-4000-8000-00000000000c" })],
      hasMore: false,
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
    expect(api.fetchMessages).not.toHaveBeenCalled();
  });

  it("stops offering history when the server rejects the cursor", async () => {
    const { chat } = setup();
    chat.setMessages([serverMessage()], true);

    const rejected = Object.assign(new Error("Unknown cursor"), { status: 400 });
    vi.mocked(api.fetchMessages).mockRejectedValueOnce(rejected);

    expect(await chat.loadOlder()).toBe(0);
    expect(chat.hasMoreHistory()).toBe(false);
  });

  it("keeps history available when a load fails transiently", async () => {
    const { chat } = setup();
    chat.setMessages([serverMessage()], true);

    const offline = Object.assign(new Error("Network error"), { status: 0 });
    vi.mocked(api.fetchMessages).mockRejectedValueOnce(offline);

    expect(await chat.loadOlder()).toBe(0);
    expect(chat.hasMoreHistory()).toBe(true);
  });

  it("drops a page that arrives after the channel changed", async () => {
    const { chat } = setup();
    chat.setMessages([serverMessage()], true);

    let resolvePage: (value: { messages: Message[]; hasMore: boolean }) => void =
      () => {};
    vi.mocked(api.fetchMessages).mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePage = resolve;
      }),
    );

    const pending = chat.loadOlder();
    chat.joinChannel("c0000000-0000-4000-8000-0000000000ff");
    resolvePage({ messages: [serverMessage()], hasMore: false });

    expect(await pending).toBe(0);
    expect(chat.getMessages()).toHaveLength(0);
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
