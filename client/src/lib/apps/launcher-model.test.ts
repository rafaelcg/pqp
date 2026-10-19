import type { AppConfigEntry, AppSessionSummary } from "@pqp/shared";
import { describe, expect, it } from "vitest";
import {
  appTileReason,
  buildLauncherTiles,
  initialSelection,
  moveSelection,
  sizeOf,
} from "./launcher-model";

const BIA = "00000000-0000-4000-8000-0000000000b2";

function app(over: Partial<AppConfigEntry> & { id?: string } = {}): AppConfigEntry {
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

function live(appId: string): AppSessionSummary {
  return {
    id: "00000000-0000-4000-8000-0000000000d1",
    appId,
    appVersion: "1.0.0",
    startedBy: BIA,
    hostUserId: BIA,
    startedAt: "2026-10-19T10:00:00.000Z",
    participants: [],
    players: 0,
    spectators: 0,
    handoff: null,
  };
}

describe("how big an app says it is", () => {
  it("is a range of players for a game and of people for a tool, 'any size' from 32", () => {
    expect(sizeOf(app())).toEqual({ kind: "range", min: 1, max: 4, people: false });
    expect(sizeOf(app({ category: "tool", players: { min: 2, max: 8, spectators: false, maxSpectators: 0 } }))).toEqual(
      { kind: "range", min: 2, max: 8, people: true },
    );
    expect(sizeOf(app({ players: { min: 1, max: 1, spectators: false, maxSpectators: 0 } }))).toEqual({
      kind: "exact",
      count: 1,
      people: false,
    });
    expect(sizeOf(app({ players: { min: 1, max: 64, spectators: true, maxSpectators: 50 } }))).toEqual({
      kind: "any",
    });
  });
});

describe("why a tile is dimmed", () => {
  it("names the channel type first, then the server's gate", () => {
    const voiceOnly = app({ channelTypes: ["voice"] });
    expect(appTileReason(voiceOnly, "text")).toBe("voice-only");
    expect(appTileReason(voiceOnly, "voice")).toBeNull();
    expect(appTileReason(app({ channelTypes: ["text"] }), "voice")).toBe("text-only");
    expect(appTileReason(app({ available: false, reason: "owner-off" }), "text")).toBe("off-here");
    expect(appTileReason(app({ available: false, reason: "not-allowed-here" }), "text")).toBe("off-here");
    expect(appTileReason(app({ available: false, reason: "community-locked" }), "text")).toBe("community");
    expect(appTileReason(app({ available: false, reason: "no-origin" }), "text")).toBe("unavailable");
    // The channel decides before the server does: the person is in a text channel.
    expect(
      appTileReason(app({ channelTypes: ["voice"], available: false, reason: "owner-off" }), "text"),
    ).toBe("voice-only");
  });
});

describe("the tiles", () => {
  const base = {
    apps: [app(), app({ id: "pqp-voz", channelTypes: ["voice"] })],
    channelType: "text" as const,
    locale: "pt-BR",
    inCallHere: false,
    watchPartyAvailable: false,
  };

  it("lists the apps, then Música as a shortcut that only works in a voice call", () => {
    const tiles = buildLauncherTiles(base);
    expect(tiles.map((tile) => tile.id)).toEqual(["pqp-eco", "pqp-voz", "music"]);
    expect(tiles[0]).toMatchObject({ name: "Sala de jogos", reason: null, running: false });
    expect(tiles[1]).toMatchObject({ reason: "voice-only" });
    expect(tiles[2]).toMatchObject({ kind: "builtin", reason: "voice-only" });

    const inVoice = buildLauncherTiles({ ...base, channelType: "voice", inCallHere: false });
    expect(inVoice[2]).toMatchObject({ reason: "join-call" });
    const inCall = buildLauncherTiles({ ...base, channelType: "voice", inCallHere: true });
    expect(inCall[2]).toMatchObject({ reason: null });
  });

  it("adds the watch party shortcut only where there is one to open or make", () => {
    expect(buildLauncherTiles({ ...base, watchPartyAvailable: true }).map((tile) => tile.id)).toEqual([
      "pqp-eco",
      "pqp-voz",
      "music",
      "watch-party",
    ]);
  });

  it("marks the app that is already running here", () => {
    const tiles = buildLauncherTiles({ ...base, live: live("pqp-eco") });
    expect(tiles[0]).toMatchObject({ running: true });
    expect(tiles[1]).toMatchObject({ running: false });
  });
});

describe("what starts selected", () => {
  it("is the running app, else the first that can start, else the first", () => {
    const apps = [
      app({ id: "a-off", available: false, reason: "owner-off" }),
      app({ id: "b-ok" }),
      app({ id: "c-ok" }),
    ];
    const input = { apps, channelType: "text" as const, locale: "pt-BR", inCallHere: false, watchPartyAvailable: false };
    expect(initialSelection(buildLauncherTiles(input))).toBe("b-ok");
    expect(initialSelection(buildLauncherTiles({ ...input, live: live("c-ok") }))).toBe("c-ok");
    const allOff = buildLauncherTiles({
      ...input,
      apps: [app({ id: "a-off", available: false, reason: "owner-off" })],
    });
    // Música is dimmed in a text channel too: the first tile of the list.
    expect(initialSelection(allOff)).toBe("a-off");
    expect(initialSelection([])).toBeNull();
  });
});

describe("arrow keys over the grid", () => {
  it("moves a column or a row, stops at the edges, jumps to the ends", () => {
    expect(moveSelection(0, 5, "ArrowRight", 3)).toBe(1);
    expect(moveSelection(2, 5, "ArrowRight", 3)).toBe(3);
    expect(moveSelection(4, 5, "ArrowRight", 3)).toBe(4);
    expect(moveSelection(0, 5, "ArrowLeft", 3)).toBe(0);
    expect(moveSelection(1, 5, "ArrowDown", 3)).toBe(4);
    expect(moveSelection(3, 5, "ArrowDown", 3)).toBe(4);
    expect(moveSelection(4, 5, "ArrowUp", 3)).toBe(1);
    expect(moveSelection(2, 5, "Home", 3)).toBe(0);
    expect(moveSelection(2, 5, "End", 3)).toBe(4);
    expect(moveSelection(2, 5, "x", 3)).toBe(2);
    expect(moveSelection(0, 0, "ArrowRight", 3)).toBe(-1);
    // One column on a phone: down is the next row.
    expect(moveSelection(1, 4, "ArrowDown", 1)).toBe(2);
  });
});
