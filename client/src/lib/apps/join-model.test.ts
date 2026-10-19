import type { AppConfigEntry, AppSessionSummary } from "@pqp/shared";
import { describe, expect, it } from "vitest";
import { canWatchFull, failureOf, joinSheetFace, type JoinSheetInput } from "./join-model";

const ME = "00000000-0000-4000-8000-000000000001";
const BIA = "00000000-0000-4000-8000-000000000002";

const app = {
  id: "pqp-eco",
  available: true,
  shareAllowed: true,
  players: { min: 1, max: 4, spectators: true, maxSpectators: 50 },
} as unknown as AppConfigEntry;

function session(players: number, seated = false): AppSessionSummary {
  const rows = Array.from({ length: players }, (_, i) => ({
    userId: i === 0 ? BIA : `00000000-0000-4000-8000-0000000001${String(i).padStart(2, "0")}`,
    role: "player" as const,
    joinedAt: "2026-10-19T19:50:00Z",
    connection: "present" as const,
  }));
  if (seated) rows.push({ ...rows[0]!, userId: ME });
  return {
    id: "11111111-1111-4111-8111-111111111111",
    appId: "pqp-eco",
    appVersion: "1.0.0",
    startedBy: BIA,
    hostUserId: BIA,
    startedAt: "2026-10-19T19:50:00Z",
    participants: rows,
    players: rows.length,
    spectators: 0,
    handoff: null,
  };
}

function input(over: Partial<JoinSheetInput> = {}): JoinSheetInput {
  return {
    session: session(3),
    app,
    viewerId: ME,
    local: { phase: "idle" },
    join: undefined,
    ...over,
  };
}

describe("joinSheetFace (mock 04)", () => {
  it("the first time: ask (estado 1)", () => {
    expect(joinSheetFace(input())).toBe("ask");
  });

  it("pressing Entrar: both buttons locked while entering (estado 3)", () => {
    expect(joinSheetFace(input({ local: { phase: "entering" } }))).toBe("entering");
    expect(joinSheetFace(input({ join: { status: "joining", since: 1 } }))).toBe("entering");
  });

  it("a failed join is the alert and Tentar de novo (estado 4), whatever failed", () => {
    expect(joinSheetFace(input({ join: { status: "failed", code: "connection", at: 1 } }))).toBe("failed");
    expect(joinSheetFace(input({ join: { status: "failed", code: "not-allowed", at: 1 } }))).toBe("failed");
    expect(joinSheetFace(input({ local: { phase: "failed" } }))).toBe("failed");
  });

  it("the room filled while the person read (estado 5)", () => {
    expect(joinSheetFace(input({ session: session(4) }))).toBe("full");
  });

  it("the room filled while the request was out: the refusal is not a failure", () => {
    expect(joinSheetFace(input({ session: session(4), local: { phase: "entering" } }))).toBe("full");
  });

  it("the session ended before they entered (estado 6)", () => {
    expect(joinSheetFace(input({ session: undefined }))).toBe("ended");
  });

  it("the app was switched off, or left the list (estado 7)", () => {
    expect(joinSheetFace(input({ app: undefined }))).toBe("disabled");
    expect(joinSheetFace(input({ app: { ...app, available: false } as AppConfigEntry }))).toBe("disabled");
  });

  it("seated: nothing left to say", () => {
    expect(joinSheetFace(input({ session: session(2, true), local: { phase: "entering" } }))).toBe("done");
  });

  it("an ended session beats everything else", () => {
    expect(joinSheetFace(input({ session: undefined, local: { phase: "entering" } }))).toBe("ended");
  });
});

describe("helpers", () => {
  it("failureOf defaults to the connection", () => {
    expect(failureOf(undefined)).toBe("connection");
    expect(failureOf({ status: "failed", code: "rate-limited", at: 1 })).toBe("rate-limited");
    expect(failureOf({ status: "joining", since: 1 })).toBe("connection");
  });

  it("Assistir needs spectators and, for an emulator, the share gate (D14)", () => {
    expect(canWatchFull(app)).toBe(true);
    expect(canWatchFull({ ...app, shareAllowed: false } as AppConfigEntry)).toBe(false);
    expect(
      canWatchFull({ ...app, players: { ...app.players, spectators: false } } as AppConfigEntry),
    ).toBe(false);
    expect(canWatchFull(undefined)).toBe(false);
  });
});
