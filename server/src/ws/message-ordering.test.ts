import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";

/**
 * TWO FRAMES ON ONE SOCKET, RACING.
 *
 * Root-caused during the M6 rehearsal 2 cross-instance investigation
 * (2026-09-14): a watch-party host's `set-watch-party` never logged
 * `voice.watchPartyStart` on the machine that handled it. Live reproduction
 * on staging (owner and a second peer pinned to different `pqp-api-staging`
 * machines via `fly-force-instance-id`, VOICE_REGISTRY=postgres,
 * CLUSTER_BUS=postgres) isolated it to something that had nothing to do with
 * which instance handled which socket: sending `set-watch-party` in the same
 * tick as `join-voice-room`, on the SAME connection, made the write vanish
 * silently — no echo, no `voice.watchPartyStart`, no error.
 *
 * The cause was in `handleWsConnection`'s own message loop, not in the voice
 * handler. `socket.on("message", ...)` used to spawn an independent
 * fire-and-forget `onMessage(data)` per frame, with no ordering guarantee
 * between two frames from the SAME socket once either one `await`s.
 * `join-voice-room`'s handler awaits several permission/channel-access
 * checks (`canAccessChannel`, `getChannel`,
 * `resolveMemberChannelPermissions`, ...) before it registers the peer
 * (`socketToPeerId.set`); `set-watch-party`'s handler is comparatively
 * short and reads `socketToPeerId.get(socket)` near the top
 * (`existingPeerId` in `ws/voice.ts`). A client that sends both frames
 * back-to-back without waiting for `welcome` in between — which is exactly
 * what the real "Ir ao vivo" flow does, and what a WS test harness does by
 * default — could have `set-watch-party`'s handler run to completion and
 * hit the `!existingPeerId` early return BEFORE `join-voice-room`'s own
 * awaits resolved. Same shape as pitfall 13 in CLAUDE.md ("a fire-and-forget
 * write is not an ordered write").
 *
 * The fix chains a socket's frames onto one promise (`messageChain` in
 * `ws/index.ts`), the same pattern `dispatchChain` in `lib/bus-postgres.ts`
 * already uses for exactly this reason: the next frame's handler does not
 * start until the previous one has settled, in delivery order — a frame that
 * throws is caught (per-frame, same as before) and does not wedge every
 * later frame on the socket.
 *
 * This suite proves ordering directly rather than reproducing the whole
 * voice/watch-party stack: a mocked handler that resolves the FIRST frame
 * slowly and the SECOND instantly is exactly the shape that reorders under
 * the old fire-and-forget dispatch (the fast one would finish first) and
 * cannot reorder under the fix. No database.
 */

const seen: { type: string; at: number }[] = [];

vi.mock("../auth/clerk.js", () => ({
  DEV_AUTH_TOKEN: "dev-local-token",
  isDevAuthBypassEnabled: () => false,
  resolveAuthUser: async () => ({
    user: { id: "00000000-0000-4000-8000-000000000001", clerk_id: "clerk_1" },
  }),
}));

vi.mock("./chat.js", () => ({
  handleChatMessage: async (_conn: unknown, payload: { type: string }) => {
    // `typing` stands in for a slow chat-side handler here; the real bug is
    // agnostic to which side of the router is slow, only to which frame on
    // the socket arrived first.
    if (payload.type === "typing") {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    seen.push({ type: payload.type, at: Date.now() });
  },
}));

vi.mock("./voice.js", () => ({
  handleVoiceMessage: async (_conn: unknown, payload: { type: string }) => {
    // Mirrors the real asymmetry: `join-voice-room` awaits several DB-backed
    // checks before it registers the peer; `set-watch-party` reads the
    // registration and is comparatively instant.
    if (payload.type === "join-voice-room") {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (payload.type === "leave-voice-room") {
      throw new Error("simulated transient handler failure");
    }
    seen.push({ type: payload.type, at: Date.now() });
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

describe("websocket per-socket message ordering", () => {
  beforeEach(() => {
    seen.length = 0;
  });

  it("does not let a fast frame finish before a slow frame sent just before it, on the same socket", async () => {
    const fake = await connected();
    // Delivered synchronously, back-to-back, with no await in between: this
    // is the exact shape of the real "Ir ao vivo" flow and of a WS test
    // harness that does not wait for `welcome`.
    fake.deliver({ type: "join-voice-room", voiceChannelId: randomUUID() });
    fake.deliver({ type: "set-watch-party", state: null });

    await vi.waitFor(() => {
      expect(seen.map((s) => s.type)).toEqual([
        "join-voice-room",
        "set-watch-party",
      ]);
    });
  });

  it("preserves order across frame types on the same socket, not just within one handler", async () => {
    const fake = await connected();
    fake.deliver({ type: "typing", channelId: randomUUID() });
    fake.deliver({ type: "set-watch-party", state: null });

    await vi.waitFor(() => {
      expect(seen.map((s) => s.type)).toEqual(["typing", "set-watch-party"]);
    });
  });

  it("keeps later frames flowing after an earlier one's handler throws", async () => {
    const fake = await connected();
    fake.deliver({ type: "leave-voice-room" }); // mocked to throw, see above
    fake.deliver({ type: "set-raised-hand", raised: true });

    await vi.waitFor(() => {
      expect(seen.map((s) => s.type)).toContain("set-raised-hand");
    });
  });
});
