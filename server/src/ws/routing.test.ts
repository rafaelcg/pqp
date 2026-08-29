import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";

/**
 * The socket router decides, by frame type alone, whether an inbound frame is
 * handed to the chat handler, the voice handler, or dropped. That decision used
 * to be a hand-kept list, and the list drifted: `poll-vote`, `poll-close`,
 * `thread-join` and `thread-leave` were all part of the client protocol and all
 * silently discarded here, which no handler test could catch because every one
 * of them calls `handleChatMessage` directly.
 *
 * So the property under test is the routing itself: every frame the shared
 * client schema accepts must reach a handler.
 *
 * No database. Auth, both handlers and the status registry are faked, which is
 * everything `handleWsConnection` touches.
 */

const chatFrames: unknown[] = [];
const voiceFrames: unknown[] = [];

vi.mock("../auth/clerk.js", () => ({
  DEV_AUTH_TOKEN: "dev-local-token",
  isDevAuthBypassEnabled: () => false,
  resolveAuthUser: async () => ({
    user: { id: "00000000-0000-4000-8000-000000000001", clerk_id: "clerk_1" },
  }),
}));

vi.mock("./chat.js", () => ({
  handleChatMessage: async (_conn: unknown, payload: unknown) => {
    chatFrames.push(payload);
  },
}));

vi.mock("./voice.js", () => ({
  handleVoiceMessage: async (_conn: unknown, payload: unknown) => {
    voiceFrames.push(payload);
  },
  isSocketInVoice: () => false,
  removeVoicePeerBySocket: () => {},
  sendAllVoiceRosters: async () => {},
}));

vi.mock("./status.js", () => ({
  registerStatusSocket: async () => {},
  unregisterStatusSocket: () => {},
}));

const { handleWsConnection } = await import("./index.js");

function fakeSocket() {
  const handlers = new Map<string, (...args: never[]) => void>();
  const sent: string[] = [];

  const socket = {
    readyState: 1,
    send: (payload: string) => {
      sent.push(payload);
    },
    ping: () => {},
    terminate: () => {},
    close: () => {
      socket.readyState = 3;
    },
    on: (event: string, fn: (...args: never[]) => void) => {
      handlers.set(event, fn);
      return socket;
    },
  };

  return {
    socket: socket as unknown as WebSocket,
    sent,
    deliver: (frame: unknown) => {
      handlers.get("message")?.(JSON.stringify(frame) as never);
    },
  };
}

async function connected() {
  const fake = fakeSocket();
  handleWsConnection(fake.socket, `test-${randomUUID()}`);
  fake.deliver({ type: "auth", token: "any" });
  await vi.waitFor(() => {
    expect(fake.sent.some((raw) => raw.includes('"ready"'))).toBe(true);
  });
  return fake;
}

describe("websocket frame routing", () => {
  beforeEach(() => {
    chatFrames.length = 0;
    voiceFrames.length = 0;
  });

  it("hands a poll vote to the chat handler instead of dropping it", async () => {
    const fake = await connected();
    const frame = {
      type: "poll-vote",
      channelId: randomUUID(),
      messageId: randomUUID(),
      optionId: randomUUID(),
    };
    fake.deliver(frame);
    await vi.waitFor(() => {
      expect(chatFrames).toEqual([frame]);
    });
  });

  it("hands a poll close to the chat handler", async () => {
    const fake = await connected();
    const frame = {
      type: "poll-close",
      channelId: randomUUID(),
      messageId: randomUUID(),
    };
    fake.deliver(frame);
    await vi.waitFor(() => {
      expect(chatFrames).toEqual([frame]);
    });
  });

  it("hands a thread join and leave to the chat handler", async () => {
    const fake = await connected();
    fake.deliver({ type: "thread-join", channelId: randomUUID() });
    fake.deliver({ type: "thread-leave" });
    await vi.waitFor(() => {
      expect(chatFrames.map((frame) => (frame as { type: string }).type)).toEqual([
        "thread-join",
        "thread-leave",
      ]);
    });
  });

  it("still routes voice signaling and still drops an unknown type", async () => {
    const fake = await connected();
    fake.deliver({ type: "leave-voice-room" });
    fake.deliver({ type: "not-a-frame" });
    await vi.waitFor(() => {
      expect(voiceFrames).toHaveLength(1);
    });
    expect(chatFrames).toHaveLength(0);
  });
});
