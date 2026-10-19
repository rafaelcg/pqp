// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AppConfigEntry, AppSessionSummary } from "@pqp/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const config = vi.hoisted(() => ({
  state: {
    enabled: true,
    loaded: true,
    origin: "http://localhost:5175" as string | null,
    apps: [] as unknown[],
  },
}));
const api = vi.hoisted(() => ({ apiFetch: vi.fn() }));

vi.mock("@/hooks/use-apps-config", () => ({ useAppsConfig: () => config.state }));
vi.mock("@/lib/api", () => api);

import {
  applyChannelApp,
  registerAppJoinTransport,
  requestAppJoin,
  resetAppSessionsForTests,
  setAppsViewer,
} from "@/lib/apps/app-sessions-store";
import { resetAppConsentsForTests } from "@/lib/apps/consents";
import { AppJoinHost } from "./app-join-host";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ME = "00000000-0000-4000-8000-000000000001";
const BIA = "00000000-0000-4000-8000-000000000002";
const CHANNEL = "22222222-2222-4222-8222-222222222222";
const SESSION = "11111111-1111-4111-8111-111111111111";

const eco = {
  id: "pqp-eco",
  version: "1.0.0",
  category: "tool",
  icon: "gamepad",
  name: "name",
  description: "d",
  notice: "notice",
  presence: { phrase: "p", short: "s" },
  channelTypes: ["text", "voice"],
  players: { min: 1, max: 4, spectators: true, maxSpectators: 50 },
  capabilities: { identity: "display", share: "none", localFiles: { allowed: false }, peer: "none" },
  content: { userText: false, userImages: false },
  hostBound: false,
  i18n: {
    "pt-BR": { name: "Sala de jogos", notice: "Teu jogo fica no teu computador." },
    en: { name: "Game room", notice: "Your game stays on your computer." },
  },
  entry: { url: "http://localhost:5175/pqp-eco/1.0.0/index.html" },
  assets: [],
  available: true,
  reason: null,
  shareAllowed: true,
} as unknown as AppConfigEntry;

function summary(seated: boolean, players = 1): AppSessionSummary {
  const row = (userId: string) => ({
    userId,
    role: "player" as const,
    joinedAt: "2026-10-19T19:50:00Z",
    connection: "present" as const,
  });
  const rows = [row(BIA), ...(seated ? [row(ME)] : [])];
  return {
    id: SESSION,
    appId: "pqp-eco",
    appVersion: "1.0.0",
    startedBy: BIA,
    hostUserId: BIA,
    startedAt: "2026-10-19T19:50:00Z",
    participants: rows,
    players: Math.max(players, rows.length),
    spectators: 0,
    handoff: null,
  };
}

let root: Root | null = null;
let host: HTMLElement | null = null;
const sent: string[] = [];

function consentRow(over: Record<string, unknown> = {}) {
  return {
    appId: "pqp-eco",
    acceptedVersion: "1.0.0",
    identityGranted: false,
    consentedAt: "2026-10-19T19:00:00Z",
    identity: "display",
    names: { en: "Game room" },
    notices: {},
    stale: false,
    ...over,
  };
}

function serve(consents: unknown[]) {
  api.apiFetch.mockImplementation(async (path: string, init?: { method?: string }) => {
    if (path === "/api/me/app-consents") return { consents };
    if (path.endsWith("/consent") && init?.method === "POST") return { appId: "pqp-eco" };
    return {};
  });
}

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

async function mount() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <AppJoinHost
        serverId="srv"
        viewerId={ME}
        people={
          new Map([
            [ME, { displayName: "rafa" }],
            [BIA, { displayName: "bia" }],
          ])
        }
      />,
    );
  });
  await flush();
}

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const press = (pattern: RegExp) =>
  act(async () => {
    Array.from(document.querySelectorAll("button"))
      .find((b) => pattern.test(b.textContent ?? ""))!
      .click();
  });

beforeEach(() => {
  vi.useFakeTimers();
  resetAppSessionsForTests();
  resetAppConsentsForTests();
  api.apiFetch.mockReset();
  sent.length = 0;
  setAppsViewer(ME);
  registerAppJoinTransport({
    sendJoin: (sessionId, options) => {
      sent.push(`join:${sessionId}:${options.asSpectator ? "spectator" : "player"}`);
      return true;
    },
    sendLeave: (sessionId) => {
      sent.push(`leave:${sessionId}`);
      return true;
    },
  });
  config.state = { enabled: true, loaded: true, origin: "http://localhost:5175", apps: [eco] };
  applyChannelApp(CHANNEL, summary(false));
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
});

describe("AppJoinHost", () => {
  it("the first time Entrar opens the sheet and sends nothing", async () => {
    serve([]);
    await mount();
    act(() => requestAppJoin(SESSION));
    await flush();
    expect(dialog()?.textContent).toMatch(/Eco|Sala de jogos|Game room/);
    expect(sent).toEqual([]);
    expect(api.apiFetch).not.toHaveBeenCalledWith(
      expect.stringContaining("/consent"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("Entrar in the sheet records the consent first and only then asks for the seat", async () => {
    serve([]);
    await mount();
    act(() => requestAppJoin(SESSION));
    await flush();
    await press(/^(Entrar|Join)$/);
    await flush();
    const posts = api.apiFetch.mock.calls.filter(
      ([path, init]) => String(path).endsWith("/consent") && init?.method === "POST",
    );
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0]![1].body)).toEqual({ identityGranted: false });
    expect(sent).toEqual([`join:${SESSION}:player`]);
    // the sheet stays up until the summary says the seat is real
    expect(dialog()).not.toBeNull();
    act(() => applyChannelApp(CHANNEL, summary(true)));
    await flush();
    expect(dialog()).toBeNull();
  });

  it("a consent that could not be saved is a failure and no seat is asked for", async () => {
    api.apiFetch.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (path === "/api/me/app-consents") return { consents: [] };
      if (init?.method === "POST") throw new Error("offline");
      return {};
    });
    await mount();
    act(() => requestAppJoin(SESSION));
    await flush();
    await press(/^(Entrar|Join)$/);
    await flush();
    expect(dialog()?.querySelector('[role="alert"]')).not.toBeNull();
    expect(sent).toEqual([]);
  });

  it("after the first time Entrar goes straight in, and a toast says so with Desfazer", async () => {
    serve([consentRow()]);
    await mount();
    act(() => requestAppJoin(SESSION));
    await flush();
    expect(dialog()).toBeNull();
    expect(sent).toEqual([`join:${SESSION}:player`]);
    act(() => applyChannelApp(CHANNEL, summary(true)));
    await flush();
    const toast = document.querySelector('[data-testid="app-join-toast"]')!;
    expect(toast.textContent).toMatch(/Tu entrou|You joined|Entraste/);
    await press(/Desfazer|Undo|Deshacer/);
    expect(sent.at(-1)).toBe(`leave:${SESSION}`);
  });

  it("the toast goes away by itself after four seconds", async () => {
    serve([consentRow()]);
    await mount();
    act(() => requestAppJoin(SESSION));
    await flush();
    act(() => applyChannelApp(CHANNEL, summary(true)));
    await flush();
    expect(document.querySelector('[data-testid="app-join-toast"]')).not.toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(4_100);
    });
    // it leaves (the exit animation), then it is gone
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(document.querySelector('[data-testid="app-join-toast"]')).toBeNull();
  });

  it("a consent the app has outgrown (stale) shows the sheet again", async () => {
    serve([consentRow({ stale: true })]);
    await mount();
    act(() => requestAppJoin(SESSION));
    await flush();
    expect(dialog()).not.toBeNull();
    expect(sent).toEqual([]);
  });

  it("the session ending under the sheet turns it into the quiet ended state", async () => {
    serve([]);
    await mount();
    act(() => requestAppJoin(SESSION));
    await flush();
    act(() => applyChannelApp(CHANNEL, null));
    await flush();
    expect(dialog()?.textContent).toMatch(/já terminou|already ended|ya terminó/);
    expect(dialog()?.querySelector('[role="status"]')).not.toBeNull();
  });

  it("the room filling under the sheet turns it into Assistir", async () => {
    serve([]);
    await mount();
    act(() => requestAppJoin(SESSION));
    await flush();
    act(() => applyChannelApp(CHANNEL, summary(false, 4)));
    await flush();
    expect(dialog()?.textContent).toMatch(/encheu|filled|llenó/);
    await press(/Assistir|Watch|Mirar/);
    await flush();
    expect(sent).toEqual([`join:${SESSION}:spectator`]);
  });

  it("the app switched off under the sheet turns it into the quiet disabled state", async () => {
    serve([]);
    await mount();
    act(() => requestAppJoin(SESSION));
    await flush();
    config.state = { ...config.state, apps: [{ ...eco, available: false } as AppConfigEntry] };
    await act(async () => {
      root!.render(
        <AppJoinHost serverId="srv" viewerId={ME} people={new Map([[ME, { displayName: "rafa" }]])} />,
      );
    });
    expect(dialog()?.textContent).toMatch(/não está disponível|not available|no está disponible/);
  });

  it("with the flag off it registers nothing and reads nothing: Entrar is a plain join", async () => {
    config.state = { enabled: false, loaded: true, origin: null, apps: [] };
    serve([]);
    await mount();
    act(() => requestAppJoin(SESSION));
    await flush();
    expect(dialog()).toBeNull();
    expect(api.apiFetch).not.toHaveBeenCalled();
    expect(sent).toEqual([`join:${SESSION}:player`]);
  });
});
