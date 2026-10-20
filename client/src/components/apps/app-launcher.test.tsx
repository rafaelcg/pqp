// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AppConfigEntry, AppSessionSummary, AppsConfig } from "@pqp/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { resetAppsConfigForTests } from "@/hooks/use-apps-config";
import { AppStartError } from "@/lib/apps/api";
import {
  applyChannelApp,
  registerAppJoinInterceptor,
  resetAppSessionsForTests,
  setAppsOnline,
} from "@/lib/apps/app-sessions-store";
import {
  AppLauncher,
  APP_START_TIMEOUT_MS,
  resetAppStartsForTests,
  type AppLauncherProps,
} from "./app-launcher";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  fetchAppsConfig: vi.fn(),
  startAppSessionRequest: vi.fn(),
}));
vi.mock("@/lib/apps/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/apps/api")>();
  return {
    ...real,
    fetchAppsConfig: api.fetchAppsConfig,
    startAppSessionRequest: api.startAppSessionRequest,
  };
});

const SERVER = "00000000-0000-4000-8000-0000000000a1";
const CHANNEL = "00000000-0000-4000-8000-0000000000c1";
const ME = "00000000-0000-4000-8000-0000000000b1";
const BIA = "00000000-0000-4000-8000-0000000000b2";
const SESSION = "00000000-0000-4000-8000-0000000000d1";

function entry(over: Partial<AppConfigEntry> = {}): AppConfigEntry {
  return {
    id: "pqp-eco",
    version: "1.0.0",
    category: "game",
    icon: "gamepad",
    name: "name",
    description: "description",
    notice: "notice",
    channelTypes: ["text", "voice"],
    players: { min: 1, max: 4, spectators: true, maxSpectators: 50 },
    requires: { start: "USE_APPS", join: "VIEW_CHANNEL" },
    capabilities: {
      identity: "display",
      share: "pane",
      localFiles: { allowed: false },
      peer: "none",
    },
    content: { userText: false, userImages: false },
    hostBound: false,
    i18n: {
      "pt-BR": {},
      en: {
        name: "Game room",
        description: "Classic console games in the browser.",
        notice: "Your game stays on your computer.",
      },
      es: {},
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

function config(apps: AppConfigEntry[], enabled = true): AppsConfig {
  return { enabled, origin: "http://localhost:5175", apps };
}

function summary(over: Partial<AppSessionSummary> = {}): AppSessionSummary {
  return {
    id: SESSION,
    appId: "pqp-eco",
    appVersion: "1.0.0",
    startedBy: BIA,
    hostUserId: BIA,
    startedAt: "2026-10-19T10:00:00.000Z",
    participants: [],
    players: 0,
    spectators: 0,
    handoff: null,
    ...over,
  };
}

let root: Root | null = null;
let host: HTMLElement | null = null;

function stubMedia(desktop: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: query.includes("min-width") ? desktop : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

async function mount(
  apps: AppConfigEntry[] | null,
  props: Partial<AppLauncherProps> = {},
  enabled = true,
) {
  api.fetchAppsConfig.mockResolvedValue(config(apps ?? [], enabled));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <TooltipProvider>
        <form>
          <AppLauncher
            serverId={SERVER}
            channelId={CHANNEL}
            channelName="geral"
            channelType="text"
            viewerId={ME}
            canStart
            canManageServer={false}
            {...props}
          />
        </form>
      </TooltipProvider>,
    );
  });
  await flush();
}

const button = () => host!.querySelector<HTMLButtonElement>('[data-testid="apps-button"]');
const panel = () => host!.querySelector<HTMLElement>('[data-testid="apps-launcher"]');
const tiles = () => Array.from(host!.querySelectorAll<HTMLElement>('[role="option"]'));
const footerButton = () => panel()!.querySelector<HTMLButtonElement>("footer button")!;

async function openPanel() {
  await act(async () => {
    button()!.click();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  stubMedia(true);
  resetAppsConfigForTests();
  resetAppSessionsForTests();
  resetAppStartsForTests();
  api.fetchAppsConfig.mockReset();
  api.startAppSessionRequest.mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
});

describe("who sees the button", () => {
  it("nobody, while the platform is off for the server", async () => {
    await mount([entry()], {}, false);
    expect(button()).toBeNull();
  });

  it("everybody once apps are released: an app running here turns it into Entrar for them", async () => {
    await mount([entry()], { canStart: false });
    expect(button()).not.toBeNull();
    expect(button()!.getAttribute("aria-label")).toBe("Apps");
    expect(button()!.getAttribute("aria-haspopup")).toBe("dialog");
  });

  it("only the person who runs the server, when nothing is released, and only for the empty panel", async () => {
    await mount([], { canManageServer: false });
    expect(button()).toBeNull();
    act(() => root!.unmount());
    host!.remove();
    resetAppsConfigForTests();

    const onRequestAccess = vi.fn();
    await mount([], { canManageServer: true, onRequestAccess });
    await openPanel();
    expect(host!.querySelector('[data-testid="apps-empty"]')!.textContent).toContain(
      "No apps here yet",
    );
    const ask = Array.from(panel()!.querySelectorAll("button")).find(
      (one) => one.textContent === "Ask for access",
    )!;
    await act(async () => ask.click());
    expect(onRequestAccess).toHaveBeenCalledTimes(1);
  });
});

describe("estado 1: aberto, tudo disponivel", () => {
  it("opens as a dialog with the first usable app selected and focus on its tile", async () => {
    await mount([entry()], { builtIns: { music: { inCallHere: false, open: () => {} } } });
    await openPanel();
    const dialog = panel()!;
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.getAttribute("aria-modal")).toBeNull();
    expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
    expect(button()!.getAttribute("aria-expanded")).toBe("true");
    const [eco, music] = tiles();
    expect(eco!.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(eco);
    expect(host!.querySelector('[data-testid="apps-detail"]')!.textContent).toContain(
      "Classic console games in the browser.",
    );
    expect(host!.textContent).toContain("Your game stays on your computer.");
    expect(host!.textContent).toContain("Can share the screen");
    expect(music!.getAttribute("aria-selected")).toBe("false");
  });

  it("dims Música with its reason written, and keeps it reachable", async () => {
    await mount([entry()], { builtIns: { music: { inCallHere: false, open: () => {} } } });
    await openPanel();
    const music = tiles().find((tile) => tile.dataset.tile === "music")!;
    expect(music.getAttribute("aria-disabled")).toBe("true");
    expect(music.textContent).toContain("Voice channels only");
    expect(music.tabIndex).toBe(-1);
  });

  it("keeps one tab stop in the list and moves the selection with the arrows", async () => {
    await mount([entry()], { builtIns: { music: { inCallHere: false, open: () => {} } } });
    await openPanel();
    expect(tiles().filter((tile) => tile.tabIndex === 0)).toHaveLength(1);
    await act(async () => {
      tiles()[0]!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
      );
    });
    expect(tiles()[1]!.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tiles()[1]);
    expect(tiles().filter((tile) => tile.tabIndex === 0)).toHaveLength(1);
  });

  it("Escape closes it and gives focus back to the button", async () => {
    await mount([entry()]);
    await openPanel();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(button());
  });

  it("Enter on a tile moves to the Começar button, it does not start", async () => {
    await mount([entry()]);
    await openPanel();
    await act(async () => {
      tiles()[0]!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });
    expect(document.activeElement).toBe(footerButton());
    expect(api.startAppSessionRequest).not.toHaveBeenCalled();
  });
});

describe("estados 4 e 5: comecando e falhou", () => {
  it("starts, locks the button with aria-busy, closes on success and joins the new session", async () => {
    let resolve!: (value: AppSessionSummary) => void;
    api.startAppSessionRequest.mockReturnValue(
      new Promise<AppSessionSummary>((done) => {
        resolve = done;
      }),
    );
    const joined: string[] = [];
    registerAppJoinInterceptor((id) => joined.push(id));
    await mount([entry()]);
    await openPanel();
    await act(async () => footerButton().click());
    expect(api.startAppSessionRequest).toHaveBeenCalledWith(CHANNEL, "pqp-eco");
    expect(footerButton().getAttribute("aria-busy")).toBe("true");
    expect(footerButton().getAttribute("aria-disabled")).toBe("true");
    expect(footerButton().textContent).toBe("Starting");
    // The panel does not close by itself while it waits, not even on Escape's cousin: outside.
    await act(async () => {
      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(panel()).not.toBeNull();
    // A second press sends nothing.
    await act(async () => footerButton().click());
    expect(api.startAppSessionRequest).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolve(summary());
    });
    expect(panel()).toBeNull();
    expect(joined).toEqual([SESSION]);
  });

  it("reads a failure inside the panel as an alert and puts focus on Tentar de novo", async () => {
    api.startAppSessionRequest.mockRejectedValueOnce(new AppStartError(500, null, null, null));
    await mount([entry()]);
    await openPanel();
    await act(async () => footerButton().click());
    await flush();
    const alerts = panel()!.querySelectorAll('[role="alert"]');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.textContent).toBe("Could not start. Try again in a moment.");
    expect(footerButton().textContent).toBe("Try again");
    expect(document.activeElement).toBe(footerButton());

    api.startAppSessionRequest.mockResolvedValueOnce(summary());
    await act(async () => footerButton().click());
    await flush();
    expect(panel()).toBeNull();
  });

  it("an answer that never comes is a failure after eight seconds", async () => {
    api.startAppSessionRequest.mockReturnValue(new Promise(() => {}));
    await mount([entry()]);
    await openPanel();
    await act(async () => footerButton().click());
    await act(async () => {
      vi.advanceTimersByTime(APP_START_TIMEOUT_MS + 1);
    });
    expect(panel()!.querySelector('[role="alert"]')).not.toBeNull();
    expect(footerButton().textContent).toBe("Try again");
  });

  it("Tentar de novo after the eight seconds waits for the same request instead of sending another", async () => {
    let resolve!: (value: AppSessionSummary) => void;
    api.startAppSessionRequest.mockReturnValue(
      new Promise<AppSessionSummary>((done) => {
        resolve = done;
      }),
    );
    const joined: string[] = [];
    registerAppJoinInterceptor((id) => joined.push(id));
    await mount([entry()]);
    await openPanel();
    await act(async () => footerButton().click());
    await act(async () => {
      vi.advanceTimersByTime(APP_START_TIMEOUT_MS + 1);
    });
    expect(footerButton().textContent).toBe("Try again");

    await act(async () => footerButton().click());
    await act(async () => footerButton().click());
    expect(api.startAppSessionRequest).toHaveBeenCalledTimes(1);
    expect(footerButton().textContent).toBe("Starting");

    // The first request answers late: it is the one that is used, and joined.
    await act(async () => {
      resolve(summary());
    });
    expect(api.startAppSessionRequest).toHaveBeenCalledTimes(1);
    expect(panel()).toBeNull();
    expect(joined).toEqual([SESSION]);
  });

  it("a request that answers after the panel is closed is still adopted and joined, and a new panel sends no second one", async () => {
    let resolve!: (value: AppSessionSummary) => void;
    api.startAppSessionRequest.mockReturnValue(
      new Promise<AppSessionSummary>((done) => {
        resolve = done;
      }),
    );
    const joined: string[] = [];
    registerAppJoinInterceptor((id) => joined.push(id));
    await mount([entry()]);
    await openPanel();
    await act(async () => footerButton().click());
    await act(async () => {
      vi.advanceTimersByTime(APP_START_TIMEOUT_MS + 1);
    });
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(panel()).toBeNull();

    await openPanel();
    await act(async () => footerButton().click());
    expect(api.startAppSessionRequest).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolve(summary());
    });
    expect(joined).toEqual([SESSION]);
    expect(panel()).toBeNull();
  });

  it("a pending start of one app is never taken for another: pressing Começar on B shows A still starting", async () => {
    api.startAppSessionRequest.mockReturnValue(new Promise(() => {}));
    await mount([entry(), entry({ id: "pqp-other", name: "name" })]);
    await openPanel();
    const firstIndex = tiles().findIndex((tile) => tile.getAttribute("aria-selected") === "true");
    const otherIndex = firstIndex === 0 ? 1 : 0;
    await act(async () => footerButton().click());
    await act(async () => {
      vi.advanceTimersByTime(APP_START_TIMEOUT_MS + 1);
    });
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await openPanel();
    await act(async () => tiles()[otherIndex]!.click());
    expect(tiles()[otherIndex]!.getAttribute("aria-selected")).toBe("true");
    await act(async () => footerButton().click());

    expect(api.startAppSessionRequest).toHaveBeenCalledTimes(1);
    expect(tiles()[firstIndex]!.getAttribute("aria-selected")).toBe("true");
    expect(tiles()[otherIndex]!.getAttribute("aria-selected")).toBe("false");
    expect(footerButton().textContent).toBe("Starting");
  });

  it("someone else got there first: the panel turns into 'already running' instead of failing", async () => {
    api.startAppSessionRequest.mockRejectedValueOnce(
      new AppStartError(409, "session_live", summary({ participants: [], players: 0 }), null),
    );
    await mount([entry()]);
    await openPanel();
    await act(async () => footerButton().click());
    await flush();
    expect(panel()!.querySelector('[role="alert"]')).toBeNull();
    expect(panel()!.textContent).toContain("One app per channel");
    expect(footerButton().textContent).toBe("Join");
  });
});

describe("estado 3: sem permissao", () => {
  it("shows the tiles, writes the reason above a disabled button and sends nothing", async () => {
    await mount([entry()], { canStart: false });
    await openPanel();
    expect(tiles()).not.toHaveLength(0);
    expect(panel()!.textContent).toContain("You cannot start apps in this channel.");
    expect(footerButton().getAttribute("aria-disabled")).toBe("true");
    await act(async () => footerButton().click());
    expect(api.startAppSessionRequest).not.toHaveBeenCalled();
  });

  it("a refusal from the server reads the same way", async () => {
    api.startAppSessionRequest.mockRejectedValueOnce(new AppStartError(403, "cannot_start", null, null));
    await mount([entry()]);
    await openPanel();
    await act(async () => footerButton().click());
    await flush();
    expect(panel()!.textContent).toContain("You cannot start apps in this channel.");
    expect(panel()!.querySelector('[role="alert"]')).toBeNull();
  });
});

describe("an app that asks MANAGE_CHANNELS to start (requires.start)", () => {
  const strict = () => entry({ requires: { start: "MANAGE_CHANNELS", join: "VIEW_CHANNEL" } });

  it("is dimmed with its reason, and Começar sends nothing, for somebody who cannot manage channels", async () => {
    await mount([strict()], { canManageChannels: false });
    await openPanel();
    const tile = tiles()[0]!;
    expect(tile.getAttribute("aria-disabled")).toBe("true");
    expect(tile.textContent).toContain("Only people who manage channels can start it");
    expect(footerButton().getAttribute("aria-disabled")).toBe("true");
    await act(async () => footerButton().click());
    expect(api.startAppSessionRequest).not.toHaveBeenCalled();
  });

  it("starts as usual for somebody who can", async () => {
    api.startAppSessionRequest.mockResolvedValueOnce(summary());
    await mount([strict()], { canManageChannels: true });
    await openPanel();
    expect(tiles()[0]!.getAttribute("aria-disabled")).toBeNull();
    await act(async () => footerButton().click());
    await flush();
    expect(api.startAppSessionRequest).toHaveBeenCalledTimes(1);
  });
});

describe("estado 2: ja tem um app rolando", () => {
  it("selects the running app, says who started it and turns the button into Entrar", async () => {
    const people = new Map([[BIA, { displayName: "bia", avatarUrl: null }]]);
    const joined: string[] = [];
    registerAppJoinInterceptor((id) => joined.push(id));
    await mount([entry()], { people });
    applyChannelApp(
      CHANNEL,
      summary({
        participants: [
          { userId: BIA, role: "player", joinedAt: "2026-10-19T10:00:00.000Z", connection: "present" },
        ],
        players: 1,
      }),
    );
    await openPanel();
    expect(tiles()[0]!.getAttribute("aria-selected")).toBe("true");
    expect(tiles()[0]!.textContent).toContain("Running here");
    const detail = panel()!.querySelector('[data-testid="apps-detail"]')!.textContent;
    expect(detail).toContain("started by bia");
    expect(detail).toContain("1 in, room for 4");
    expect(panel()!.textContent).toContain("One app per channel. To start another, end the one that is running.");
    expect(footerButton().textContent).toBe("Join");
    await act(async () => footerButton().click());
    expect(joined).toEqual([SESSION]);
    expect(panel()).toBeNull();
  });

  it("another tile can not start while one runs", async () => {
    await mount(
      [entry(), entry({ id: "pqp-quadro", i18n: { "pt-BR": {}, en: { name: "Board" }, es: {} } })],
    );
    applyChannelApp(CHANNEL, summary());
    await openPanel();
    await act(async () => tiles()[1]!.click());
    expect(footerButton().getAttribute("aria-disabled")).toBe("true");
    await act(async () => footerButton().click());
    expect(api.startAppSessionRequest).not.toHaveBeenCalled();
  });
});

describe("estado 7: sem conexao", () => {
  it("says so instead of drawing tiles that cannot work", async () => {
    await mount([entry()]);
    await act(async () => setAppsOnline(false));
    await openPanel();
    expect(host!.querySelector('[data-testid="apps-offline"]')!.textContent).toContain("No connection");
    expect(tiles()).toHaveLength(0);
  });
});

describe("shortcuts", () => {
  it("Música opens the queue when the person is in this call, and closes the panel", async () => {
    const open = vi.fn();
    await mount([entry()], {
      channelType: "voice",
      builtIns: { music: { inCallHere: true, open } },
    });
    await openPanel();
    const music = tiles().find((tile) => tile.dataset.tile === "music")!;
    await act(async () => music.click());
    expect(music.getAttribute("aria-disabled")).toBeNull();
    await act(async () => footerButton().click());
    expect(open).toHaveBeenCalledTimes(1);
    expect(panel()).toBeNull();
  });

  it("Música does nothing from a text channel, and the watch party opens or creates", async () => {
    const open = vi.fn();
    const run = vi.fn();
    await mount([entry()], {
      builtIns: {
        music: { inCallHere: false, open },
        watchParty: { label: "create", run },
      },
    });
    await openPanel();
    const music = tiles().find((tile) => tile.dataset.tile === "music")!;
    await act(async () => music.click());
    await act(async () => footerButton().click());
    expect(open).not.toHaveBeenCalled();

    const party = tiles().find((tile) => tile.dataset.tile === "watch-party")!;
    await act(async () => party.click());
    expect(footerButton().textContent).toBe("Create the channel");
    await act(async () => footerButton().click());
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("a phone gets a sheet", () => {
  it("is modal, one tile per row, with a scrim, and Tab stays inside it", async () => {
    stubMedia(false);
    await mount([entry()]);
    await openPanel();
    expect(panel()!.getAttribute("aria-modal")).toBe("true");
    expect(host!.querySelector(".app-scrim")).not.toBeNull();
    const focusable = Array.from(
      panel()!.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex="0"]'),
    );
    const last = focusable[focusable.length - 1]!;
    last.focus();
    const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    await act(async () => {
      last.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(focusable[0]);
  });
});
