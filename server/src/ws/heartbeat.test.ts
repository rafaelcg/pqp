import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import {
  MAX_MISSED_PONGS,
  startHeartbeat,
  trackSocketLiveness,
} from "./index.js";

/**
 * The reaper, which is the thing that decides whether somebody stays in a call.
 *
 * These tests exist because it had none, and the one-strike version it shipped
 * with spent the night of 2026-09-05 evicting live users whose only crime was
 * a slow 30 seconds. The interesting cases are therefore not "does it kill a
 * dead socket" but "does it refuse to kill a slow one".
 */

/** Minimal stand-in: the heartbeat only ever calls ping/terminate and listens for pong. */
class FakeSocket extends EventEmitter {
  pings = 0;
  terminated = 0;

  ping() {
    this.pings += 1;
  }

  terminate() {
    this.terminated += 1;
  }

  /** What a browser does for free, at protocol level. */
  pong() {
    this.emit("pong");
  }
}

function asWebSocket(socket: FakeSocket): WebSocket {
  return socket as unknown as WebSocket;
}

const INTERVAL = 30_000;

describe("startHeartbeat", () => {
  let stop: (() => void) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    stop?.();
    stop = undefined;
    vi.useRealTimers();
  });

  /**
   * The same registration `handleWsConnection` performs, without the rate
   * limiters, auth timeout and real IO that come with opening a connection.
   */
  function watch(sockets: FakeSocket[]) {
    for (const socket of sockets) {
      trackSocketLiveness(asWebSocket(socket));
    }
    stop = startHeartbeat(sockets.map(asWebSocket), INTERVAL);
  }

  it("pings on every interval and never reaps a socket that answers", () => {
    const socket = new FakeSocket();
    watch([socket]);

    for (let tick = 0; tick < 10; tick += 1) {
      vi.advanceTimersByTime(INTERVAL);
      socket.pong();
    }

    expect(socket.terminated).toBe(0);
    expect(socket.pings).toBeGreaterThanOrEqual(10);
  });

  it("survives a single missed pong, which is the whole point", () => {
    const socket = new FakeSocket();
    watch([socket]);

    // Ping one: answered.
    vi.advanceTimersByTime(INTERVAL);
    socket.pong();

    // Ping two: ignored. One strike is not death any more.
    vi.advanceTimersByTime(INTERVAL);
    expect(socket.terminated).toBe(0);

    // And answering late puts it fully back in good standing.
    socket.pong();
    vi.advanceTimersByTime(INTERVAL);
    expect(socket.terminated).toBe(0);
  });

  it("reaps a socket that misses MAX_MISSED_PONGS in a row", () => {
    const socket = new FakeSocket();
    watch([socket]);

    // First tick sends the ping nobody answers; each tick after that is a strike.
    vi.advanceTimersByTime(INTERVAL);
    for (let strike = 0; strike < MAX_MISSED_PONGS; strike += 1) {
      expect(socket.terminated).toBe(0);
      vi.advanceTimersByTime(INTERVAL);
    }

    expect(socket.terminated).toBe(1);
  });

  it("resets the strike count, so misses must be consecutive", () => {
    const socket = new FakeSocket();
    watch([socket]);

    // Alternate miss, answer, miss, answer well past the strike limit. A flaky
    // connection that recovers between pings is not a dead one.
    for (let round = 0; round < MAX_MISSED_PONGS * 3; round += 1) {
      vi.advanceTimersByTime(INTERVAL); // ping, unanswered
      vi.advanceTimersByTime(INTERVAL); // strike, and a second ping
      socket.pong(); // answered before the next tick
    }

    expect(socket.terminated).toBe(0);
  });

  it("keeps pinging inside the grace window rather than going quiet", () => {
    const socket = new FakeSocket();
    watch([socket]);

    vi.advanceTimersByTime(INTERVAL);
    const afterFirst = socket.pings;
    vi.advanceTimersByTime(INTERVAL);

    // The strike tick pings again: a client that lost one frame gets another
    // chance immediately instead of waiting out the window in silence.
    expect(socket.pings).toBeGreaterThan(afterFirst);
    expect(socket.terminated).toBe(0);
  });

  it("reaps one dead socket without touching its healthy neighbour", () => {
    const dead = new FakeSocket();
    const live = new FakeSocket();
    watch([dead, live]);

    for (let tick = 0; tick <= MAX_MISSED_PONGS; tick += 1) {
      vi.advanceTimersByTime(INTERVAL);
      live.pong();
    }

    expect(dead.terminated).toBe(1);
    expect(live.terminated).toBe(0);
  });

  /**
   * THE TEST THAT WOULD HAVE CAUGHT THE REAL BUG, which was never in this
   * function: it was that nothing called it.
   *
   * `server/src/index.ts` carried its own inline copy of the reap loop, with a
   * one-strike rule, and that copy is what production ran. Everything above
   * this line, the two-strike fix included, was dead code from the day it
   * merged. Same shape as pitfalls 9 and 12 in CLAUDE.md: the tested path and
   * the live path were not the same path, and nothing said so.
   *
   * Reading the entry point is a blunt instrument. It is also the only thing
   * that can tell "the reaper is correct" from "the reaper is reachable".
   */
  it("is the reaper the entry point actually runs", () => {
    const entry = readFileSync(
      fileURLToPath(new URL("../index.ts", import.meta.url)),
      "utf8",
    );

    expect(entry).toContain("startHeartbeat(");
    // And no second implementation beside it: a `terminate()` inside a loop
    // over `wss.clients` is what the inline copy looked like.
    expect(entry).not.toMatch(/for \(const \w+ of wss\.clients\)[\s\S]{0,400}terminate\(\)/);
  });

  it("stops pinging once the returned stop function runs", () => {
    const socket = new FakeSocket();
    watch([socket]);

    vi.advanceTimersByTime(INTERVAL);
    const before = socket.pings;
    stop?.();
    stop = undefined;
    vi.advanceTimersByTime(INTERVAL * 5);

    expect(socket.pings).toBe(before);
  });
});
