import type { AppSessionSummary } from "@pqp/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  APP_JOIN_TIMEOUT_MS,
  appFrameClock,
  applyAppEnded,
  applyCatchUp,
  applyChannelApp,
  dropAppSessionsOfServer,
  endedSessionOfMessage,
  getAppSessionsSnapshot,
  handleAppsFrame,
  joinAppSession,
  liveSessionOfMessage,
  registerAppJoinInterceptor,
  registerAppJoinTransport,
  requestAppJoin,
  resetAppSessionsForTests,
  setAppsOnline,
  setAppsViewer,
  startedWith,
} from "./app-sessions-store";

const SERVER = "00000000-0000-4000-8000-0000000000a1";
const CH1 = "00000000-0000-4000-8000-0000000000c1";
const CH2 = "00000000-0000-4000-8000-0000000000c2";
const ME = "00000000-0000-4000-8000-0000000000b1";
const BIA = "00000000-0000-4000-8000-0000000000b2";
const S1 = "00000000-0000-4000-8000-0000000000d1";
const S2 = "00000000-0000-4000-8000-0000000000d2";
const T0 = "2026-10-19T10:00:00.000Z";

function session(
  id: string,
  over: Partial<AppSessionSummary> = {},
): AppSessionSummary {
  return {
    id,
    appId: "pqp-eco",
    appVersion: "1.0.0",
    startedBy: BIA,
    hostUserId: BIA,
    startedAt: T0,
    participants: [],
    players: 0,
    spectators: 0,
    handoff: null,
    ...over,
  };
}

function seated(userId: string) {
  return {
    userId,
    role: "player" as const,
    joinedAt: T0,
    connection: "present" as const,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  resetAppSessionsForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the live store: frames", () => {
  it("puts a started session on its channel and takes it off when the channel says none", () => {
    applyChannelApp(CH1, session(S1));
    expect(getAppSessionsSnapshot().live.get(CH1)?.id).toBe(S1);
    applyChannelApp(CH1, null);
    expect(getAppSessionsSnapshot().live.has(CH1)).toBe(false);
  });

  it("remembers the end of a session it saw live, so the card can say so", () => {
    applyChannelApp(CH1, session(S1, { participants: [seated(BIA)], players: 1 }));
    applyChannelApp(CH1, null);
    const ended = getAppSessionsSnapshot().ended.get(S1);
    expect(ended?.participantIds).toEqual([BIA]);
    // A viewer who was not in it gets no reason and no summary.
    expect(ended?.reason).toBeNull();
    expect(ended?.summary).toBeNull();
  });

  it("keeps the summary and reason an app-ended frame brings, in either order", () => {
    applyChannelApp(CH1, session(S1));
    applyAppEnded({
      sessionId: S1,
      channelId: CH1,
      reason: "host",
      summary: { participants: 4, durationSeconds: 1380 },
    });
    expect(getAppSessionsSnapshot().live.has(CH1)).toBe(false);
    // The channel-app that follows must not erase what app-ended said.
    applyChannelApp(CH1, null);
    expect(getAppSessionsSnapshot().ended.get(S1)?.summary).toEqual({
      participants: 4,
      durationSeconds: 1380,
    });

    resetAppSessionsForTests();
    applyChannelApp(CH1, session(S1));
    applyChannelApp(CH1, null);
    applyAppEnded({
      sessionId: S1,
      channelId: CH1,
      reason: "app-disabled",
      summary: { participants: 2, durationSeconds: 60 },
    });
    const ended = getAppSessionsSnapshot().ended.get(S1);
    expect(ended?.reason).toBe("app-disabled");
    expect(ended?.summary?.participants).toBe(2);
  });

  it("reads the frames through the shared schema and ignores what it does not know", () => {
    expect(handleAppsFrame({ type: "welcome" })).toBe(false);
    expect(
      handleAppsFrame({ type: "channel-app", channelId: CH1, session: session(S1) }),
    ).toBe(true);
    expect(getAppSessionsSnapshot().live.get(CH1)?.id).toBe(S1);
    // A malformed one is swallowed, not applied.
    expect(handleAppsFrame({ type: "channel-app", channelId: "nope" })).toBe(true);
    expect(getAppSessionsSnapshot().live.size).toBe(1);
  });

  it("finds a session's message by the instant they share", () => {
    applyChannelApp(CH1, session(S1));
    const snap = getAppSessionsSnapshot();
    expect(liveSessionOfMessage(snap, CH1, T0)?.id).toBe(S1);
    expect(liveSessionOfMessage(snap, CH1, "2026-10-19T09:00:00.000Z")).toBeUndefined();
    expect(liveSessionOfMessage(snap, CH2, T0)).toBeUndefined();
    expect(startedWith(T0, "2026-10-19T10:00:00.400Z")).toBe(true);
    expect(startedWith(T0, "garbage")).toBe(false);
    applyChannelApp(CH1, null);
    expect(endedSessionOfMessage(getAppSessionsSnapshot(), CH1, T0)?.sessionId).toBe(S1);
  });

  it("starts a new session in a channel as the end of the one before", () => {
    applyChannelApp(CH1, session(S1));
    applyChannelApp(CH1, session(S2, { startedAt: "2026-10-19T11:00:00.000Z" }));
    expect(getAppSessionsSnapshot().ended.has(S1)).toBe(true);
    expect(getAppSessionsSnapshot().live.get(CH1)?.id).toBe(S2);
  });
});

describe("the live store: the catch-up", () => {
  it("fills the server's channels and marks the server loaded", () => {
    applyCatchUp(SERVER, [CH1, CH2], [{ channelId: CH1, session: session(S1) }], appFrameClock());
    const snap = getAppSessionsSnapshot();
    expect(snap.live.get(CH1)?.id).toBe(S1);
    expect(snap.loadedServers.has(SERVER)).toBe(true);
  });

  it("drops a session whose end was missed while the socket was down", () => {
    applyCatchUp(SERVER, [CH1], [{ channelId: CH1, session: session(S1) }], appFrameClock());
    applyCatchUp(SERVER, [CH1], [], appFrameClock());
    expect(getAppSessionsSnapshot().live.has(CH1)).toBe(false);
    expect(getAppSessionsSnapshot().ended.has(S1)).toBe(true);
  });

  it("does not let a slow answer undo a frame that landed while it was in flight", () => {
    applyCatchUp(SERVER, [CH1], [{ channelId: CH1, session: session(S1) }], appFrameClock());
    const clock = appFrameClock();
    // The read starts here; the session ends and a new one starts meanwhile.
    applyChannelApp(CH1, null);
    // The read's (older) answer still lists the first session.
    applyCatchUp(SERVER, [CH1], [{ channelId: CH1, session: session(S1) }], clock);
    expect(getAppSessionsSnapshot().live.has(CH1)).toBe(false);
  });

  it("does not drop a session a frame announced while the read was in flight", () => {
    const clock = appFrameClock();
    applyChannelApp(CH1, session(S1));
    applyCatchUp(SERVER, [CH1], [], clock);
    expect(getAppSessionsSnapshot().live.get(CH1)?.id).toBe(S1);
  });

  it("leaves other servers alone and forgets one whose flag went off", () => {
    applyCatchUp(SERVER, [CH1], [{ channelId: CH1, session: session(S1) }], appFrameClock());
    applyCatchUp("other", [CH2], [], appFrameClock());
    expect(getAppSessionsSnapshot().live.has(CH1)).toBe(true);
    dropAppSessionsOfServer(SERVER);
    expect(getAppSessionsSnapshot().live.has(CH1)).toBe(false);
    expect(getAppSessionsSnapshot().loadedServers.has(SERVER)).toBe(false);
  });
});

describe("the live store: joining", () => {
  const sent: Array<{ op: string; id: string; spectator?: boolean }> = [];
  beforeEach(() => {
    sent.length = 0;
    setAppsViewer(ME);
    registerAppJoinTransport({
      sendJoin: (id, options) => {
        sent.push({ op: "join", id, spectator: options.asSpectator === true });
        return true;
      },
      sendLeave: (id) => {
        sent.push({ op: "leave", id });
        return true;
      },
    });
    applyChannelApp(CH1, session(S1));
  });

  it("goes Entrando, then lands when the summary seats the viewer", () => {
    joinAppSession(S1);
    expect(sent).toEqual([{ op: "join", id: S1, spectator: false }]);
    expect(getAppSessionsSnapshot().join.get(S1)?.status).toBe("joining");
    applyChannelApp(CH1, session(S1, { participants: [seated(ME)], players: 1 }));
    expect(getAppSessionsSnapshot().join.has(S1)).toBe(false);
  });

  it("fails after the timeout, and a second press while joining sends nothing", () => {
    joinAppSession(S1);
    joinAppSession(S1);
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(APP_JOIN_TIMEOUT_MS + 1);
    expect(getAppSessionsSnapshot().join.get(S1)).toMatchObject({
      status: "failed",
      code: "connection",
    });
    // Tentar de novo sends it again.
    joinAppSession(S1);
    expect(sent).toHaveLength(2);
  });

  it("fails at once with the socket down, without sending", () => {
    setAppsOnline(false);
    joinAppSession(S1);
    expect(sent).toHaveLength(0);
    expect(getAppSessionsSnapshot().join.get(S1)).toMatchObject({ status: "failed" });
  });

  it("reads an app-error: a refusal fails the card, a full room is not the person's failure", () => {
    joinAppSession(S1);
    handleAppsFrame({ type: "app-error", sessionId: S1, op: "join", code: "not-allowed" });
    expect(getAppSessionsSnapshot().join.get(S1)).toMatchObject({
      status: "failed",
      code: "not-allowed",
    });
    joinAppSession(S1);
    handleAppsFrame({ type: "app-error", sessionId: S1, op: "join", code: "full" });
    expect(getAppSessionsSnapshot().join.has(S1)).toBe(false);
  });

  it("asks the interceptor first, and joins directly without one", () => {
    const seen: string[] = [];
    const off = registerAppJoinInterceptor((id) => seen.push(id));
    requestAppJoin(S1);
    expect(seen).toEqual([S1]);
    expect(sent).toHaveLength(0);
    off();
    requestAppJoin(S1, { asSpectator: true });
    expect(sent).toEqual([{ op: "join", id: S1, spectator: true }]);
  });

  it("a session that ends clears its join", () => {
    joinAppSession(S1);
    applyChannelApp(CH1, null);
    expect(getAppSessionsSnapshot().join.has(S1)).toBe(false);
  });
});
