import { describe, expect, it } from "vitest";
import { APP_END_REASONS } from "./common.js";
import {
  APP_ERROR_CODES,
  APP_ERROR_OPS,
  appClientFrameSchema,
  appServerFrameSchema,
} from "./frames.js";
import { APP_EVENT_MAX_BYTES, APP_STATE_MAX_BYTES } from "./manifest.js";
import { APP_MAX_PARTICIPANTS } from "./limits.js";

const SESSION = "5f0c1f3e-7c3a-4b8e-9d52-0a1b2c3d4e5f";
const CHANNEL = "a3c1b2d4-1111-4222-8333-444455556666";
const USER = "0b9d8c7e-2222-4333-9444-555566667777";
const USER_2 = "1c0e9d8f-3333-4444-a555-666677778888";
const SEAT = "seat_AAAAAAAAAAAAAAAA";
const NOW = "2026-10-18T12:00:00.000Z";

const summary = (extra: Record<string, unknown> = {}) => ({
  id: SESSION,
  appId: "eco",
  appVersion: "1.0.0",
  startedBy: USER,
  hostUserId: USER,
  startedAt: NOW,
  participants: [{ userId: USER, role: "player", joinedAt: NOW, connection: "present" }],
  players: 1,
  spectators: 0,
  handoff: null,
  ...extra,
});

/** One minimal valid example of every client to server frame. */
const clientFrames: Record<string, Record<string, unknown>> = {
  "app-join": { type: "app-join", sessionId: SESSION },
  "app-leave": { type: "app-leave", sessionId: SESSION },
  "app-state-patch": { type: "app-state-patch", sessionId: SESSION, patch: { n: 1 } },
  "app-event-send": { type: "app-event-send", sessionId: SESSION, name: "ping", data: 1 },
};

/** One minimal valid example of every server to client frame. */
const serverFrames: Record<string, Record<string, unknown>> = {
  "channel-app": { type: "channel-app", channelId: CHANNEL, session: summary() },
  "app-session": {
    type: "app-session",
    sessionId: SESSION,
    seatId: SEAT,
    role: "player",
    isHost: true,
    state: { rev: 0, value: {} },
    participants: [{ seatId: SEAT, userId: USER, role: "player", isHost: true, connection: "present" }],
  },
  "app-state": { type: "app-state", sessionId: SESSION, rev: 3, value: { n: 1 } },
  "app-event": { type: "app-event", sessionId: SESSION, fromSeatId: SEAT, name: "ping", data: [] },
  "app-ended": {
    type: "app-ended",
    sessionId: SESSION,
    channelId: CHANNEL,
    reason: "host",
    summary: { participants: 3, durationSeconds: 120 },
  },
  "app-error": { type: "app-error", sessionId: SESSION, op: "join", code: "full" },
};

describe("client to server frames", () => {
  it.each(Object.keys(clientFrames))("accepts %s", (type) => {
    expect(appClientFrameSchema.safeParse(clientFrames[type]).success).toBe(true);
  });

  it("accepts the optional fields", () => {
    expect(
      appClientFrameSchema.safeParse({ ...clientFrames["app-join"], asSpectator: true }).success,
    ).toBe(true);
    expect(
      appClientFrameSchema.safeParse({ ...clientFrames["app-state-patch"], baseRev: 4 }).success,
    ).toBe(true);
  });

  it("rejects an unknown type", () => {
    expect(appClientFrameSchema.safeParse({ type: "app-kick", sessionId: SESSION }).success).toBe(
      false,
    );
  });

  it.each(Object.keys(clientFrames))("rejects an unknown extra key on %s", (type) => {
    expect(appClientFrameSchema.safeParse({ ...clientFrames[type], extra: 1 }).success).toBe(false);
  });

  it.each(Object.keys(clientFrames))("rejects a session id that is not a uuid on %s", (type) => {
    expect(
      appClientFrameSchema.safeParse({ ...clientFrames[type], sessionId: "not-a-uuid" }).success,
    ).toBe(false);
  });

  it("rejects an oversize state patch at 16385 bytes and accepts exactly 16384", () => {
    const frame = (patch: unknown) => ({ ...clientFrames["app-state-patch"], patch });
    expect(
      appClientFrameSchema.safeParse(frame({ a: "x".repeat(APP_STATE_MAX_BYTES - 8) })).success,
    ).toBe(true);
    expect(
      appClientFrameSchema.safeParse(frame({ a: "x".repeat(APP_STATE_MAX_BYTES - 7) })).success,
    ).toBe(false);
  });

  it("rejects an oversize event at 1025 bytes and accepts exactly 1024", () => {
    const frame = (data: unknown) => ({ ...clientFrames["app-event-send"], data });
    expect(
      appClientFrameSchema.safeParse(frame("x".repeat(APP_EVENT_MAX_BYTES - 2))).success,
    ).toBe(true);
    expect(
      appClientFrameSchema.safeParse(frame("x".repeat(APP_EVENT_MAX_BYTES - 1))).success,
    ).toBe(false);
  });

  it("rejects values that are not JSON, and nesting of 33", () => {
    const bad: unknown[] = [
      undefined,
      () => 1,
      [1, undefined],
      { a: undefined },
      Number.NaN,
      Number.POSITIVE_INFINITY,
      new Date(),
    ];
    for (const value of bad) {
      expect(
        appClientFrameSchema.safeParse({ ...clientFrames["app-state-patch"], patch: value }).success,
      ).toBe(false);
      expect(
        appClientFrameSchema.safeParse({ ...clientFrames["app-event-send"], data: value }).success,
      ).toBe(false);
    }
    const nest = (depth: number) => {
      let value: unknown = 1;
      for (let i = 0; i < depth; i += 1) value = { a: value };
      return value;
    };
    expect(
      appClientFrameSchema.safeParse({ ...clientFrames["app-state-patch"], patch: nest(32) })
        .success,
    ).toBe(true);
    expect(
      appClientFrameSchema.safeParse({ ...clientFrames["app-state-patch"], patch: nest(33) })
        .success,
    ).toBe(false);
  });

  it("rejects a bad event name and a bad baseRev", () => {
    expect(
      appClientFrameSchema.safeParse({ ...clientFrames["app-event-send"], name: "Ping" }).success,
    ).toBe(false);
    expect(
      appClientFrameSchema.safeParse({ ...clientFrames["app-state-patch"], baseRev: -1 }).success,
    ).toBe(false);
    expect(
      appClientFrameSchema.safeParse({ ...clientFrames["app-join"], asSpectator: "yes" }).success,
    ).toBe(false);
  });
});

describe("server to client frames", () => {
  it.each(Object.keys(serverFrames))("accepts %s", (type) => {
    const result = appServerFrameSchema.safeParse(serverFrames[type]);
    expect(result.success, JSON.stringify(result)).toBe(true);
  });

  it("accepts a channel with no live session", () => {
    expect(
      appServerFrameSchema.safeParse({ type: "channel-app", channelId: CHANNEL, session: null })
        .success,
    ).toBe(true);
  });

  it("accepts a summary with nobody in charge and a handoff counting down", () => {
    const frame = (session: unknown) => ({ type: "channel-app", channelId: CHANNEL, session });
    expect(
      appServerFrameSchema.safeParse(
        frame(
          summary({
            startedBy: null,
            hostUserId: null,
            handoff: { toUserId: USER_2, at: NOW },
          }),
        ),
      ).success,
    ).toBe(true);
    expect(
      appServerFrameSchema.safeParse(frame(summary({ handoff: { toUserId: null, at: NOW } })))
        .success,
    ).toBe(true);
  });

  it("accepts an app-session participant with a derived id, and rejects a malformed one", () => {
    const frame = (participant: Record<string, unknown>) => ({
      ...serverFrames["app-session"],
      participants: [participant],
    });
    const base = { seatId: SEAT, userId: USER, role: "player", isHost: true, connection: "present" };
    expect(
      appServerFrameSchema.safeParse(frame({ ...base, appUserId: "A".repeat(43) })).success,
    ).toBe(true);
    expect(appServerFrameSchema.safeParse(frame({ ...base, appUserId: "x" })).success).toBe(false);
  });

  it("rejects an unknown type", () => {
    expect(appServerFrameSchema.safeParse({ type: "app-shout", sessionId: SESSION }).success).toBe(
      false,
    );
  });

  // The direction rule: strict toward the server (untrusted input), tolerant of a newer server.
  it.each(Object.keys(serverFrames))("strips an unknown extra key on %s", (type) => {
    const result = appServerFrameSchema.safeParse({ ...serverFrames[type], extra: 1 });
    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(result.success && "extra" in result.data).toBe(false);
  });

  it("strips an unknown key inside nested objects instead of rejecting the frame", () => {
    const channelApp = appServerFrameSchema.parse({
      type: "channel-app",
      channelId: CHANNEL,
      session: summary({
        futureField: 1,
        participants: [
          { userId: USER, role: "player", joinedAt: NOW, connection: "present", seatId: SEAT },
        ],
        handoff: { toUserId: null, at: NOW, reason: "x" },
      }),
    });
    expect(JSON.stringify(channelApp)).not.toMatch(/futureField|seatId|reason/);
    const ended = appServerFrameSchema.parse({
      ...serverFrames["app-ended"],
      summary: { participants: 1, durationSeconds: 1, x: 1 },
    });
    expect(ended).toMatchObject({ summary: { participants: 1, durationSeconds: 1 } });
    expect(JSON.stringify(ended)).not.toContain('"x"');
    const session = appServerFrameSchema.parse({
      ...serverFrames["app-session"],
      state: { rev: 0, value: {}, x: 1 },
    });
    expect(JSON.stringify(session)).not.toContain('"x"');
  });

  it("carries a per-participant connection state in the summary and the snapshot", () => {
    const summaryWith = (connection: unknown) => ({
      type: "channel-app",
      channelId: CHANNEL,
      session: summary({
        participants: [{ userId: USER, role: "player", joinedAt: NOW, connection }],
      }),
    });
    const snapshotWith = (connection: unknown) => ({
      ...serverFrames["app-session"],
      participants: [{ seatId: SEAT, userId: USER, role: "player", isHost: true, connection }],
    });
    expect(appServerFrameSchema.safeParse(summaryWith("reconnecting")).success).toBe(true);
    expect(appServerFrameSchema.safeParse(snapshotWith("reconnecting")).success).toBe(true);
    for (const bad of ["gone", undefined, true]) {
      expect(appServerFrameSchema.safeParse(summaryWith(bad)).success).toBe(false);
      expect(appServerFrameSchema.safeParse(snapshotWith(bad)).success).toBe(false);
    }
  });

  it("rejects a bad seat id", () => {
    for (const seatId of ["short", "a".repeat(33), "has space 1234567890", USER]) {
      expect(appServerFrameSchema.safeParse({ ...serverFrames["app-event"], fromSeatId: seatId }).success).toBe(false);
      expect(appServerFrameSchema.safeParse({ ...serverFrames["app-session"], seatId }).success).toBe(false);
      expect(
        appServerFrameSchema.safeParse({
          ...serverFrames["app-session"],
          participants: [{ seatId, userId: USER, role: "player", isHost: false, connection: "present" }],
        }).success,
      ).toBe(false);
    }
  });

  it("caps participants at 264 in the summary and in the snapshot", () => {
    const uuidAt = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    const summaryOf = (count: number) => ({
      type: "channel-app",
      channelId: CHANNEL,
      session: summary({
        participants: Array.from({ length: count }, (_, i) => ({
          userId: uuidAt(i),
          role: "spectator",
          joinedAt: NOW,
          connection: "present",
        })),
      }),
    });
    const snapshotOf = (count: number) => ({
      ...serverFrames["app-session"],
      participants: Array.from({ length: count }, (_, i) => ({
        seatId: `seat${String(i).padStart(12, "0")}`,
        userId: uuidAt(i),
        role: "spectator",
        isHost: false,
        connection: "present",
      })),
    });
    expect(appServerFrameSchema.safeParse(summaryOf(APP_MAX_PARTICIPANTS)).success).toBe(true);
    expect(appServerFrameSchema.safeParse(summaryOf(APP_MAX_PARTICIPANTS + 1)).success).toBe(false);
    expect(appServerFrameSchema.safeParse(snapshotOf(APP_MAX_PARTICIPANTS)).success).toBe(true);
    expect(appServerFrameSchema.safeParse(snapshotOf(APP_MAX_PARTICIPANTS + 1)).success).toBe(
      false,
    );
  });

  it("holds state and event relays to the size and JSON rules", () => {
    expect(
      appServerFrameSchema.safeParse({
        ...serverFrames["app-state"],
        value: { a: "x".repeat(APP_STATE_MAX_BYTES - 7) },
      }).success,
    ).toBe(false);
    expect(
      appServerFrameSchema.safeParse({
        ...serverFrames["app-event"],
        data: "x".repeat(APP_EVENT_MAX_BYTES - 1),
      }).success,
    ).toBe(false);
    expect(
      appServerFrameSchema.safeParse({ ...serverFrames["app-state"], value: { a: Number.NaN } })
        .success,
    ).toBe(false);
  });

  it("accepts every end reason of the data model and no other", () => {
    for (const reason of APP_END_REASONS) {
      expect(appServerFrameSchema.safeParse({ ...serverFrames["app-ended"], reason }).success).toBe(
        true,
      );
    }
    expect(
      appServerFrameSchema.safeParse({ ...serverFrames["app-ended"], reason: "because" }).success,
    ).toBe(false);
  });

  it("accepts every app-error op and code, and no other", () => {
    for (const op of APP_ERROR_OPS) {
      for (const code of APP_ERROR_CODES) {
        expect(
          appServerFrameSchema.safeParse({ type: "app-error", sessionId: SESSION, op, code })
            .success,
        ).toBe(true);
      }
    }
    expect([...APP_ERROR_OPS]).toEqual(["join", "leave", "state", "event"]);
    expect([...APP_ERROR_CODES]).toEqual([
      "full",
      "not-allowed",
      "ended",
      "rate-limited",
      "too-large",
      "stale-rev",
      "unavailable",
    ]);
    expect(
      appServerFrameSchema.safeParse({ ...serverFrames["app-error"], op: "kick" }).success,
    ).toBe(false);
    expect(
      appServerFrameSchema.safeParse({ ...serverFrames["app-error"], code: "boom" }).success,
    ).toBe(false);
  });

  it("rejects negative counters and a malformed timestamp", () => {
    expect(
      appServerFrameSchema.safeParse({
        ...serverFrames["app-ended"],
        summary: { participants: -1, durationSeconds: 1 },
      }).success,
    ).toBe(false);
    expect(
      appServerFrameSchema.safeParse({
        type: "channel-app",
        channelId: CHANNEL,
        session: summary({ startedAt: "yesterday" }),
      }).success,
    ).toBe(false);
    expect(
      appServerFrameSchema.safeParse({
        type: "channel-app",
        channelId: "nope",
        session: null,
      }).success,
    ).toBe(false);
  });
});
