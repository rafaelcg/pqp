// @vitest-environment jsdom
import { act, forwardRef, useImperativeHandle } from "react";
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

vi.mock("@/hooks/use-apps-config", () => ({ useAppsConfig: () => config.state }));
vi.mock("@/hooks/use-md-up", () => ({ useMdUp: () => true }));
vi.mock("@/lib/apps/api", () => ({ endAppSessionRequest: vi.fn(async () => true) }));
vi.mock("@/components/apps/app-pane", () => ({
  AppPane: forwardRef<{ focus(): void; element(): HTMLElement | null }, { title: string; frozen?: boolean }>(
    function FakePane(props, ref) {
      useImperativeHandle(ref, () => ({ focus: () => {}, element: () => null }), []);
      return <div data-testid="pane" data-frozen={props.frozen ? "yes" : "no"} />;
    },
  ),
}));

import {
  applyAppEnded,
  applyChannelApp,
  resetAppSessionsForTests,
  setAppsOnline,
  setAppsViewer,
} from "@/lib/apps/app-sessions-store";
import { AppSessionLayout, ENDED_STRIP_MS } from "./app-session-layout";

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
  presence: { phrase: "p", short: "s" },
  channelTypes: ["text", "voice"],
  players: { min: 1, max: 4, spectators: true, maxSpectators: 50 },
  capabilities: { identity: "display", share: "none", localFiles: { allowed: false }, peer: "none" },
  content: { userText: false, userImages: false },
  hostBound: false,
  i18n: { "pt-BR": { name: "Sala de jogos" }, en: { name: "Game room" } },
  entry: { url: "http://localhost:5175/pqp-eco/1.0.0/index.html" },
  assets: [],
  available: true,
  reason: null,
  shareAllowed: true,
} as unknown as AppConfigEntry;

function summary(seated: boolean): AppSessionSummary {
  const row = (userId: string) => ({
    userId,
    role: "player" as const,
    joinedAt: "2026-10-19T19:50:00Z",
    connection: "present" as const,
  });
  return {
    id: SESSION,
    appId: "pqp-eco",
    appVersion: "1.0.0",
    startedBy: BIA,
    hostUserId: BIA,
    startedAt: "2026-10-19T19:50:00Z",
    participants: seated ? [row(BIA), row(ME)] : [row(BIA)],
    players: seated ? 2 : 1,
    spectators: 0,
    handoff: null,
  };
}

let root: Root | null = null;
let host: HTMLElement | null = null;

const voice = {
  inCall: false,
  sharing: false,
  others: 0,
  startShare: vi.fn(async () => true),
  stopShare: vi.fn(),
};

function render(props: { enabled?: boolean; channelId?: string | null } = {}) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <AppSessionLayout
        serverId="srv"
        channelId={props.channelId === undefined ? CHANNEL : props.channelId}
        channelType="text"
        viewerId={ME}
        canModerate={false}
        people={
          new Map([
            [ME, { displayName: "rafa" }],
            [BIA, { displayName: "bia" }],
          ])
        }
        voice={voice}
      >
        <div data-testid="chat">chat</div>
      </AppSessionLayout>,
    ),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  resetAppSessionsForTests();
  setAppsViewer(ME);
  config.state = { enabled: true, loaded: true, origin: "http://localhost:5175", apps: [eco] };
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
});

const strip = () => document.querySelector('[data-testid="app-session-strip"]');
const column = () => document.querySelector<HTMLElement>('[data-testid="app-chat-column"]')!;

describe("AppSessionLayout", () => {
  it("with the flag off it is only its children: no strip, no pane", () => {
    config.state = { ...config.state, enabled: false, apps: [] };
    applyChannelApp(CHANNEL, summary(true));
    render();
    expect(strip()).toBeNull();
    expect(document.querySelector('[data-testid="pane"]')).toBeNull();
    expect(document.querySelector('[data-testid="chat"]')).not.toBeNull();
  });

  it("with no session there is nothing to draw but the chat, in the same place", () => {
    render();
    expect(strip()).toBeNull();
    expect(column().className).toMatch(/flex-1/);
    expect(column().className).not.toMatch(/300px/);
  });

  it("a session the viewer is not in: the strip, no pane, the chat at full width", () => {
    applyChannelApp(CHANNEL, summary(false));
    render();
    expect(strip()?.getAttribute("data-state")).toBe("outside");
    expect(document.querySelector('[data-testid="pane"]')).toBeNull();
    expect(column().className).not.toMatch(/300px/);
  });

  it("seated: the pane takes the conversation's place and the chat moves to 300 px", () => {
    applyChannelApp(CHANNEL, summary(true));
    render();
    expect(document.querySelector('[data-testid="pane"]')).not.toBeNull();
    expect(column().className).toMatch(/w-\[300px\]/);
    expect(strip()?.getAttribute("data-state")).toBe("participant");
  });

  it("the chat stays mounted when the pane comes and goes", () => {
    render();
    const chat = document.querySelector('[data-testid="chat"]')!;
    act(() => applyChannelApp(CHANNEL, summary(true)));
    expect(document.querySelector('[data-testid="chat"]')).toBe(chat);
    act(() => applyChannelApp(CHANNEL, summary(false)));
    expect(document.querySelector('[data-testid="chat"]')).toBe(chat);
  });

  it("the link down freezes the pane and the strip says the seat is kept", () => {
    applyChannelApp(CHANNEL, summary(true));
    render();
    act(() => setAppsOnline(false));
    expect(document.querySelector('[data-testid="pane"]')?.getAttribute("data-frozen")).toBe("yes");
    expect(strip()?.getAttribute("data-state")).toBe("reconnecting");
    act(() => setAppsOnline(true));
    expect(document.querySelector('[data-testid="pane"]')?.getAttribute("data-frozen")).toBe("no");
  });

  it("the end: the pane goes, the ended strip stays 8 s, then collapses on its own", () => {
    applyChannelApp(CHANNEL, summary(true));
    render();
    act(() =>
      applyAppEnded({
        sessionId: SESSION,
        channelId: CHANNEL,
        reason: "host",
        summary: { participants: 2, durationSeconds: 120 },
      }),
    );
    expect(document.querySelector('[data-testid="pane"]')).toBeNull();
    expect(strip()?.getAttribute("data-state")).toBe("ended");
    expect(strip()?.className).not.toMatch(/app-strip-out/);
    act(() => {
      vi.advanceTimersByTime(ENDED_STRIP_MS + 50);
    });
    expect(strip()?.className).toMatch(/app-strip-out/);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(strip()).toBeNull();
  });

  it("Fechar closes the ended strip at once", () => {
    applyChannelApp(CHANNEL, summary(true));
    render();
    act(() =>
      applyAppEnded({
        sessionId: SESSION,
        channelId: CHANNEL,
        reason: "operator",
        summary: { participants: 2, durationSeconds: 120 },
      }),
    );
    const close = strip()!.querySelector("button:last-of-type") as HTMLButtonElement;
    act(() => close.click());
    expect(strip()).toBeNull();
  });

  it("another channel's session is none of this channel's business", () => {
    applyChannelApp("33333333-3333-4333-8333-333333333333", summary(true));
    render();
    expect(strip()).toBeNull();
  });
});
