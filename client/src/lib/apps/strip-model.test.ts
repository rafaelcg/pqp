import type { AppConfigEntry, AppSessionSummary } from "@pqp/shared";
import { describe, expect, it } from "vitest";
import type { EndedAppSession } from "@/lib/apps/app-sessions-store";
import type { CardPerson } from "@/lib/apps/card-model";
import {
  announceHandoffAt,
  buildEndedStrip,
  buildLiveStrip,
  type StripInput,
} from "@/lib/apps/strip-model";

const ME = "00000000-0000-4000-8000-000000000001";
const BIA = "00000000-0000-4000-8000-000000000002";
const LEO = "00000000-0000-4000-8000-000000000003";
const DUDA = "00000000-0000-4000-8000-000000000004";
const NOW = Date.parse("2026-10-19T20:00:00Z");

const names: Record<string, string> = { [ME]: "rafa", [BIA]: "bia", [LEO]: "leo", [DUDA]: "duda" };
const person = (id: string): CardPerson | undefined =>
  names[id] ? { userId: id, displayName: names[id]!, avatarUrl: null } : undefined;

function app(over: Record<string, unknown> = {}): AppConfigEntry {
  return {
    id: "pqp-eco",
    version: "1.0.0",
    category: "tool",
    icon: "gamepad",
    name: "name",
    description: "description",
    presence: { phrase: "presence.phrase", short: "presence.short" },
    channelTypes: ["text", "voice"],
    players: { min: 1, max: 4, spectators: true, maxSpectators: 50 },
    capabilities: { identity: "display", share: "pane", localFiles: { allowed: false }, peer: "none" },
    content: { userText: false, userImages: false },
    hostBound: false,
    i18n: { en: { name: "Game room" }, "pt-BR": { name: "Sala de jogos" } },
    entry: { url: "http://localhost:5175/pqp-eco/1.0.0/index.html" },
    assets: [],
    available: true,
    reason: null,
    shareAllowed: true,
    ...over,
  } as AppConfigEntry;
}

function row(userId: string, over: Record<string, unknown> = {}) {
  return {
    userId,
    role: "player" as const,
    joinedAt: "2026-10-19T19:50:00Z",
    connection: "present" as const,
    ...over,
  };
}

function live(over: Partial<AppSessionSummary> = {}): AppSessionSummary {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    appId: "pqp-eco",
    appVersion: "1.0.0",
    startedBy: BIA,
    hostUserId: BIA,
    startedAt: "2026-10-19T19:50:00Z",
    participants: [row(BIA), row(LEO), row(DUDA)],
    players: 3,
    spectators: 0,
    handoff: null,
    ...over,
  };
}

function input(over: Partial<StripInput> = {}): StripInput {
  return {
    live: live(),
    app: app(),
    viewerId: ME,
    person,
    online: true,
    offlineSince: null,
    now: NOW,
    locale: "pt-BR",
    canModerate: false,
    channelType: "voice",
    phone: false,
    leftLocally: false,
    ...over,
  };
}

describe("the session strip, state by state (mock 03)", () => {
  it("host with a pane app: Sair, Encerrar and the share switch (estado 1)", () => {
    const model = buildLiveStrip(
      input({ live: live({ hostUserId: ME, participants: [row(ME), row(LEO), row(DUDA)] }) }),
    )!;
    expect(model.phase).toBe("host");
    expect(model.line).toEqual({ kind: "host" });
    expect(model.actions).toMatchObject({ leave: true, end: true, share: true, enter: null, takeHost: false });
    expect(model.count).toEqual({ kind: "of", players: 3, max: 4, watching: 0 });
    expect(model.showPane).toBe(true);
    expect(model.app.name).toBe("Sala de jogos");
  });

  it("host of an app that cannot share has no switch at all (estado 4)", () => {
    const model = buildLiveStrip(
      input({
        app: app({ capabilities: { identity: "display", share: "none", localFiles: { allowed: false }, peer: "none" } }),
        live: live({ hostUserId: ME, participants: [row(ME)], players: 1 }),
      }),
    )!;
    expect(model.actions.share).toBe(false);
    expect(model.actions.end).toBe(true);
  });

  it("no share switch where the server does not allow it (D14), in a text channel, or on a phone", () => {
    const hosting = live({ hostUserId: ME, participants: [row(ME)], players: 1 });
    expect(buildLiveStrip(input({ live: hosting, app: app({ shareAllowed: false }) }))!.actions.share).toBe(false);
    expect(buildLiveStrip(input({ live: hosting, channelType: "text" }))!.actions.share).toBe(false);
    expect(buildLiveStrip(input({ live: hosting, phone: true }))!.actions.share).toBe(false);
  });

  it("a participant has Sair and neither Encerrar nor the switch (estado 3)", () => {
    const model = buildLiveStrip(input({ live: live({ participants: [row(BIA), row(ME)] }) }))!;
    expect(model.phase).toBe("participant");
    expect(model.line).toEqual({ kind: "hostIs", name: "bia" });
    expect(model.actions).toMatchObject({ leave: true, end: false, share: false });
  });

  it("a spectator is told so and keeps the host's name (estado 5)", () => {
    const model = buildLiveStrip(
      input({
        live: live({
          participants: [row(BIA), row(LEO), row(DUDA), row(ME, { role: "spectator" })],
          players: 3,
          spectators: 1,
        }),
      }),
    )!;
    expect(model.phase).toBe("spectator");
    expect(model.spectating).toBe(true);
    expect(model.line).toEqual({ kind: "watching", name: "bia" });
    expect(model.count).toEqual({ kind: "of", players: 3, max: 4, watching: 1 });
  });

  it("the host left and the viewer is next: a warm strip, the countdown and Assumir agora (estado 6)", () => {
    const model = buildLiveStrip(
      input({
        live: live({
          participants: [row(ME), row(LEO)],
          handoff: { toUserId: ME, at: "2026-10-19T20:01:48Z" },
        }),
      }),
    )!;
    expect(model.phase).toBe("handoff-you");
    expect(model.tone).toBe("warn");
    expect(model.line).toEqual({ kind: "handoffYou", host: "bia", seconds: 108 });
    expect(model.actions.takeHost).toBe(true);
  });

  it("the host left and somebody else is next: only the text (estado 7)", () => {
    const model = buildLiveStrip(
      input({
        live: live({
          participants: [row(ME), row(LEO)],
          handoff: { toUserId: LEO, at: "2026-10-19T20:01:48Z" },
        }),
      }),
    )!;
    expect(model.phase).toBe("handoff-other");
    expect(model.line).toEqual({ kind: "handoffOther", host: "bia", next: "leo", seconds: 108 });
    expect(model.actions.takeHost).toBe(false);
  });

  it("nobody is eligible: the app says it ends", () => {
    const model = buildLiveStrip(
      input({ live: live({ participants: [row(ME)], handoff: { toUserId: null, at: "2026-10-19T20:00:30Z" } }) }),
    )!;
    expect(model.line).toEqual({ kind: "handoffNone", host: "bia", seconds: 30 });
  });

  it("the countdown never goes below zero", () => {
    const model = buildLiveStrip(
      input({ live: live({ participants: [row(ME)], handoff: { toUserId: ME, at: "2026-10-19T19:59:00Z" } }) }),
    )!;
    expect(model.line).toMatchObject({ seconds: 0 });
  });

  it("without a connection the strip says the seat is kept, then that it was released (estado 8)", () => {
    const seated = live({ participants: [row(BIA), row(ME)] });
    const dropped = buildLiveStrip(input({ live: seated, online: false, offlineSince: NOW - 10_000 }))!;
    expect(dropped.phase).toBe("reconnecting");
    expect(dropped.tone).toBe("off");
    expect(dropped.showPane).toBe(true);
    const gone = buildLiveStrip(input({ live: seated, online: false, offlineSince: NOW - 91_000 }))!;
    expect(gone.phase).toBe("lost");
    expect(gone.showPane).toBe(false);
  });

  it("a seat the server holds for the viewer reads as reconnecting even with this tab online", () => {
    const model = buildLiveStrip(
      input({ live: live({ participants: [row(BIA), row(ME, { connection: "reconnecting" })] }) }),
    )!;
    expect(model.phase).toBe("reconnecting");
  });

  it("outside the session the strip stays with Entrar (and Assistir when full)", () => {
    const open = buildLiveStrip(input())!;
    expect(open.phase).toBe("outside");
    expect(open.seated).toBe(false);
    expect(open.showPane).toBe(false);
    expect(open.actions).toMatchObject({ enter: "join", leave: false });

    const full = buildLiveStrip(input({ live: live({ players: 4 }) }))!;
    expect(full.actions.enter).toBe("watch");
    const fullNoSpectators = buildLiveStrip(
      input({ live: live({ players: 4 }), app: app({ players: { min: 1, max: 4, spectators: false, maxSpectators: 0 } }) }),
    )!;
    expect(fullNoSpectators.actions.enter).toBeNull();
    // D14: an emulator app admits spectators only where the share gate is open
    const gated = buildLiveStrip(input({ live: live({ players: 4 }), app: app({ shareAllowed: false }) }))!;
    expect(gated.actions.enter).toBeNull();
  });

  it("pressing Sair takes the pane down before the server's summary catches up", () => {
    const model = buildLiveStrip(
      input({ live: live({ participants: [row(BIA), row(ME)] }), leftLocally: true }),
    )!;
    expect(model.seated).toBe(false);
    expect(model.showPane).toBe(false);
    expect(model.actions.enter).toBe("join");
  });

  it("a moderator who is not the host may end it; an ordinary member may not", () => {
    expect(buildLiveStrip(input({ canModerate: true }))!.actions.end).toBe(true);
    expect(buildLiveStrip(input())!.actions.end).toBe(false);
  });

  it("an app with room for everybody says how many are in, not how many fit", () => {
    const model = buildLiveStrip(
      input({ app: app({ players: { min: 1, max: 64, spectators: true, maxSpectators: 50 } }) }),
    )!;
    expect(model.count).toEqual({ kind: "open", players: 3, watching: 0 });
  });

  it("a name nobody knows is a question mark, never an id", () => {
    const stranger = "00000000-0000-4000-8000-0000000000ff";
    const model = buildLiveStrip(input({ live: live({ hostUserId: stranger }) }))!;
    expect(model.line).toEqual({ kind: "hostIs", name: "?" });
  });

  it("an app that left the list is named by its id, never blank", () => {
    expect(buildLiveStrip(input({ app: undefined }))!.app.name).toBe("pqp-eco");
  });
});

describe("the ended strip (estado 9 and 10)", () => {
  function ended(over: Partial<EndedAppSession> = {}): EndedAppSession {
    return {
      sessionId: "11111111-1111-4111-8111-111111111111",
      channelId: "22222222-2222-4222-8222-222222222222",
      appId: "pqp-eco",
      startedAt: "2026-10-19T19:50:00Z",
      startedBy: BIA,
      hostUserId: BIA,
      endedAt: NOW,
      reason: "host",
      summary: { participants: 4, durationSeconds: 23 * 60 },
      participantIds: [BIA],
      ...over,
    };
  }

  it("names who ended it and how it went", () => {
    const model = buildEndedStrip(input({ live: undefined, ended: ended() }))!;
    expect(model.cause).toEqual({ kind: "host", name: "bia", self: false });
    expect(model.summary).toEqual({ participants: 4, durationSeconds: 1380 });
    expect(model.disabled).toBe(false);
  });

  it("says so when the viewer ended it", () => {
    const model = buildEndedStrip(input({ live: undefined, ended: ended({ hostUserId: ME }) }))!;
    expect(model.cause).toEqual({ kind: "host", name: "rafa", self: true });
  });

  it("an operator switch is its own line and never blames anybody", () => {
    for (const reason of ["operator", "app-disabled", "flag-off"] as const) {
      expect(buildEndedStrip(input({ live: undefined, ended: ended({ reason }) }))!.disabled).toBe(true);
    }
  });

  it("every other reason has a cause of its own", () => {
    for (const reason of ["moderator", "idle", "host-gone", "empty", "max-duration", "channel-gone"] as const) {
      expect(buildEndedStrip(input({ live: undefined, ended: ended({ reason }) }))!.cause.kind).toBe(reason);
    }
    expect(buildEndedStrip(input({ live: undefined, ended: ended({ reason: null }) }))!.cause.kind).toBe("unknown");
  });

  it("nothing to draw without an ended session", () => {
    expect(buildEndedStrip(input({ live: undefined }))).toBeNull();
  });
});

describe("the countdown's announcements", () => {
  it("are spoken at 60, 30 and 10 seconds and nowhere else", () => {
    const spoken = Array.from({ length: 121 }, (_, i) => 120 - i).filter(announceHandoffAt);
    expect(spoken).toEqual([60, 30, 10]);
  });
});
