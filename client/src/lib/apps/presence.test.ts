import type { AppConfigEntry, AppSessionSummary, AppsConfig } from "@pqp/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadAppsConfig, resetAppsConfigForTests } from "@/hooks/use-apps-config";
import {
  applyCatchUp,
  getAppSessionsSnapshot,
  resetAppSessionsForTests,
} from "@/lib/apps/app-sessions-store";
import { appPresenceLine, appPresenceOf, presenceTemplate } from "./presence";

const api = vi.hoisted(() => ({ fetchAppsConfig: vi.fn() }));
vi.mock("@/lib/apps/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/apps/api")>();
  return { ...real, fetchAppsConfig: api.fetchAppsConfig };
});

const SERVER = "00000000-0000-4000-8000-0000000000a1";
const OTHER_SERVER = "00000000-0000-4000-8000-0000000000a2";
const CH1 = "00000000-0000-4000-8000-0000000000c1";
const CH2 = "00000000-0000-4000-8000-0000000000c2";
const RAF = "00000000-0000-4000-8000-0000000000b1";
const BIA = "00000000-0000-4000-8000-0000000000b2";
const S1 = "00000000-0000-4000-8000-0000000000d1";
const S2 = "00000000-0000-4000-8000-0000000000d2";

function locadora(): AppConfigEntry {
  return {
    id: "pqp-locadora",
    version: "1.0.0",
    category: "emulator",
    icon: "gamepad",
    name: "name",
    description: "description",
    channelTypes: ["text", "voice"],
    players: { min: 1, max: 4, spectators: false, maxSpectators: 0 },
    capabilities: {
      identity: "display",
      share: "none",
      localFiles: { allowed: false },
      peer: "none",
    },
    content: { userText: false, userImages: false },
    hostBound: false,
    i18n: {
      "pt-BR": { name: "Locadora", "presence.phrase": "{name} tá na Locadora", "presence.short": "Na Locadora" },
      en: { name: "Locadora", "presence.phrase": "{name} is in Locadora", "presence.short": "In Locadora" },
      es: { name: "Locadora", "presence.phrase": "{name} está en Locadora", "presence.short": "En Locadora" },
    },
    entry: { url: null },
    assets: [],
    sandbox: {},
    presence: { phrase: "presence.phrase", short: "presence.short" },
    available: true,
    reason: null,
    shareAllowed: true,
  } as unknown as AppConfigEntry;
}

function session(id: string, userIds: string[], joinedAt = "2026-10-19T10:00:00.000Z"): AppSessionSummary {
  return {
    id,
    appId: "pqp-locadora",
    appVersion: "1.0.0",
    startedBy: userIds[0] ?? null,
    hostUserId: userIds[0] ?? null,
    startedAt: "2026-10-19T09:59:00.000Z",
    participants: userIds.map((userId) => ({
      userId,
      role: "player" as const,
      joinedAt,
      connection: "present" as const,
    })),
    players: userIds.length,
    spectators: 0,
    handoff: null,
  };
}

async function load(serverId: string, apps: AppConfigEntry[]) {
  api.fetchAppsConfig.mockResolvedValueOnce({
    enabled: true,
    origin: "http://localhost:5175",
    apps,
  } satisfies AppsConfig);
  await loadAppsConfig(serverId);
}

beforeEach(() => {
  resetAppSessionsForTests();
  resetAppsConfigForTests();
  api.fetchAppsConfig.mockReset();
});

describe("who is in which app", () => {
  it("finds the session a person is seated in, and nothing for everybody else", () => {
    applyCatchUp(SERVER, [CH1], [{ channelId: CH1, session: session(S1, [RAF]) }], 0);
    const state = getAppSessionsSnapshot();
    expect(appPresenceOf(state, RAF)).toMatchObject({ appId: "pqp-locadora", channelId: CH1, sessionId: S1 });
    expect(appPresenceOf(state, BIA)).toBeNull();
  });

  it("takes the session joined last when two list the same person", () => {
    applyCatchUp(SERVER, [CH1, CH2], [
      { channelId: CH1, session: session(S1, [RAF], "2026-10-19T10:00:00.000Z") },
      { channelId: CH2, session: session(S2, [RAF], "2026-10-19T10:05:00.000Z") },
    ], 0);
    expect(appPresenceOf(getAppSessionsSnapshot(), RAF)?.sessionId).toBe(S2);
  });

  it("a server's list counts only that server's channels", () => {
    applyCatchUp(SERVER, [CH1], [{ channelId: CH1, session: session(S1, [RAF]) }], 0);
    applyCatchUp(OTHER_SERVER, [CH2], [{ channelId: CH2, session: session(S2, [BIA]) }], 0);
    const state = getAppSessionsSnapshot();
    expect(appPresenceOf(state, BIA, SERVER)).toBeNull();
    expect(appPresenceOf(state, BIA, OTHER_SERVER)).not.toBeNull();
    expect(appPresenceOf(state, BIA)).not.toBeNull();
  });
});

describe("the line", () => {
  it("is the short label under a name, and the sentence where it stands alone", async () => {
    await load(SERVER, [locadora()]);
    applyCatchUp(SERVER, [CH1], [{ channelId: CH1, session: session(S1, [RAF]) }], 0);
    const state = getAppSessionsSnapshot();
    expect(appPresenceLine(state, RAF, "Raf", "short", "pt-BR", SERVER)).toBe("Na Locadora");
    expect(appPresenceLine(state, RAF, "Raf", "phrase", "pt-BR", SERVER)).toBe("Raf tá na Locadora");
  });

  it("reads in the viewer's language, English when the app lacks it", async () => {
    await load(SERVER, [locadora()]);
    applyCatchUp(SERVER, [CH1], [{ channelId: CH1, session: session(S1, [RAF]) }], 0);
    const state = getAppSessionsSnapshot();
    expect(appPresenceLine(state, RAF, "Raf", "phrase", "en", SERVER)).toBe("Raf is in Locadora");
    expect(appPresenceLine(state, RAF, "Raf", "phrase", "es-MX", SERVER)).toBe("Raf está en Locadora");
    expect(appPresenceLine(state, RAF, "Raf", "phrase", "de", SERVER)).toBe("Raf is in Locadora");
    const noEs = { ...locadora(), i18n: { ...locadora().i18n, es: {} } } as AppConfigEntry;
    expect(presenceTemplate(noEs, "es", "short")).toBe("In Locadora");
  });

  it("puts a name in as typed: $& stays literal, {name} is not expanded again, control and bidi characters go", async () => {
    await load(SERVER, [locadora()]);
    applyCatchUp(SERVER, [CH1], [{ channelId: CH1, session: session(S1, [RAF]) }], 0);
    const state = getAppSessionsSnapshot();
    expect(appPresenceLine(state, RAF, "a$&b", "phrase", "pt-BR", SERVER)).toBe("a$&b tá na Locadora");
    expect(appPresenceLine(state, RAF, "$1 $` $'", "phrase", "pt-BR", SERVER)).toBe("$1 $` $' tá na Locadora");
    expect(appPresenceLine(state, RAF, "{name}", "phrase", "pt-BR", SERVER)).toBe("{name} tá na Locadora");
    expect(appPresenceLine(state, RAF, "x‮y\u0007z", "phrase", "pt-BR", SERVER)).toBe("xyz tá na Locadora");
    expect(appPresenceLine(state, RAF, "   ", "phrase", "pt-BR", SERVER)).toBe("? tá na Locadora");
    // The short label never takes a name at all.
    expect(appPresenceLine(state, RAF, "$&", "short", "pt-BR", SERVER)).toBe("Na Locadora");
  });

  it("is no line when the app is not in the list this tab holds", async () => {
    applyCatchUp(SERVER, [CH1], [{ channelId: CH1, session: session(S1, [RAF]) }], 0);
    // The config has not landed: a line that cannot be written well is no line.
    expect(appPresenceLine(getAppSessionsSnapshot(), RAF, "Raf", "short", "pt-BR", SERVER)).toBeNull();
    await load(SERVER, []);
    expect(appPresenceLine(getAppSessionsSnapshot(), RAF, "Raf", "short", "pt-BR", SERVER)).toBeNull();
  });

  it("goes away when the person leaves or the session ends", async () => {
    await load(SERVER, [locadora()]);
    applyCatchUp(SERVER, [CH1], [{ channelId: CH1, session: session(S1, [RAF, BIA]) }], 0);
    applyCatchUp(SERVER, [CH1], [{ channelId: CH1, session: session(S1, [BIA]) }], 0);
    expect(appPresenceLine(getAppSessionsSnapshot(), RAF, "Raf", "short", "pt-BR", SERVER)).toBeNull();
    expect(appPresenceLine(getAppSessionsSnapshot(), BIA, "Bia", "short", "pt-BR", SERVER)).toBe("Na Locadora");
    applyCatchUp(SERVER, [CH1], [], 0);
    expect(appPresenceLine(getAppSessionsSnapshot(), BIA, "Bia", "short", "pt-BR", SERVER)).toBeNull();
  });
});
