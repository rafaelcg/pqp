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
import { toggleAppChat } from "./app-column";
import { TooltipProvider } from "@/components/ui/tooltip";

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

type Msg = { id: string; authorId: string; body: string; createdAt?: string };

function tree(props: {
  channelId?: string | null;
  messages?: Msg[];
  inCall?: boolean;
  callShape?: "none" | "compact" | "expanded";
}) {
  return (
    <TooltipProvider>
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
      voice={{ ...voice, inCall: props.inCall ?? false, callShape: props.callShape }}
      chat={{ messages: props.messages ?? [], username: "rafa" }}
      chatShortcut="Ctrl + Shift + ."
    >
      <div data-testid="chat">
        <div data-call-split-chat="">
          <textarea aria-label="composer" />
        </div>
      </div>
    </AppSessionLayout>
    </TooltipProvider>
  );
}

function render(
  props: {
    enabled?: boolean;
    channelId?: string | null;
    messages?: Msg[];
    inCall?: boolean;
    callShape?: "none" | "compact" | "expanded";
  } = {},
) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(tree(props)));
}

function rerender(props: Parameters<typeof tree>[0]) {
  act(() => root!.render(tree(props)));
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

  it("seated: the pane takes the conversation's place and the chat moves to the side column", () => {
    applyChannelApp(CHANNEL, summary(true));
    render();
    expect(document.querySelector('[data-testid="pane"]')).not.toBeNull();
    expect(column().className).toMatch(/w-\[320px\]/);
    expect(column().getAttribute("data-app-column")).toBe("side");
    expect(strip()?.getAttribute("data-state")).toBe("participant");
  });

  it("with app_pane_layout_v2 off it is the old 300 px column and no chat toggle", () => {
    config.state = { ...config.state, paneLayoutV2: false } as typeof config.state;
    applyChannelApp(CHANNEL, summary(true));
    render();
    expect(column().className).toMatch(/w-\[300px\]/);
    expect(column().hasAttribute("data-app-column")).toBe(false);
    expect(document.querySelector("[data-app-chat-toggle]")).toBeNull();
  });

  describe("hiding the chat", () => {
    const toggle = () => document.querySelector<HTMLButtonElement>("[data-app-chat-toggle]")!;

    beforeEach(() => {
      window.localStorage.clear();
    });

    it("is offered only while the app is on screen", () => {
      applyChannelApp(CHANNEL, summary(false));
      render();
      expect(document.querySelector("[data-app-chat-toggle]")).toBeNull();
    });

    it("with no call takes the whole column away (not focusable), keeps it mounted, and remembers", () => {
      applyChannelApp(CHANNEL, summary(true));
      render();
      const chat = document.querySelector('[data-testid="chat"]')!;
      expect(toggle().getAttribute("aria-expanded")).toBe("true");
      expect(toggle().getAttribute("aria-controls")).toBe(column().id);
      act(() => toggle().click());
      expect(column().hasAttribute("hidden")).toBe(true);
      expect(column().getAttribute("data-app-column")).toBe("hidden");
      expect(toggle().getAttribute("aria-expanded")).toBe("false");
      expect(document.querySelector('[data-testid="chat"]')).toBe(chat);
      expect(window.localStorage.getItem("pqp:apps:chat-hidden")).toBe("1");
      act(() => toggle().click());
      expect(column().hasAttribute("hidden")).toBe(false);
      expect(window.localStorage.getItem("pqp:apps:chat-hidden")).toBe("0");
    });

    it("in a call keeps the call: a card goes under the app, pictures keep the side", () => {
      applyChannelApp(CHANNEL, summary(true));
      render({ inCall: true, callShape: "compact" });
      act(() => toggle().click());
      expect(column().hasAttribute("hidden")).toBe(false);
      expect(column().getAttribute("data-app-column")).toBe("bar");
      rerender({ inCall: true, callShape: "expanded" });
      expect(column().getAttribute("data-app-column")).toBe("stage");
    });

    it("moves focus out of the chat to the toggle, and the shortcut brings it back to the composer", () => {
      applyChannelApp(CHANNEL, summary(true));
      render();
      const composer = document.querySelector<HTMLTextAreaElement>("textarea")!;
      composer.focus();
      act(() => {
        toggleAppChat();
      });
      act(() => {
        vi.advanceTimersByTime(50);
      });
      expect(document.activeElement).toBe(toggle());
      act(() => {
        toggleAppChat();
      });
      act(() => {
        vi.advanceTimersByTime(50);
      });
      expect(column().hasAttribute("hidden")).toBe(false);
      expect(document.activeElement).toBe(composer);
    });

    it("marks what arrived while it was away: a dot, a count when named", () => {
      applyChannelApp(CHANNEL, summary(true));
      const first = [{ id: "m1", authorId: BIA, body: "oi" }];
      render({ messages: first });
      act(() => toggle().click());
      expect(document.querySelector("[data-app-chat-unread]")).toBeNull();
      rerender({ messages: [...first, { id: "m2", authorId: BIA, body: "bora" }] });
      expect(document.querySelector("[data-app-chat-unread]")?.getAttribute("data-app-chat-unread")).toBe("dot");
      expect(toggle().getAttribute("aria-label")).toMatch(/1/);
      rerender({
        messages: [
          ...first,
          { id: "m2", authorId: BIA, body: "bora" },
          { id: "m3", authorId: BIA, body: "@rafa vem" },
        ],
      });
      const badge = document.querySelector("[data-app-chat-unread]")!;
      expect(badge.getAttribute("data-app-chat-unread")).toBe("mention");
      expect(badge.textContent).toBe("2");
      act(() => toggle().click());
      expect(document.querySelector("[data-app-chat-unread]")).toBeNull();
    });

    it("moving to another channel's app with the chat away takes that channel's newest message as the mark", () => {
      const OTHER = "33333333-3333-4333-8333-333333333333";
      applyChannelApp(CHANNEL, summary(true));
      applyChannelApp(OTHER, { ...summary(true), id: "44444444-4444-4444-8444-444444444444" });
      render({ messages: [{ id: "a1", authorId: BIA, body: "oi" }] });
      act(() => toggle().click());
      const there = [{ id: "b1", authorId: BIA, body: "oi" }];
      rerender({ channelId: OTHER, messages: there });
      expect(document.querySelector("[data-app-chat-unread]")).toBeNull();
      rerender({ channelId: OTHER, messages: [...there, { id: "b2", authorId: BIA, body: "bora" }] });
      expect(document.querySelector("[data-app-chat-unread]")?.getAttribute("data-app-chat-unread")).toBe("dot");
    });

    it("a channel whose history loads after the switch does not read its history as unread", () => {
      const OTHER = "33333333-3333-4333-8333-333333333333";
      applyChannelApp(CHANNEL, summary(true));
      applyChannelApp(OTHER, { ...summary(true), id: "44444444-4444-4444-8444-444444444444" });
      render({ messages: [{ id: "a1", authorId: BIA, body: "oi" }] });
      act(() => toggle().click());
      rerender({ channelId: OTHER, messages: [] });
      const old = new Date(Date.now() - 60_000).toISOString();
      rerender({
        channelId: OTHER,
        messages: [{ id: "b1", authorId: BIA, body: "@rafa antigo", createdAt: old } as Msg],
      });
      expect(document.querySelector("[data-app-chat-unread]")).toBeNull();
    });

    it("the shortcut does nothing without an app on screen", () => {
      render();
      expect(toggleAppChat()).toBe(false);
    });
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
