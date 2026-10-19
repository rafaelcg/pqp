import type { AppConfigEntry, AppSessionSummary, MessageAppSession } from "@pqp/shared";
import { describe, expect, it } from "vitest";
import type { EndedAppSession } from "./app-sessions-store";
import {
  APP_UNBOUNDED_PLAYERS,
  buildCardModel,
  formatCountdown,
  formatSessionDuration,
  type CardInput,
  type CardModel,
  type CardPerson,
  type EndedCardModel,
  type LiveCardModel,
} from "./card-model";

const ME = "00000000-0000-4000-8000-0000000000b1";
const BIA = "00000000-0000-4000-8000-0000000000b2";
const LEO = "00000000-0000-4000-8000-0000000000b3";
const DUDA = "00000000-0000-4000-8000-0000000000b4";
const NINA = "00000000-0000-4000-8000-0000000000b5";
const SESSION = "00000000-0000-4000-8000-0000000000d1";
const STARTED = "2026-10-19T10:00:00.000Z";
const NOW = Date.parse(STARTED) + 4 * 60_000;

const NAMES: Record<string, string> = {
  [ME]: "rafa",
  [BIA]: "bia",
  [LEO]: "leo",
  [DUDA]: "duda",
  [NINA]: "nina",
};
const person = (id: string): CardPerson | undefined =>
  NAMES[id] ? { userId: id, displayName: NAMES[id]!, avatarUrl: null } : undefined;

function app(over: Partial<AppConfigEntry> = {}): AppConfigEntry {
  return {
    id: "pqp-eco",
    version: "1.0.0",
    category: "game",
    icon: "gamepad",
    name: "name",
    description: "description",
    channelTypes: ["text", "voice"],
    players: { min: 1, max: 4, spectators: true, maxSpectators: 50 },
    capabilities: {
      identity: "display",
      share: "none",
      localFiles: { allowed: false },
      peer: "none",
    },
    content: { userText: false, userImages: false },
    hostBound: false,
    i18n: {
      "pt-BR": { name: "Sala de jogos" },
      en: { name: "Game room" },
      es: { name: "Sala de juegos" },
    },
    entry: { url: null },
    assets: [],
    sandbox: {},
    presence: { phrase: "presence.phrase", short: "presence.short" },
    available: true,
    reason: null,
    shareAllowed: true,
    ...over,
  } as AppConfigEntry;
}

function seat(userId: string, over: Record<string, unknown> = {}) {
  return {
    userId,
    role: "player" as const,
    joinedAt: STARTED,
    connection: "present" as const,
    ...over,
  };
}

function live(over: Partial<AppSessionSummary> = {}): AppSessionSummary {
  return {
    id: SESSION,
    appId: "pqp-eco",
    appVersion: "1.0.0",
    startedBy: BIA,
    hostUserId: BIA,
    startedAt: STARTED,
    participants: [seat(BIA), seat(LEO), seat(DUDA)],
    players: 3,
    spectators: 0,
    handoff: null,
    ...over,
  };
}

/** What `message.appSession` says about this session. */
function carried(over: Partial<MessageAppSession> = {}): MessageAppSession {
  return {
    id: SESSION,
    appId: "pqp-eco",
    appVersion: "1.0.0",
    status: "live",
    endReason: null,
    summary: null,
    startedBy: BIA,
    ...over,
  };
}

function build(over: Partial<CardInput> = {}): CardModel {
  return buildCardModel({
    message: { authorName: "bia", createdAt: STARTED },
    session: carried(),
    live: live(),
    app: app(),
    viewerId: ME,
    person,
    online: true,
    offlineSince: null,
    now: NOW,
    locale: "pt-BR",
    ...over,
  });
}

const asLive = (model: CardModel) => {
  expect(model.kind).toBe("live");
  return model as LiveCardModel;
};
const asEnded = (model: CardModel) => {
  expect(model.kind).toBe("ended");
  return model as EndedCardModel;
};

describe("estado 1: ao vivo, tu ainda nao entrou", () => {
  it("names the app in the viewer's language and counts N dentro, cabem M", () => {
    const model = asLive(build());
    expect(model.app.name).toBe("Sala de jogos");
    expect(model.phase).toBe("open");
    expect(model.subtitle).toEqual({ kind: "started", name: "bia", minutes: 4 });
    expect(model.count).toEqual({ kind: "of", players: 3, max: 4 });
    expect(model.people.map((one) => one.displayName)).toEqual(["bia", "leo", "duda"]);
    expect(model.canWatch).toBe(false);
    expect(model.join).toEqual({ status: "idle" });
  });

  it("reads the same app in English and Spanish", () => {
    expect(asLive(build({ locale: "en" })).app.name).toBe("Game room");
    expect(asLive(build({ locale: "es-MX" })).app.name).toBe("Sala de juegos");
    expect(asLive(build({ locale: "de" })).app.name).toBe("Game room");
  });

  it("says nobody is in yet when the starter has not joined", () => {
    const model = asLive(build({ live: live({ participants: [], players: 0 }) }));
    expect(model.count).toEqual({ kind: "none" });
  });

  it("drops 'cabem' for an app of any size and shows the first four avatars", () => {
    const many = Array.from({ length: 6 }, (_, i) =>
      seat(`00000000-0000-4000-8000-00000000ff0${i}`),
    );
    const model = asLive(
      build({
        live: live({ participants: many, players: 5 }),
        app: app({
          players: { min: 1, max: APP_UNBOUNDED_PLAYERS, spectators: true, maxSpectators: 50 },
        }),
      }),
    );
    expect(model.count).toEqual({ kind: "open", players: 5 });
    expect(model.people).toHaveLength(4);
    expect(model.more).toBe(2);
  });
});

describe("estado 2: tu estas dentro", () => {
  const inside = live({
    participants: [seat(BIA), seat(LEO), seat(DUDA), seat(ME)],
    players: 4,
  });

  it("is inside, full says 'cheio' and the subtitle says tu estas dentro", () => {
    const model = asLive(build({ live: inside }));
    expect(model.phase).toBe("inside");
    expect(model.subtitle).toEqual({ kind: "inside", spectating: false });
    expect(model.count).toEqual({ kind: "inside-full", players: 4 });
    expect(model.full).toBe(false);
  });

  it("a spectator reads 'assistindo'", () => {
    const model = asLive(
      build({
        live: live({
          participants: [seat(BIA), seat(ME, { role: "spectator" })],
          players: 1,
          spectators: 1,
        }),
      }),
    );
    expect(model.subtitle).toEqual({ kind: "inside", spectating: true });
  });
});

describe("estado 3: sessao cheia", () => {
  const full = live({
    participants: [seat(BIA), seat(LEO), seat(DUDA), seat(NINA)],
    players: 4,
    spectators: 2,
  });

  it("offers Assistir when the app takes spectators and the share gate passes", () => {
    const model = asLive(build({ live: full }));
    expect(model.phase).toBe("full");
    expect(model.count).toEqual({ kind: "full", players: 4, max: 4, watching: 2 });
    expect(model.canWatch).toBe(true);
  });

  it("offers nothing when the app has no spectators", () => {
    const model = asLive(
      build({
        live: full,
        app: app({ players: { min: 1, max: 4, spectators: false, maxSpectators: 0 } }),
      }),
    );
    expect(model.full).toBe(true);
    expect(model.canWatch).toBe(false);
  });

  it("offers nothing for an emulator app while the share gate (D14) is closed", () => {
    const model = asLive(build({ live: full, app: app({ category: "emulator", shareAllowed: false }) }));
    expect(model.full).toBe(true);
    expect(model.canWatch).toBe(false);
  });
});

describe("estados 4 e 5: entrando e falhou", () => {
  it("carries the join state onto the live card", () => {
    expect(asLive(build({ join: { status: "joining", since: 1 } })).join).toEqual({
      status: "joining",
    });
    expect(
      asLive(build({ join: { status: "failed", code: "connection", at: 1 } })).join,
    ).toEqual({ status: "failed", code: "connection" });
  });
});

describe("estado 6: conexao caiu, reconectando", () => {
  const inside = live({ participants: [seat(BIA), seat(ME)], players: 2 });

  it("says reconnecting while the socket is down inside the 90 s hold", () => {
    const model = asLive(
      build({ live: inside, online: false, offlineSince: NOW - 30_000 }),
    );
    expect(model.phase).toBe("reconnecting");
    expect(model.subtitle).toEqual({ kind: "reconnecting" });
  });

  it("says reconnecting when the server holds this person's seat", () => {
    const model = asLive(
      build({
        live: live({
          participants: [seat(BIA), seat(ME, { connection: "reconnecting" })],
          players: 2,
        }),
      }),
    );
    expect(model.phase).toBe("reconnecting");
  });

  it("goes back to 'ao vivo' once the hold has run out", () => {
    const model = asLive(
      build({ live: inside, online: false, offlineSince: NOW - 91_000 }),
    );
    expect(model.phase).toBe("open");
  });
});

describe("estado 7: o host saiu", () => {
  const handoff = (toUserId: string | null) =>
    live({
      participants: [seat(LEO), seat(DUDA)],
      players: 2,
      handoff: { toUserId, at: new Date(NOW + 108_000).toISOString() },
    });

  it("says who takes over and in how long", () => {
    const model = asLive(build({ live: handoff(LEO) }));
    expect(model.phase).toBe("host-left");
    expect(model.subtitle).toEqual({
      kind: "handoff",
      host: "bia",
      to: { kind: "person", name: "leo" },
      seconds: 108,
    });
    expect(formatCountdown(108)).toBe("1:48");
  });

  it("says 'tu' when the viewer is the one taking over, and the end when nobody is", () => {
    expect(asLive(build({ live: handoff(ME) })).subtitle).toMatchObject({ to: { kind: "you" } });
    expect(asLive(build({ live: handoff(null) })).subtitle).toMatchObject({ to: { kind: "none" } });
  });

  it("never counts below zero", () => {
    const late = live({
      participants: [seat(LEO)],
      players: 1,
      handoff: { toUserId: LEO, at: new Date(NOW - 5_000).toISOString() },
    });
    expect(asLive(build({ live: late })).subtitle).toMatchObject({ seconds: 0 });
  });
});

describe("estado 8: sessao encerrada", () => {
  const endedRow = (over: Partial<EndedAppSession> = {}): EndedAppSession => ({
    sessionId: SESSION,
    channelId: "c",
    appId: "pqp-eco",
    startedAt: STARTED,
    startedBy: BIA,
    hostUserId: BIA,
    endedAt: NOW,
    reason: "host",
    summary: { participants: 4, durationSeconds: 1380 },
    participantIds: [BIA, LEO, DUDA, NINA],
    ...over,
  });

  it("is quiet: the app, how long, how many, who started", () => {
    const model = asEnded(build({ live: undefined, ended: endedRow() }));
    expect(model.disabled).toBe(false);
    expect(model.gone).toBe(false);
    expect(model.summary).toEqual({ participants: 4, durationSeconds: 1380 });
    expect(model.starterName).toBe("bia");
    expect(model.app.name).toBe("Sala de jogos");
    expect(formatSessionDuration(1380)).toBe("23 min");
  });

  it("has no summary for a session this tab only heard end through channel-app", () => {
    const model = asEnded(build({ live: undefined, ended: endedRow({ summary: null, reason: null }) }));
    expect(model.summary).toBeNull();
    expect(model.disabled).toBe(false);
  });
});

describe("estado 9: app desligado", () => {
  it("is a quiet card with the badge when the end reason is the operator's switch", () => {
    for (const reason of ["app-disabled", "flag-off"] as const) {
      const model = asEnded(
        build({
          live: undefined,
          ended: {
            sessionId: SESSION,
            channelId: "c",
            appId: "pqp-eco",
            startedAt: STARTED,
            startedBy: BIA,
            hostUserId: BIA,
            endedAt: NOW,
            reason,
            summary: null,
            participantIds: [],
          },
        }),
      );
      expect(model.disabled).toBe(true);
    }
  });

  it("is the same card when the app is gone from the list with the session still live", () => {
    const model = asEnded(build({ app: undefined }));
    expect(model.disabled).toBe(true);
    expect(model.app.id).toBe("pqp-eco");
  });
});

describe("a session the page never saw", () => {
  it("is the generic 'terminou' with who started it", () => {
    const model = asEnded(build({ live: undefined, ended: undefined, app: undefined, session: null }));
    expect(model.gone).toBe(true);
    expect(model.disabled).toBe(false);
    expect(model.starterName).toBe("bia");
    expect(model.summary).toBeNull();
  });
});

describe("formatting", () => {
  it("counts down m:ss and rounds a session to minutes, hours past the first", () => {
    expect(formatCountdown(5)).toBe("0:05");
    expect(formatCountdown(-3)).toBe("0:00");
    expect(formatSessionDuration(20)).toBe("1 min");
    expect(formatSessionDuration(3600)).toBe("1 h");
    expect(formatSessionDuration(3600 + 5 * 60)).toBe("1 h 05 min");
  });
});

describe("a card that the message alone describes", () => {
  it("is the quiet record, with the app, how it went and why, from the message", () => {
    const model = asEnded(
      build({
        live: undefined,
        session: carried({
          status: "ended",
          endReason: "host",
          summary: { participants: 4, durationSeconds: 1380, result: { winner: "bia" } },
        }),
      }),
    );
    expect(model.gone).toBe(false);
    expect(model.disabled).toBe(false);
    expect(model.app.name).toBe("Sala de jogos");
    expect(model.summary).toEqual({ participants: 4, durationSeconds: 1380, result: { winner: "bia" } });
    expect(model.starterName).toBe("bia");
  });

  it("is the switched-off card when the message says the app was turned off", () => {
    for (const endReason of ["app-disabled", "flag-off"] as const) {
      const model = asEnded(
        build({ live: undefined, session: carried({ status: "ended", endReason }) }),
      );
      expect(model.disabled).toBe(true);
    }
  });

  it("says it ended, without a number, when the message still says live and this tab has nothing running", () => {
    const model = asEnded(build({ live: undefined, session: carried({ status: "live" }) }));
    expect(model.gone).toBe(false);
    expect(model.summary).toBeNull();
    expect(model.disabled).toBe(false);
    expect(model.app.name).toBe("Sala de jogos");
  });

  it("prefers what this tab heard at the end over what the message said when it was read", () => {
    const model = asEnded(
      build({
        live: undefined,
        session: carried({ status: "live" }),
        ended: {
          sessionId: SESSION,
          channelId: "c",
          appId: null,
          startedAt: null,
          startedBy: null,
          hostUserId: null,
          endedAt: NOW,
          reason: "host",
          summary: { participants: 2, durationSeconds: 120 },
          participantIds: [BIA, LEO],
        },
      }),
    );
    expect(model.summary).toEqual({ participants: 2, durationSeconds: 120 });
    expect(model.people.map((one) => one.displayName)).toEqual(["bia", "leo"]);
  });

  it("is the generic card for a session retained away", () => {
    const model = asEnded(build({ live: undefined, session: null }));
    expect(model.gone).toBe(true);
  });
});
