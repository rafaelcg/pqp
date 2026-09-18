import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { openAppSocket } from "./index.js";

/**
 * Regression test for a bug found running this harness against staging: the
 * `welcomeTimer` armed in `openAppSocket` on `socket.on("open")` was only
 * ever cleared by `socket.once("close", ...)`, never when the `welcome`
 * frame it exists to wait for actually arrived. Twelve seconds after every
 * socket opened -- welcomed or not -- the stale timer fired and closed it,
 * so every participant this harness drove orphaned its own voice seat
 * (`voice.join` then a 1005 close ~17s later, then `voice.orphan`, then a
 * `voice.leave` 90s after that): every socket/roster number a run produced
 * was corrupted by the harness itself, not by anything the API did.
 *
 * A fake local `ws` server stands in for the API: it answers `ready` and
 * then `welcome` on the real WebSocket handshake this harness uses, so the
 * only thing under test is whether `openAppSocket`'s own timer outlives a
 * welcome it already has.
 */
describe("openAppSocket", () => {
  let server: WebSocketServer | undefined;

  afterEach(async () => {
    vi.useRealTimers();
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  it("keeps a welcomed socket open past the 12s welcome window", async () => {
    server = new WebSocketServer({ port: 0 });
    server.on("connection", (client) => {
      client.on("message", (raw) => {
        const frame = JSON.parse(String(raw)) as { type?: string };
        if (frame.type === "join-voice-room") {
          client.send(
            JSON.stringify({ type: "welcome", peerId: "11111111-1111-1111-1111-111111111111" }),
          );
        }
      });
      client.send(JSON.stringify({ type: "ready" }));
    });
    const { port } = server.address() as { port: number };
    const wsUrl = `ws://127.0.0.1:${port}`;

    // Fake timers so the test can fast-forward past the 12s window instead
    // of waiting on the wall clock. The handshake itself is real loopback
    // I/O, driven by socket events rather than JS timers, so it resolves on
    // its own with no timer advancement needed.
    vi.useFakeTimers();
    const counters = { wireBytes: 0, frames: {} };
    const manifest = {
      version: 1 as const,
      runId: "open-app-socket-test",
      apiUrl: "http://127.0.0.1",
      wsUrl,
      participants: 1,
      serverId: "11111111-1111-1111-1111-111111111111",
      textChannelId: "text-channel",
      voiceChannelId: "voice-channel",
      inviteCode: "invite-code",
      createdAt: new Date().toISOString(),
    };

    const session = await openAppSocket(
      wsUrl,
      "token",
      manifest,
      /* legacy */ true,
      Date.now() + 60_000,
      0,
      counters,
      Date.now(),
    );
    expect(session.socket.readyState).toBe(session.socket.OPEN);

    // The bug: an un-cleared welcomeTimer fires here and closes an already-
    // welcomed socket. This is the exact re-arm-from-open window
    // (WELCOME_TIMEOUT_MS) plus a margin.
    await vi.advanceTimersByTimeAsync(13_000);
    expect(session.socket.readyState).toBe(session.socket.OPEN);

    session.socket.close();
  });
});
